import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validateExternalAdapterResponseContract } from "@runxhq/contracts";
import { describe, expect, it } from "vitest";

import {
  defineExternalAdapter,
  defineTool,
  failure,
  firstNonEmptyString,
  materializeExternalAdapterInputs,
  prune,
} from "./index.js";

const externalAdapterConformanceRoot = path.join(process.cwd(), "fixtures", "external-adapter-conformance");
const externalAdapterInvocationPath = path.join(externalAdapterConformanceRoot, "invocation.json");
const tsxBin = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

describe("@runxhq/extension-sdk", () => {
  it("transports runtime-materialized tool inputs without reinterpreting them", async () => {
    const tool = defineTool({
      name: "demo.echo",
      run({ inputs }) {
        return { message: inputs.message };
      },
    });

    await expect(tool.runWith({ message: "hello" })).resolves.toEqual({ message: "hello" });
  });

  it("preserves structured failures", async () => {
    const tool = defineTool({
      name: "demo.fail",
      run() {
        return failure({ error: { code: "invalid_input" } }, { exitCode: 2, stderr: "bad input" });
      },
    });

    await expect(tool.runWith()).resolves.toMatchObject({
      output: { error: { code: "invalid_input" } },
      exitCode: 2,
      stderr: "bad input",
    });
  });

  it("preserves intentional empty collections in tool output contracts", async () => {
    const tool = defineTool({
      name: "demo.empty-output",
      run() {
        return { writes: [], metadata: {}, omitted: undefined };
      },
    });

    await expect(tool.runWith()).resolves.toEqual({ writes: [], metadata: {} });
  });

  it("loads the runtime-authored input file for a process tool", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-tool-input-"));
    const inputPath = path.join(tempDir, "inputs.json");
    const toolPath = path.join(tempDir, "tool.mts");
    try {
      await writeFile(inputPath, JSON.stringify({ message: "from-file" }), "utf8");
      await writeFile(toolPath, [
        `import { defineTool } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};`,
        'const tool = defineTool({ name: "demo.process", run: ({ inputs }) => inputs });',
        "await tool.main();",
      ].join("\n"), "utf8");
      const stdout = await runProcess(tsxBin, [toolPath], "", {
        RUNX_INPUTS_JSON: JSON.stringify({ message: "stale-inline" }),
        RUNX_INPUTS_PATH: inputPath,
      });
      expect(JSON.parse(stdout)).toEqual({ message: "from-file" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("exports shared value helpers for process extensions", () => {
    expect(firstNonEmptyString("", undefined, " docs ")).toBe("docs");
    expect(prune({ keep: "yes", drop: undefined, empty: [], nested: { value: undefined } })).toEqual({ keep: "yes" });
  });

  it("runs a TypeScript external adapter against the conformance invocation fixture", async () => {
    const invocation = JSON.parse(await readFile(externalAdapterInvocationPath, "utf8"));
    const adapter = defineExternalAdapter({
      adapterId: "adapter.conformance.echo",
      invoke({ invocation }) {
        return {
          stdout: JSON.stringify({ message: invocation.inputs.message }),
          stderr: "",
          exitCode: 0,
          output: {
            adapter_language: "typescript",
            message: invocation.inputs.message,
            count: invocation.inputs.count,
          },
          observedAt: "2026-05-21T15:00:00.000Z",
        };
      },
    });

    const response = await adapter.runWith(invocation);

    expect(validateExternalAdapterResponseContract(response)).toMatchObject({
      schema: "runx.external_adapter.response.v1",
      protocol_version: "runx.external_adapter.v1",
      invocation_id: invocation.invocation_id,
      adapter_id: invocation.adapter_id,
      status: "completed",
      output: {
        adapter_language: "typescript",
        message: "hello from fixture",
        count: 2,
      },
    });
  });

  it("materializes resolved adapter inputs with explicit context precedence", () => {
    expect(materializeExternalAdapterInputs({
      inputs: { message: "static", count: 1 },
      resolved_inputs: { message: "resolved" },
    })).toEqual({ message: "resolved", count: 1 });
  });

  it("runs sample adapters over the process stdin/stdout wire protocol", async () => {
    const invocationJson = await readFile(externalAdapterInvocationPath, "utf8");
    const adapters = [
      {
        language: "typescript",
        command: tsxBin,
        args: [path.join(externalAdapterConformanceRoot, "typescript_echo_adapter.ts")],
      },
      {
        language: "python",
        command: "python3",
        args: [path.join(externalAdapterConformanceRoot, "python_echo_adapter.py")],
      },
    ] as const;

    for (const adapter of adapters) {
      const stdout = await runExternalAdapterProcess(adapter.command, adapter.args, invocationJson);
      const response = validateExternalAdapterResponseContract(JSON.parse(stdout));

      expect(response).toMatchObject({
        schema: "runx.external_adapter.response.v1",
        protocol_version: "runx.external_adapter.v1",
        invocation_id: "external_inv_conformance_001",
        adapter_id: "adapter.conformance.echo",
        status: "completed",
        output: {
          adapter_language: adapter.language,
          message: "hello from fixture",
          count: 2,
        },
      });
    }
  });

  it("returns a failed protocol frame without turning it into a process failure", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-external-adapter-failure-"));
    const adapterPath = path.join(tempDir, "adapter.mts");
    try {
      await writeFile(adapterPath, [
        `import { defineExternalAdapter } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};`,
        'const adapter = defineExternalAdapter({',
        '  adapterId: "adapter.conformance.echo",',
        '  invoke() { throw new Error("expected adapter failure"); },',
        '});',
        'await adapter.main();',
      ].join("\n"), "utf8");
      const invocationJson = await readFile(externalAdapterInvocationPath, "utf8");
      const stdout = await runExternalAdapterProcess(tsxBin, [adapterPath], invocationJson);
      expect(validateExternalAdapterResponseContract(JSON.parse(stdout))).toMatchObject({
        status: "failed",
        exit_code: 1,
        stderr: "expected adapter failure",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a prebuilt adapter response changes invocation identity", async () => {
    const invocation = JSON.parse(await readFile(externalAdapterInvocationPath, "utf8"));
    const adapter = defineExternalAdapter({
      adapterId: "adapter.conformance.echo",
      invoke() {
        return {
          schema: "runx.external_adapter.response.v1" as const,
          protocol_version: "runx.external_adapter.v1" as const,
          invocation_id: "external_inv_other",
          adapter_id: "adapter.conformance.echo",
          status: "completed" as const,
          observed_at: "2026-05-21T15:00:00.000Z",
        };
      },
    });

    await expect(adapter.runWith(invocation)).resolves.toMatchObject({
      schema: "runx.external_adapter.response.v1",
      protocol_version: "runx.external_adapter.v1",
      invocation_id: invocation.invocation_id,
      adapter_id: invocation.adapter_id,
      status: "failed",
      exit_code: 1,
      errors: [{
        code: "adapter_error",
        retryable: false,
      }],
    });
  });

  it("keeps external adapter extension helpers protocol-only", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const forbiddenPackages = ["runtime-local", "adapters"].map((name) => `@runxhq/${name}`);

    for (const packageName of forbiddenPackages) {
      expect(source).not.toContain(packageName);
    }
  });
});

async function runExternalAdapterProcess(
  command: string,
  args: readonly string[],
  invocationJson: string,
): Promise<string> {
  return runProcess(command, args, invocationJson);
}

async function runProcess(
  command: string,
  args: readonly string[],
  stdin: string,
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  const child = spawn(command, [...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const closed = new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} exited ${code ?? "without status"}: ${stderr}`));
    });
  });
  child.stdin.end(stdin && !stdin.endsWith("\n") ? `${stdin}\n` : stdin);
  return closed;
}

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createDefaultSkillAdapters } from "@runxhq/adapters";
import { runLocalSkill } from "@runxhq/runtime-local";

import { createAgentRuntimeLoader, createNonInteractiveCaller } from "../packages/cli/src/callers.js";

describe("caller-mediated agent runtime execution location", () => {
  it("resolves custom tools from the carried skill directory instead of ambient RUNX_CWD", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-agent-runtime-location-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const unrelatedDir = path.join(tempDir, "unrelated");
    const skillDir = path.join(workspaceDir, "skills", "demo");
    const toolDir = path.join(workspaceDir, ".runx", "tools", "demo", "echo_file");
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");
    const originalFetch = globalThis.fetch;

    try {
      await mkdir(skillDir, { recursive: true });
      await mkdir(toolDir, { recursive: true });
      await mkdir(unrelatedDir, { recursive: true });

      await writeFile(path.join(skillDir, "note.txt"), "hello from carried tool root\n", "utf8");
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: local-tool-summary
description: Resolve a custom local tool through the caller runtime.
source:
  type: agent-step
  agent: codex
  task: local-summary
  outputs:
    verdict: string
inputs:
  path:
    type: string
    required: true
runx:
  allowed_tools:
    - demo.echo_file
---
Use the local tool and return a grounded verdict.
`,
        "utf8",
      );

      await writeFile(
        path.join(toolDir, "manifest.json"),
        `${JSON.stringify({
          schema: "runx.tool.manifest.v1",
          name: "demo.echo_file",
          description: "Read a file relative to the invoking skill directory.",
          source: {
            type: "cli-tool",
            command: "node",
            args: ["./run.mjs"],
          },
          inputs: {
            path: {
              type: "string",
              required: true,
              description: "File to read relative to the skill directory.",
            },
          },
          output: {
            packet: "demo.echo_file.v1",
            wrap_as: "echo_file",
          },
          scopes: ["demo.read"],
          runtime: {
            command: "node",
            args: ["./run.mjs"],
          },
          source_hash: "sha256:test",
          schema_hash: "sha256:test",
          toolkit_version: "0.1.1",
        }, null, 2)}\n`,
        "utf8",
      );

      await writeFile(
        path.join(toolDir, "run.mjs"),
        `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const targetPath = path.resolve(process.env.RUNX_INPUT_PATH || inputs.path || "");
const contents = fs.readFileSync(targetPath, "utf8");
process.stdout.write(JSON.stringify({
  schema: "demo.echo_file.v1",
  data: {
    path: targetPath,
    contents,
  },
}));
`,
        { mode: 0o755 },
      );

      let requestCount = 0;
      globalThis.fetch = vi.fn(async (_input, init) => {
        requestCount += 1;
        const body = JSON.parse(String(init?.body)) as {
          tools: Array<{ name: string }>;
          input: Array<Record<string, unknown>>;
        };

        if (requestCount === 1) {
          expect(body.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["demo_echo_file", "submit_result"]));
          return new Response(JSON.stringify({
            output: [
              {
                type: "function_call",
                call_id: "call_tool",
                name: "demo_echo_file",
                arguments: JSON.stringify({
                  path: path.join(skillDir, "note.txt"),
                }),
              },
            ],
          }), { status: 200 });
        }

        const toolOutput = body.input.find((item) => item.type === "function_call_output") as
          | { output?: string }
          | undefined;
        expect(toolOutput?.output).toContain("hello from carried tool root");
        return new Response(JSON.stringify({
          output: [
            {
              type: "function_call",
              call_id: "call_submit",
              name: "submit_result",
              arguments: JSON.stringify({ verdict: "grounded" }),
            },
          ],
        }), { status: 200 });
      }) as typeof fetch;

      const env = {
        ...process.env,
        RUNX_CWD: unrelatedDir,
        RUNX_HOME: runxHome,
        RUNX_AGENT_PROVIDER: "openai",
        RUNX_AGENT_MODEL: "gpt-test",
        RUNX_AGENT_API_KEY: "sk-test-secret",
      };

      const result = await runLocalSkill({
        skillPath: skillDir,
        inputs: {
          path: "note.txt",
        },
        caller: createNonInteractiveCaller({}, undefined, createAgentRuntimeLoader(env)),
        env,
        receiptDir,
        runxHome,
        adapters: createDefaultSkillAdapters(),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(JSON.parse(result.execution.stdout)).toEqual({ verdict: "grounded" });
      expect(result.receipt.metadata?.agent_hook).toMatchObject({
        route: "provided",
      });
      expect(requestCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

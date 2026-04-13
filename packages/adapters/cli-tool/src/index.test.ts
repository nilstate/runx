import { describe, expect, it } from "vitest";

import { invokeCliTool } from "./index.js";

const outputLimitBytes = 1024 * 1024;

describe("invokeCliTool", () => {
  it("executes a command with input env injection", async () => {
    const result = await invokeCliTool({
      source: {
        command: "node",
        args: ["-e", "process.stdout.write(process.env.RUNX_INPUT_MESSAGE ?? '')"],
        timeoutSeconds: 5,
      },
      inputs: { message: "hi" },
      skillDirectory: process.cwd(),
    });

    expect(result.status).toBe("success");
    expect(result.stdout).toBe("hi");
  });

  it("interpolates input args", async () => {
    const result = await invokeCliTool({
      source: {
        command: "node",
        args: ["-e", "process.stdout.write(process.argv[1] ?? '')", "{{message}}"],
        timeoutSeconds: 5,
      },
      inputs: { message: "hello" },
      skillDirectory: process.cwd(),
    });

    expect(result.status).toBe("success");
    expect(result.stdout).toBe("hello");
  });

  it("force-kills a process that ignores timeout SIGTERM", async () => {
    const result = await invokeCliTool({
      source: {
        command: "node",
        args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        timeoutSeconds: 0.05,
      },
      inputs: {},
      skillDirectory: process.cwd(),
    });

    expect(result.status).toBe("failure");
    expect(result.errorMessage).toContain("timed out");
    expect(result.durationMs).toBeLessThan(1500);
  });

  it("kills a running child when the AbortSignal fires", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await invokeCliTool({
      source: {
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutSeconds: 5,
      },
      inputs: {},
      skillDirectory: process.cwd(),
      signal: controller.signal,
    });

    expect(result.status).toBe("failure");
    expect(result.errorMessage).toBe("cli-tool aborted");
    expect(result.durationMs).toBeLessThan(1500);
  });

  it("truncates stdout by byte count without emitting broken UTF-8", async () => {
    const result = await invokeCliTool({
      source: {
        command: "node",
        args: [
          "-e",
          "process.stdout.write('a'.repeat(Number(process.argv[1])) + '€')",
          String(outputLimitBytes - 1),
        ],
        timeoutSeconds: 5,
      },
      inputs: {},
      skillDirectory: process.cwd(),
    });

    expect(result.status).toBe("success");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(outputLimitBytes);
    expect(result.stdout).not.toContain("\uFFFD");
    expect(result.stdout.endsWith("€")).toBe(false);
    expect(result.stdout).toBe("a".repeat(outputLimitBytes - 1));
  });

  it("applies declared env allowlist and reports sandbox metadata", async () => {
    const result = await invokeCliTool({
      source: {
        command: "node",
        args: [
          "-e",
          "process.stdout.write(`${process.env.ALLOWED_VALUE ?? ''}:${process.env.BLOCKED_VALUE ?? ''}:${process.env.RUNX_INPUT_MESSAGE ?? ''}`)",
        ],
        timeoutSeconds: 5,
        sandbox: {
          profile: "workspace-write",
          envAllowlist: ["ALLOWED_VALUE"],
          writablePaths: ["{{output_path}}"],
        },
      },
      inputs: { message: "hi" },
      env: {
        ALLOWED_VALUE: "yes",
        BLOCKED_VALUE: "no",
      },
      skillDirectory: process.cwd(),
    });

    expect(result.status).toBe("success");
    expect(result.stdout).toBe("yes::hi");
    expect(result.metadata?.sandbox).toMatchObject({
      profile: "workspace-write",
      env: {
        mode: "allowlist",
        allowlist: ["ALLOWED_VALUE"],
      },
      writable_paths: ["{{output_path}}"],
      filesystem: {
        enforcement: "declared-policy-only",
      },
    });
  });

  it("does not claim unrestricted approval when invoked without runner approval metadata", async () => {
    const result = await invokeCliTool({
      source: {
        command: "node",
        args: ["-e", "process.stdout.write('direct')"],
        timeoutSeconds: 5,
        sandbox: {
          profile: "unrestricted-local-dev",
        },
      },
      inputs: {},
      skillDirectory: process.cwd(),
    });

    expect(result.status).toBe("success");
    expect(result.metadata?.sandbox).toMatchObject({
      profile: "unrestricted-local-dev",
      approval: {
        required: true,
        approved: false,
      },
    });
  });
});

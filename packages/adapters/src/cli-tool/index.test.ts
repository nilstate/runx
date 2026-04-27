import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

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
      inputs: { message: "hi", output_path: "out.txt" },
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

  it("applies declared env allowlist and reports sandbox profile metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-tool-env-"));
    try {
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
            envAllowlist: ["ALLOWED_VALUE", "PATH"],
            writablePaths: ["{{output_path}}"],
          },
        },
        inputs: { message: "hi", output_path: "out.txt" },
        env: {
          ALLOWED_VALUE: "yes",
          BLOCKED_VALUE: "no",
          PATH: process.env.PATH,
          RUNX_CWD: tempDir,
        },
        skillDirectory: tempDir,
      });

      expect(result.status).toBe("success");
      expect(result.stdout).toBe("yes::hi");
      expect(result.metadata?.sandbox).toMatchObject({
        profile: "workspace-write",
        env: {
          mode: "allowlist",
          allowlist: ["ALLOWED_VALUE", "PATH"],
        },
        writable_paths: ["out.txt"],
      });
      expect(["bubblewrap-mount-namespace", "not-enforced-local"]).toContain(sandboxFilesystemEnforcement(result.metadata?.sandbox));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports whether readonly filesystem writes are enforced by the local runtime", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-tool-readonly-"));
    const outputPath = path.join(tempDir, "out.txt");
    try {
      const result = await invokeCliTool({
        source: {
          command: "node",
          args: ["-e", "require('node:fs').writeFileSync('out.txt', 'should-not-write')"],
          timeoutSeconds: 5,
          sandbox: {
            profile: "readonly",
          },
        },
        inputs: {},
        skillDirectory: tempDir,
        env: {
          PATH: process.env.PATH,
          RUNX_CWD: tempDir,
        },
      });

      expect(result.metadata?.sandbox).toMatchObject({
        profile: "readonly",
        filesystem: {
          readonly_paths: true,
        },
      });
      if (sandboxFilesystemEnforcement(result.metadata?.sandbox) === "bubblewrap-mount-namespace") {
        expect(result.status).toBe("failure");
        await expect(readFile(outputPath, "utf8")).rejects.toThrow();
      } else {
        expect(result.status).toBe("success");
        await expect(readFile(outputPath, "utf8")).resolves.toBe("should-not-write");
        expect(result.metadata?.sandbox).toMatchObject({
          runtime: {
            enforcer: "declared-policy-only",
          },
        });
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses a default env allowlist instead of inheriting ambient secrets", async () => {
    const result = await invokeCliTool({
      source: {
        command: "node",
        args: [
          "-e",
          "process.stdout.write(`${process.env.RUNX_SECRET_VALUE ?? ''}:${Boolean(process.env.PATH)}:${process.env.RUNX_INPUT_MESSAGE ?? ''}`)",
        ],
        timeoutSeconds: 5,
      },
      inputs: { message: "hi" },
      env: {
        PATH: process.env.PATH,
        RUNX_SECRET_VALUE: "secret",
      },
      skillDirectory: process.cwd(),
    });

    expect(result.status).toBe("success");
    expect(result.stdout).toBe(":true:hi");
    expect(result.metadata?.sandbox).toMatchObject({
      profile: "readonly",
      env: {
        mode: "default-allowlist",
      },
    });
  });

  it("denies non-unrestricted cwd escapes before spawning", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-tool-cwd-"));
    try {
      const skillDirectory = path.join(tempDir, "skill");
      const outside = path.join(tempDir, "outside");
      const result = await invokeCliTool({
        source: {
          command: "node",
          args: ["-e", "process.stdout.write('should-not-run')"],
          cwd: outside,
          timeoutSeconds: 5,
          sandbox: {
            profile: "readonly",
            cwdPolicy: "skill-directory",
          },
        },
        inputs: {},
        skillDirectory,
      });

      expect(result.status).toBe("failure");
      expect(result.errorMessage).toContain("outside skill directory");
      expect(result.stdout).toBe("");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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

  it("spills oversized JSON inputs to RUNX_INPUTS_PATH instead of overflowing env vars", async () => {
    const largePayload = "x".repeat(80 * 1024);

    const result = await invokeCliTool({
      source: {
        command: "node",
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const filePath = process.env.RUNX_INPUTS_PATH || '';",
            "const raw = filePath ? fs.readFileSync(filePath, 'utf8') : process.env.RUNX_INPUTS_JSON || '';",
            "const parsed = JSON.parse(raw);",
            "process.stdout.write(`${Boolean(process.env.RUNX_INPUTS_PATH)}:${parsed.message.length}:${process.env.RUNX_INPUT_MESSAGE ?? ''}`);",
          ].join(" "),
        ],
        timeoutSeconds: 5,
      },
      inputs: { message: largePayload },
      skillDirectory: process.cwd(),
    });

    expect(result.status).toBe("success");
    expect(result.stdout).toBe(`true:${largePayload.length}:`);
  });

  it("isolates host network when network is not declared", async () => {
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.end("host-network");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await invokeCliTool({
        source: {
          command: "node",
          args: [
            "-e",
            [
              "const net = require('node:net');",
              "const socket = net.connect({ host: '127.0.0.1', port: Number(process.env.RUNX_INPUT_PORT) }, () => {",
              "  process.stdout.write('connected');",
              "  socket.destroy();",
              "  process.exit(0);",
              "});",
              "socket.on('error', () => { process.stdout.write('blocked'); process.exit(0); });",
              "setTimeout(() => { process.stdout.write('blocked-timeout'); socket.destroy(); process.exit(0); }, 500);",
            ].join(" "),
          ],
          timeoutSeconds: 5,
          sandbox: {
            profile: "readonly",
          },
        },
        inputs: { port },
        skillDirectory: process.cwd(),
        env: {
          PATH: process.env.PATH,
          RUNX_CWD: process.cwd(),
        },
      });

      expect(result.status).toBe("success");
      const networkEnforcement = sandboxNetworkEnforcement(result.metadata?.sandbox);
      if (networkEnforcement === "isolated-namespace") {
        expect(result.stdout).not.toBe("connected");
      } else {
        expect(result.stdout).toBe("connected");
      }
      expect(result.metadata?.sandbox).toMatchObject({
        network: {
          declared: false,
        },
      });
      expect(["isolated-namespace", "not-enforced-local"]).toContain(networkEnforcement);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("allows out-of-workspace PATH commands only for unrestricted local development", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-cli-tool-path-"));
    const scriptPath = path.join(tempDir, "ambient-command");
    try {
      await writeFile(scriptPath, "#!/usr/bin/env bash\nprintf 'ambient-ok'\n", "utf8");
      await chmod(scriptPath, 0o755);

      const readonlyResult = await invokeCliTool({
        source: {
          command: "ambient-command",
          timeoutSeconds: 5,
          sandbox: {
            profile: "readonly",
          },
        },
        inputs: {},
        skillDirectory: process.cwd(),
        env: {
          PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        },
      });
      expect(readonlyResult.metadata?.sandbox).toMatchObject({
        profile: "readonly",
      });
      if (sandboxRuntimeEnforcer(readonlyResult.metadata?.sandbox) === "bubblewrap") {
        expect(readonlyResult.status).toBe("failure");
        expect(readonlyResult.stdout).toBe("");
      } else {
        expect(readonlyResult.status).toBe("success");
        expect(readonlyResult.stdout).toBe("ambient-ok");
        expect(readonlyResult.metadata?.sandbox).toMatchObject({
          runtime: {
            enforcer: "declared-policy-only",
          },
        });
      }

      const result = await invokeCliTool({
        source: {
          command: "ambient-command",
          timeoutSeconds: 5,
          sandbox: {
            profile: "unrestricted-local-dev",
            approvedEscalation: true,
          },
        },
        inputs: {},
        skillDirectory: process.cwd(),
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe("success");
      expect(result.stdout).toBe("ambient-ok");
      expect(result.metadata?.sandbox).toMatchObject({
        profile: "unrestricted-local-dev",
        runtime: {
          enforcer: "direct",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function sandboxFilesystemEnforcement(sandbox: unknown): string | undefined {
  return readNestedString(sandbox, ["filesystem", "enforcement"]);
}

function sandboxNetworkEnforcement(sandbox: unknown): string | undefined {
  return readNestedString(sandbox, ["network", "enforcement"]);
}

function sandboxRuntimeEnforcer(sandbox: unknown): string | undefined {
  return readNestedString(sandbox, ["runtime", "enforcer"]);
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  let cursor = value;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null || !(key in cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

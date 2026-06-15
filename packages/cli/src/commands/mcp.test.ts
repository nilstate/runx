import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { handleMcpServeCommand } from "./mcp.js";
import { resolveRunxBinary } from "../../../../tests/runx-binary.js";

const workspaceRoot = process.cwd();
const runxBinary = resolveRunxBinary();

describe("runx mcp serve", () => {
  it("lists served skills and executes through the local kernel", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-mcp-serve-"));
    const skillDir = path.join(tempDir, "echo");
    await writeEchoSkill(skillDir);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    try {
      const responsesPromise = collectRpcResponses(stdout, 3);
      const serverPromise = startServer(tempDir, skillDir, stdin, stdout, stderr);

      writeRpcMessage(stdin, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "runx-mcp-test",
            version: "0.0.0",
          },
        },
      });
      // Per the MCP handshake the client must acknowledge initialization before
      // issuing further requests; rmcp rejects tool calls until it arrives.
      writeRpcMessage(stdin, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      writeRpcMessage(stdin, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      writeRpcMessage(stdin, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: {
            message: "hello from mcp",
          },
        },
      });
      stdin.end();

      const responses = await responsesPromise;
      expect(responses[1]).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: {
            name: "runx-cli",
          },
        },
      });
      expect(responses[2]).toMatchObject({
        jsonrpc: "2.0",
        id: 2,
      });
      const listedTools = (responses[2].result as { tools: Array<Record<string, unknown>> }).tools;
      expect(listedTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "echo",
            inputSchema: expect.objectContaining({
              type: "object",
              required: ["message"],
            }),
          }),
        ]),
      );
      if (!("result" in responses[3])) {
        throw new Error(JSON.stringify(responses[3]));
      }
      expect(responses[3]).toMatchObject({
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [
            {
              type: "text",
              text: "hello from mcp",
            },
          ],
          structuredContent: {
            runx: {
              status: "completed",
              skillName: "echo",
            },
          },
        },
      });
      await serverPromise;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

});

function startServer(
  tempDir: string,
  skillDir: string,
  stdin: PassThrough,
  stdout: PassThrough,
  stderr: PassThrough,
): Promise<void> {
  return handleMcpServeCommand(
    {
      mcpRefs: [skillDir],
    },
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    },
    {
      ...process.env,
      RUNX_CWD: process.cwd(),
      RUNX_KERNEL_EVAL_BIN: runxBinary,
      RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64: process.env.RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64 ?? "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=",
      RUNX_RECEIPT_SIGN_ISSUER_TYPE: process.env.RUNX_RECEIPT_SIGN_ISSUER_TYPE ?? "hosted",
      RUNX_RECEIPT_SIGN_KID: process.env.RUNX_RECEIPT_SIGN_KID ?? "cli-mcp-test-key",
      RUNX_RUST_CLI_BIN: runxBinary,
    },
    {
      resolveRegistryStoreForGraphs: async () => undefined,
      resolveDefaultReceiptDir: () => path.join(tempDir, "receipts"),
    },
  );
}

async function writeEchoSkill(skillDir: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "run.sh"),
    `#!/bin/sh
printf '%s' "\${RUNX_INPUT_MESSAGE:-}"
`,
  );
  await writeFile(
    path.join(skillDir, "X.yaml"),
    `skill: echo
runners:
  default:
    default: true
    type: cli-tool
    command: sh
    args:
      - ./run.sh
    inputs:
      message:
        type: string
        required: true
        description: Message to echo.
`,
  );
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: echo
description: Echo a message through the cli-tool adapter.
source:
  type: cli-tool
  command: sh
  args:
    - ./run.sh
inputs:
  message:
    type: string
    required: true
    description: Message to echo.
---

Echo the provided message.
`,
  );
}

function writeRpcMessage(stream: PassThrough, message: unknown): void {
  const body = JSON.stringify(message);
  stream.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

async function collectRpcResponses(
  stream: PassThrough,
  expectedCount: number,
): Promise<Record<number, Record<string, unknown>>> {
  let input = Buffer.alloc(0);
  const responses = new Map<number, Record<string, unknown>>();

  return await new Promise<Record<number, Record<string, unknown>>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expectedCount} MCP response(s).`));
    }, 10_000);

    const onData = (chunk: Buffer | string): void => {
      input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      parseAvailableMessages();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("error", onError);
    };

    stream.on("data", onData);
    stream.on("error", onError);

    function parseAvailableMessages(): void {
      while (true) {
        const headerEnd = input.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const header = input.subarray(0, headerEnd).toString("utf8");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          return;
        }
        const contentLength = Number(match[1]);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;
        if (input.length < bodyEnd) {
          return;
        }
        const body = input.subarray(bodyStart, bodyEnd).toString("utf8");
        input = input.subarray(bodyEnd);
        const message = JSON.parse(body) as Record<string, unknown>;
        const id = Number(message.id);
        if (!Number.isFinite(id)) {
          continue;
        }
        responses.set(id, message);
        if (responses.size >= expectedCount) {
          cleanup();
          resolve(Object.fromEntries(responses));
        }
      }
    }
  });
}

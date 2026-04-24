import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { handleMcpServeCommand } from "./mcp.js";

describe("runx mcp serve", () => {
  it("lists served skills, built-in resume, and executes through the local kernel", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-mcp-serve-"));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    try {
      const responsesPromise = collectRpcResponses(stdout, 3);
      const serverPromise = startServer(tempDir, stdin, stdout, stderr);

      writeRpcMessage(stdin, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
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

      const responses = await responsesPromise;
      expect(responses[1]).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: {
            name: "@runxhq/cli",
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
          expect.objectContaining({
            name: "runx_resume",
          }),
        ]),
      );
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

      stdin.end();
      await serverPromise;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns paused runs as structured results and resumes them through runx_resume", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-mcp-resume-"));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    try {
      const initialResponses = collectRpcResponses(stdout, 2);
      const serverPromise = startServer(tempDir, stdin, stdout, stderr);

      writeRpcMessage(stdin, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      writeRpcMessage(stdin, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: {},
        },
      });

      const responses = await initialResponses;
      expect(responses[2]).toMatchObject({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
            },
          ],
          structuredContent: {
            runx: {
              status: "paused",
              skillName: "echo",
            },
          },
        },
      });

      const paused = responses[2].result as {
        structuredContent: {
          runx: {
            runId: string;
            requests: Array<{ id: string; kind: string }>;
          };
        };
      };
      const runId = paused.structuredContent.runx.runId;
      const requestId = paused.structuredContent.runx.requests[0]?.id;
      expect(requestId).toMatch(/^input\./);
      expect(paused.structuredContent.runx.requests[0]?.kind).toBe("input");

      const resumeResponses = collectRpcResponses(stdout, 1);
      writeRpcMessage(stdin, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "runx_resume",
          arguments: {
            run_id: runId,
            responses: [
              {
                request_id: requestId,
                payload: {
                  message: "resumed from mcp",
                },
              },
            ],
          },
        },
      });

      const resumed = await resumeResponses;
      expect(resumed[3]).toMatchObject({
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [
            {
              type: "text",
              text: "resumed from mcp",
            },
          ],
          structuredContent: {
            runx: {
              status: "completed",
              skillName: "echo",
              receiptId: runId,
            },
          },
        },
      });

      stdin.end();
      await serverPromise;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function startServer(
  tempDir: string,
  stdin: PassThrough,
  stdout: PassThrough,
  stderr: PassThrough,
): Promise<void> {
  return handleMcpServeCommand(
    {
      mcpRefs: [path.resolve("fixtures/skills/echo")],
    },
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    },
    {
      ...process.env,
      RUNX_CWD: process.cwd(),
    },
    {
      resolveRegistryStoreForChains: async () => undefined,
      resolveDefaultReceiptDir: () => path.join(tempDir, "receipts"),
    },
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
        responses.set(id, message);
        if (responses.size >= expectedCount) {
          cleanup();
          resolve(Object.fromEntries(responses));
        }
      }
    }
  });
}

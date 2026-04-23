import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import type { AdapterInvokeRequest, AdapterInvokeResult, SkillAdapter } from "@runxhq/core/executor";

export const mcpAdapterPackage = "@runxhq/adapters/mcp";

const maxMcpMessageBytes = 1024 * 1024;

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export interface McpAdapter extends SkillAdapter {
  readonly type: "mcp";
}

export function createMcpAdapter(): McpAdapter {
  return {
    type: "mcp",
    invoke: invokeMcp,
  };
}

export async function invokeMcp(request: AdapterInvokeRequest): Promise<AdapterInvokeResult> {
  const started = performance.now();
  const source = request.source;
  const server = source.server;
  const tool = source.tool;

  if (!server || !tool) {
    return failure("MCP source requires server and tool metadata.", started);
  }

  const cwd = resolveCwd(request.skillDirectory, server.cwd);
  const child = spawn(server.command, server.args, {
    cwd,
    env: request.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new StdioJsonRpcClient(child);
  const timeoutMs = Math.max(0.05, source.timeoutSeconds ?? 60) * 1000;
  const toolArgs = request.resolvedInputs
    ? mapResolvedArguments(source.arguments, request.resolvedInputs, request.inputs)
    : mapArguments(source.arguments, request.inputs);

  // Abort support
  if (request.signal) {
    const onAbort = () => terminate(child);
    if (request.signal.aborted) {
      terminate(child);
    } else {
      request.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    const result = await withTimeout(callTool(client, tool, toolArgs), timeoutMs, () => {
      terminate(child);
    });
    terminate(child);

    return {
      status: "success",
      stdout: stringifyToolResult(result),
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: Math.round(performance.now() - started),
      metadata: metadataFor(source),
    };
  } catch (error) {
    terminate(child);
    return failure(sanitizeError(error), started, metadataFor(source));
  }
}

async function callTool(
  client: StdioJsonRpcClient,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: {
      name: "runx",
      version: "0.0.0",
    },
  });
  client.notify("notifications/initialized", {});
  return await client.request("tools/call", {
    name: tool,
    arguments: args,
  });
}

class StdioJsonRpcClient {
  private nextId = 1;
  private stdout = Buffer.alloc(0);
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.stdout = Buffer.concat([this.stdout, chunk]);
      if (this.stdout.length > maxMcpMessageBytes) {
        this.rejectAll(new Error("MCP server response exceeded size limit."));
        return;
      }
      this.parseAvailableMessages();
    });
    this.child.on("error", (error) => {
      this.rejectAll(error);
    });
    this.child.on("close", () => {
      this.rejectAll(new Error("MCP server exited before responding."));
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown): void {
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  private parseAvailableMessages(): void {
    while (true) {
      const headerEnd = this.stdout.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const header = this.stdout.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.rejectAll(new Error("MCP server sent a response without Content-Length."));
        return;
      }

      const contentLength = Number(match[1]);
      if (!Number.isSafeInteger(contentLength) || contentLength > maxMcpMessageBytes) {
        this.rejectAll(new Error("MCP server response exceeded size limit."));
        return;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.stdout.length < bodyEnd) {
        return;
      }

      const body = this.stdout.subarray(bodyStart, bodyEnd).toString("utf8");
      this.stdout = this.stdout.subarray(bodyEnd);
      this.handleMessage(JSON.parse(body) as JsonRpcResponse);
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (message.id === undefined) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function resolveCwd(skillDirectory: string, sourceCwd: string | undefined): string {
  if (!sourceCwd) {
    return skillDirectory;
  }
  return path.isAbsolute(sourceCwd) ? sourceCwd : path.resolve(skillDirectory, sourceCwd);
}

function mapResolvedArguments(
  argumentTemplate: Readonly<Record<string, unknown>> | undefined,
  resolved: Readonly<Record<string, string>>,
  rawInputs: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!argumentTemplate) {
    return { ...rawInputs, ...resolved };
  }

  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(argumentTemplate)) {
    if (typeof value === "string") {
      const exact = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
      if (exact) {
        mapped[key] = exact[1] in resolved ? resolved[exact[1]] : rawInputs[exact[1]];
      } else {
        mapped[key] = value.replace(
          /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
          (_m, k: string) => (k in resolved ? resolved[k] : stringifyInput(rawInputs[k])),
        );
      }
    } else {
      mapped[key] = value;
    }
  }
  return mapped;
}

function mapArguments(
  argumentTemplate: Readonly<Record<string, unknown>> | undefined,
  inputs: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!argumentTemplate) return inputs;
  return mapResolvedArguments(argumentTemplate, {}, inputs);
}

function stringifyToolResult(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    return result.content
      .map((entry) => {
        if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") {
          return entry.text;
        }
        return JSON.stringify(entry);
      })
      .join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result);
}

function metadataFor(source: AdapterInvokeRequest["source"]): Readonly<Record<string, unknown>> {
  return {
    mcp: {
      tool: source.tool,
      server_command_hash: hashString(source.server?.command ?? ""),
      server_args_hash: hashString(JSON.stringify(source.server?.args ?? [])),
    },
  };
}

function failure(
  message: string,
  started: number,
  metadata?: Readonly<Record<string, unknown>>,
): AdapterInvokeResult {
  return {
    status: "failure",
    stdout: "",
    stderr: message,
    exitCode: null,
    signal: null,
    durationMs: Math.round(performance.now() - started),
    errorMessage: message,
    metadata,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          onTimeout();
          reject(new Error(`MCP call timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 100).unref();
}

function sanitizeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "MCP adapter failed.";
  }
  if (error.message.startsWith("MCP error ")) {
    const code = /^MCP error (-?\d+)/.exec(error.message)?.[1] ?? "unknown";
    return `MCP tool returned error ${code}.`;
  }
  if (error.message.includes("timed out")) {
    return error.message;
  }
  return "MCP adapter failed.";
}

function stringifyInput(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

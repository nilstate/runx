import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { SandboxDeclaration } from "@runxhq/core/policy";
import { asRecord, hashString } from "@runxhq/core/util";

import { cleanupLocalProcessSandbox, prepareLocalProcessSandbox } from "../runner-local/process-sandbox.js";

export const mcpRuntimeLocalPackage = "@runxhq/runtime-local/mcp";

const maxMcpMessageBytes = 1024 * 1024;
const defaultMcpTimeoutMs = 60_000;

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

export interface McpServerDefinition {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

export interface McpClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpExecutionSource {
  readonly server?: McpServerDefinition;
  readonly tool?: string;
}

export async function listMcpTools(options: {
  readonly server: McpServerDefinition;
  readonly skillDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sandbox?: SandboxDeclaration & { readonly approvedEscalation?: boolean };
  readonly timeoutMs?: number;
  readonly clientInfo?: McpClientInfo;
}): Promise<readonly McpToolDescriptor[]> {
  const invocation = await withMcpClient(options, async (client) => {
    const result = await client.request("tools/list", {});
    return parseMcpToolsList(result);
  });
  return invocation.value;
}

export async function invokeMcpTool(options: {
  readonly server: McpServerDefinition;
  readonly skillDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sandbox?: SandboxDeclaration & { readonly approvedEscalation?: boolean };
  readonly timeoutMs?: number;
  readonly clientInfo?: McpClientInfo;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}): Promise<unknown> {
  const invocation = await invokeMcpToolWithMetadata(options);
  return invocation.result;
}

export interface McpToolInvocationResult {
  readonly result: unknown;
  readonly sandboxMetadata: Readonly<Record<string, unknown>>;
}

export async function invokeMcpToolWithMetadata(options: {
  readonly server: McpServerDefinition;
  readonly skillDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sandbox?: SandboxDeclaration & { readonly approvedEscalation?: boolean };
  readonly timeoutMs?: number;
  readonly clientInfo?: McpClientInfo;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}): Promise<McpToolInvocationResult> {
  const invocation = await withMcpClient(options, async (client) =>
    await client.request("tools/call", {
      name: options.tool,
      arguments: options.args,
    }));
  return {
    result: invocation.value,
    sandboxMetadata: invocation.sandboxMetadata,
  };
}

export function mapMcpArguments(
  argumentTemplate: Readonly<Record<string, unknown>> | undefined,
  inputs: Readonly<Record<string, unknown>>,
  resolvedInputs?: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> {
  if (!argumentTemplate) {
    return resolvedInputs ? { ...inputs, ...resolvedInputs } : inputs;
  }

  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(argumentTemplate)) {
    if (typeof value === "string") {
      const exact = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
      if (exact) {
        mapped[key] = exact[1] in (resolvedInputs ?? {}) ? resolvedInputs?.[exact[1]] : inputs[exact[1]];
      } else {
        mapped[key] = value.replace(
          /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
          (_m, templateKey: string) =>
            templateKey in (resolvedInputs ?? {})
              ? resolvedInputs?.[templateKey] ?? ""
              : stringifyMcpInput(inputs[templateKey]),
        );
      }
    } else {
      mapped[key] = value;
    }
  }
  return mapped;
}

export function stringifyMcpToolResult(result: unknown): string {
  const record = asRecord(result);
  if (record && Array.isArray(record.content)) {
    return record.content
      .map((entry: unknown) => {
        const contentEntry = asRecord(entry);
        if (contentEntry && contentEntry.type === "text" && typeof contentEntry.text === "string") {
          return contentEntry.text;
        }
        return JSON.stringify(entry);
      })
      .join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result) ?? "";
}

export function createMcpExecutionMetadata(
  source: McpExecutionSource,
  sandboxMetadata?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    mcp: {
      tool: source.tool,
      server_command_hash: hashString(source.server?.command ?? ""),
      server_args_hash: hashString(JSON.stringify(source.server?.args ?? [])),
    },
    ...(sandboxMetadata ? { sandbox: sandboxMetadata } : {}),
  };
}

export class McpSandboxDeniedError extends Error {
  constructor(
    message: string,
    readonly sandboxMetadata: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "McpSandboxDeniedError";
  }
}

async function withMcpClient<T>(
  options: {
    readonly server: McpServerDefinition;
    readonly skillDirectory: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly sandbox?: SandboxDeclaration & { readonly approvedEscalation?: boolean };
    readonly timeoutMs?: number;
    readonly clientInfo?: McpClientInfo;
  },
  action: (client: StdioJsonRpcClient) => Promise<T>,
): Promise<{ readonly value: T; readonly sandboxMetadata: Readonly<Record<string, unknown>> }> {
  const sandbox = prepareLocalProcessSandbox({
    sandbox: options.sandbox,
    skillDirectory: options.skillDirectory,
    sourceCwd: options.server.cwd,
    env: options.env,
    command: options.server.command,
    args: options.server.args,
  });
  if (sandbox.status === "deny") {
    throw new McpSandboxDeniedError(`MCP sandbox denied: ${sandbox.reason}`, sandbox.metadata);
  }
  const child = spawn(sandbox.command ?? options.server.command, sandbox.args ?? options.server.args, {
    cwd: sandbox.cwd,
    env: sandbox.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new StdioJsonRpcClient(child);
  const timeoutMs = Math.max(options.timeoutMs ?? defaultMcpTimeoutMs, 50);

  try {
    const value = await withTimeout((async () => {
      await initializeMcpClient(client, options.clientInfo);
      return await action(client);
    })(), timeoutMs, () => terminate(child));
    return {
      value,
      sandboxMetadata: sandbox.metadata,
    };
  } finally {
    terminate(child);
    cleanupLocalProcessSandbox(sandbox);
  }
}

async function initializeMcpClient(
  client: StdioJsonRpcClient,
  clientInfo: McpClientInfo = {
    name: "runx",
    version: "0.0.0",
  },
): Promise<void> {
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo,
  });
  client.notify("notifications/initialized", {});
}

function parseMcpToolsList(value: unknown): readonly McpToolDescriptor[] {
  const record = asRecord(value);
  const entries = Array.isArray(record?.tools) ? record.tools : [];
  return entries.flatMap((entry) => {
    const tool = asRecord(entry);
    if (!tool || typeof tool.name !== "string" || tool.name.trim() === "") {
      return [];
    }
    return [{
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: asRecord(tool.inputSchema) ?? asRecord(tool.input_schema) ?? undefined,
    }] satisfies readonly McpToolDescriptor[];
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
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(body) as JsonRpcResponse;
      } catch {
        this.stdout = Buffer.alloc(0);
        this.rejectAll(new Error("MCP server sent invalid JSON."));
        return;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
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

function stringifyMcpInput(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

import type { AdapterInvokeRequest, AdapterInvokeResult, SkillAdapter } from "@runxhq/core/executor";
import {
  createMcpExecutionMetadata,
  invokeMcpToolWithMetadata,
  mapMcpArguments,
  McpSandboxDeniedError,
  stringifyMcpToolResult,
} from "@runxhq/runtime-local/mcp";

export const mcpAdapterPackage = "@runxhq/adapters/mcp";

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

  const timeoutMs = Math.max(0.05, source.timeoutSeconds ?? 60) * 1000;
  const toolArgs = mapMcpArguments(source.arguments, request.inputs, request.resolvedInputs);

  try {
    const result = await invokeMcpToolWithMetadata({
      server,
      skillDirectory: request.skillDirectory,
      env: request.env,
      sandbox: source.sandbox,
      timeoutMs,
      tool,
      args: toolArgs,
    });

    return {
      status: "success",
      stdout: stringifyMcpToolResult(result.result),
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: Math.round(performance.now() - started),
      metadata: createMcpExecutionMetadata(source, result.sandboxMetadata),
    };
  } catch (error) {
    return failure(sanitizeError(error), started, createMcpExecutionMetadata(source, sandboxMetadataFromError(error)));
  }
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

function sanitizeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "MCP adapter failed.";
  }
  if (error instanceof McpSandboxDeniedError) {
    return error.message;
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

function sandboxMetadataFromError(error: unknown): Readonly<Record<string, unknown>> | undefined {
  return error instanceof McpSandboxDeniedError ? error.sandboxMetadata : undefined;
}

import { createHash } from "node:crypto";

import type { AdapterInvokeRequest, AdapterInvokeResult, SkillAdapter } from "@runxhq/core/executor";
import { invokeMcpTool } from "@runxhq/core/mcp";

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
  const toolArgs = request.resolvedInputs
    ? mapResolvedArguments(source.arguments, request.resolvedInputs, request.inputs)
    : mapArguments(source.arguments, request.inputs);

  try {
    const result = await invokeMcpTool({
      server,
      skillDirectory: request.skillDirectory,
      env: request.env,
      timeoutMs,
      tool,
      args: toolArgs,
    });

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
    return failure(sanitizeError(error), started, metadataFor(source));
  }
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

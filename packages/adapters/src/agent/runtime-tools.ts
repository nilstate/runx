import {
  type AdapterInvokeRequest,
  type NestedSkillInvoker,
  type SkillAdapter,
} from "@runxhq/core/executor";
import { resolveToolExecutionTarget, runValidatedSkill } from "@runxhq/runtime-local";

import { createA2aAdapter, createFixtureA2aTransport } from "../a2a/index.js";
import { createCliToolAdapter } from "../cli-tool/index.js";
import { createMcpAdapter } from "../mcp/index.js";

import type { ManagedRuntimeTool, ManagedToolCallResult } from "./types.js";
import {
  asRecord,
  packetSchemaFromOutput,
  parseJsonMaybe,
  sanitizeProviderToolName,
  uniqueStrings,
  unwrapPacketData,
} from "./helpers.js";
import { skillInputsToJsonSchema } from "./json-schema.js";

const toolExecutionAdapters: readonly SkillAdapter[] = [
  createCliToolAdapter(),
  createMcpAdapter(),
  createA2aAdapter({ transport: createFixtureA2aTransport() }),
];

export async function resolveManagedRuntimeTools(
  allowedTools: readonly string[],
  searchFromDirectory: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  toolRoots: readonly string[] | undefined,
  nestedSkillInvoker: NestedSkillInvoker | undefined,
  toolCatalogAdapters: AdapterInvokeRequest["toolCatalogAdapters"],
): Promise<readonly ManagedRuntimeTool[]> {
  const tools: ManagedRuntimeTool[] = [];
  const seenRunxNames = new Set<string>();
  const seenProviderNames = new Set<string>();

  for (const toolName of uniqueStrings(allowedTools)) {
    if (seenRunxNames.has(toolName)) {
      continue;
    }
    const target = await resolveToolExecutionTarget(toolName, searchFromDirectory, {
      env,
      toolRoots,
      toolCatalogAdapters,
    });
    const providerName = sanitizeProviderToolName(toolName);
    if (seenProviderNames.has(providerName)) {
      throw new Error(`Managed agent tool name collision for '${toolName}' -> '${providerName}'. Rename one of the allowed tools.`);
    }
    seenRunxNames.add(toolName);
    seenProviderNames.add(providerName);

    tools.push({
      runxName: toolName,
      providerName,
      description: target.skill.description ?? `runx tool ${toolName}`,
      parameters: skillInputsToJsonSchema(target.skill.inputs),
      invoke: async (argumentsValue) =>
        await invokeManagedRuntimeTool(
          toolName,
          target.skill,
          target.referencePath,
          target.skillDirectory,
          argumentsValue,
          env,
          signal,
          nestedSkillInvoker,
          toolCatalogAdapters,
        ),
    });
  }

  return tools;
}

async function invokeManagedRuntimeTool(
  toolName: string,
  skill: Awaited<ReturnType<typeof resolveToolExecutionTarget>>["skill"],
  requestedSkillPath: string,
  skillDirectory: string,
  argumentsValue: unknown,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  nestedSkillInvoker: NestedSkillInvoker | undefined,
  toolCatalogAdapters: AdapterInvokeRequest["toolCatalogAdapters"],
): Promise<ManagedToolCallResult> {
  const inputs = asRecord(argumentsValue);
  if (!inputs) {
    return {
      value: {
        error: `Tool '${toolName}' arguments must be a JSON object.`,
      },
      trace: {
        tool: toolName,
        status: "failure",
      },
    };
  }

  const result = await (
    nestedSkillInvoker
      ? nestedSkillInvoker({
          skill,
          skillDirectory,
          requestedSkillPath,
          inputs,
          receiptMetadata: {
            runx: {
              managed_tool: {
                name: toolName,
              },
            },
          },
        })
      : invokeManagedRuntimeToolDirect({
          skill,
          skillDirectory,
          requestedSkillPath,
          inputs,
          env,
          toolCatalogAdapters,
        })
  );

  if (result.status === "needs_resolution") {
    return {
      value: {
        error: `Tool '${toolName}' requested ${result.request.kind} resolution and cannot be used inside managed agent execution.`,
      },
      request: result.request,
      trace: {
        tool: toolName,
        status: "needs_resolution",
        resolutionKind: result.request.kind,
        receiptId: result.receiptId,
      },
    };
  }

  if (result.status === "policy_denied") {
    return {
      value: {
        error: result.errorMessage ?? `Tool '${toolName}' was denied by policy.`,
        reasons: result.reasons,
      },
      trace: {
        tool: toolName,
        status: "policy_denied",
        receiptId: result.receiptId,
      },
    };
  }

  const stdoutValue = parseJsonMaybe(result.stdout);
  const packetSchema = packetSchemaFromOutput(stdoutValue);
  const unwrapped = unwrapPacketData(stdoutValue);
  if (result.status === "success") {
    return packetSchema
      ? {
          value: { schema: packetSchema, data: unwrapped },
          trace: {
            tool: toolName,
            status: "success",
            receiptId: result.receiptId,
          },
        }
      : {
          value: unwrapped,
          trace: {
            tool: toolName,
            status: "success",
            receiptId: result.receiptId,
          },
        };
  }

  return {
    value: {
      error: result.errorMessage ?? `Tool '${toolName}' failed.`,
      exit_code: result.exitCode,
      stderr: result.stderr || undefined,
      signal: result.signal ?? undefined,
      output: packetSchema
        ? { schema: packetSchema, data: unwrapped }
        : unwrapped,
    },
    trace: {
      tool: toolName,
      status: "failure",
      receiptId: result.receiptId,
    },
  };
}

export async function executeManagedToolCall(tool: ManagedRuntimeTool, argumentsValue: unknown): Promise<ManagedToolCallResult> {
  try {
    return await tool.invoke(argumentsValue);
  } catch (error) {
    return {
      value: {
        error: error instanceof Error ? error.message : String(error),
      },
      trace: {
        tool: tool.runxName,
        status: "failure",
      },
    };
  }
}

async function invokeManagedRuntimeToolDirect(options: {
  readonly skill: Awaited<ReturnType<typeof resolveToolExecutionTarget>>["skill"];
  readonly skillDirectory: string;
  readonly requestedSkillPath: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly env: NodeJS.ProcessEnv;
  readonly toolCatalogAdapters: AdapterInvokeRequest["toolCatalogAdapters"];
}) {
  const result = await runValidatedSkill({
    skill: options.skill,
    skillDirectory: options.skillDirectory,
    requestedSkillPath: options.requestedSkillPath,
    inputs: options.inputs,
    caller: {
      resolve: async () => undefined,
      report: async () => undefined,
    },
    env: options.env,
    adapters: toolExecutionAdapters,
    receiptDir: options.env.RUNX_RECEIPT_DIR,
    runxHome: options.env.RUNX_HOME,
    toolCatalogAdapters: options.toolCatalogAdapters,
  });

  if (result.status === "needs_resolution") {
    const request = result.requests[0];
    if (!request) {
      throw new Error(
        `Direct managed-tool execution for '${options.requestedSkillPath}' requested resolution without a request payload.`,
      );
    }
    return {
      status: "needs_resolution" as const,
      request,
    };
  }

  if (result.status === "policy_denied") {
    return {
      status: "policy_denied" as const,
      reasons: result.reasons,
      receiptId: result.receipt?.id,
      errorMessage: result.reasons.join("; "),
    };
  }

  return {
    status: result.status,
    stdout: result.execution.stdout,
    stderr: result.execution.stderr,
    exitCode: result.execution.exitCode,
    signal: result.execution.signal,
    durationMs: result.execution.durationMs,
    errorMessage: result.execution.errorMessage,
    receiptId: result.receipt.id,
  };
}

export const agentAdapterPackage = "@runxhq/adapters/agent";

import path from "node:path";

import {
  loadLocalAgentApiKey,
  loadRunxConfigFile,
  resolveRunxHomeDir,
} from "@runxhq/core/config";
import {
  validateOutputContract,
  type AdapterInvokeRequest,
  type AdapterInvokeResult,
  type AgentWorkRequest,
  type CognitiveResolutionRequest,
  type NestedSkillInvoker,
  type OutputContract,
  type OutputContractEntry,
  type ResolutionRequest,
  type ResolutionResponse,
  type SkillAdapter,
} from "@runxhq/core/executor";
import type { SkillInput } from "@runxhq/core/parser";
import { resolveToolExecutionTarget, runValidatedSkill } from "@runxhq/core/runner-local";

import { createA2aAdapter, createFixtureA2aTransport } from "../a2a/index.js";
import { createCliToolAdapter } from "../cli-tool/index.js";
import { createMcpAdapter } from "../mcp/index.js";

export type ManagedAgentProvider = "openai" | "anthropic";

export interface ManagedAgentConfig {
  readonly provider: ManagedAgentProvider;
  readonly model: string;
  readonly apiKey: string;
}

interface ManagedToolCallResult {
  readonly value: unknown;
  readonly trace?: ManagedToolExecutionTrace;
}

interface ManagedToolExecutionTrace {
  readonly tool: string;
  readonly status: "success" | "failure" | "policy_denied" | "needs_resolution";
  readonly receiptId?: string;
  readonly resolutionKind?: ResolutionRequest["kind"];
}

interface ManagedRuntimeTool {
  readonly runxName: string;
  readonly providerName: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly invoke: (argumentsValue: unknown) => Promise<ManagedToolCallResult>;
}

interface ManagedAgentExecutionDetails {
  readonly response: ResolutionResponse;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly tools: readonly string[];
  readonly toolExecutions: readonly ManagedToolExecutionTrace[];
}

interface OpenAiToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

interface OpenAiToolCall {
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

interface ToolCallOutputItem {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string;
}

interface OpenAiResponseBody {
  readonly output?: readonly unknown[];
}

type OpenAiResponseInputItem =
  | Readonly<Record<string, unknown>>
  | ToolCallOutputItem;

interface AnthropicToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

interface AnthropicToolUseBlock extends Readonly<Record<string, unknown>> {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

interface AnthropicTextBlock extends Readonly<Record<string, unknown>> {
  readonly type: "text";
  readonly text: string;
}

interface AnthropicToolResultBlock extends Readonly<Record<string, unknown>> {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly Readonly<Record<string, unknown>>[];
}

interface AnthropicResponseBody {
  readonly content?: readonly unknown[];
}

const FINAL_RESULT_TOOL_NAME = "submit_result";
const anthropicVersion = "2023-06-01";
const maxManagedAgentRounds = 24;

const toolExecutionAdapters: readonly SkillAdapter[] = [
  createCliToolAdapter(),
  createMcpAdapter(),
  createA2aAdapter({ transport: createFixtureA2aTransport() }),
];

export async function loadManagedAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManagedAgentConfig | undefined> {
  const configDir = resolveRunxHomeDir(env);
  const config = await loadRunxConfigFile(path.join(configDir, "config.json"));
  const provider = normalizeManagedAgentProvider(env.RUNX_AGENT_PROVIDER ?? config.agent?.provider);
  if (!provider) {
    return undefined;
  }

  const model = String(env.RUNX_AGENT_MODEL ?? config.agent?.model ?? "").trim();
  if (!model) {
    return undefined;
  }

  const providerApiKey = provider === "openai"
    ? env.OPENAI_API_KEY
    : env.ANTHROPIC_API_KEY;
  const apiKey =
    String(env.RUNX_AGENT_API_KEY ?? providerApiKey ?? "").trim()
    || (
      typeof config.agent?.api_key_ref === "string" && config.agent.api_key_ref.length > 0
        ? (await loadLocalAgentApiKey(configDir, config.agent.api_key_ref)).trim()
        : ""
    );
  if (!apiKey) {
    return undefined;
  }

  return {
    provider,
    model,
    apiKey,
  };
}

export function formatManagedAgentLabel(config: ManagedAgentConfig): string {
  return `${config.provider === "openai" ? "OpenAI" : "Anthropic"} ${config.model}`;
}

export function createManagedAgentAdapter(config: ManagedAgentConfig): SkillAdapter {
  return {
    type: "agent",
    invoke: async (request) => await invokeManagedAgentAdapter(config, request, "agent"),
  };
}

export function createManagedAgentStepAdapter(config: ManagedAgentConfig): SkillAdapter {
  return {
    type: "agent-step",
    invoke: async (request) => await invokeManagedAgentAdapter(config, request, "agent-step"),
  };
}

export async function executeManagedAgentResolution(
  config: ManagedAgentConfig,
  request: CognitiveResolutionRequest,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly searchFromDirectory?: string;
    readonly nestedSkillInvoker?: NestedSkillInvoker;
  } = {},
): Promise<ResolutionResponse> {
  return (await executeManagedAgentRequest(config, request, options)).response;
}

async function invokeManagedAgentAdapter(
  config: ManagedAgentConfig,
  request: AdapterInvokeRequest,
  sourceType: "agent" | "agent-step",
): Promise<AdapterInvokeResult> {
  const startedAt = Date.now();
  const env = request.env ?? process.env;
  const work = buildManagedAgentWorkRequest(request, sourceType);

  try {
    const execution = await executeManagedAgentRequest(
      config,
      {
        id: work.id,
        kind: "cognitive_work",
        work,
      },
      {
        env,
        signal: request.signal,
        searchFromDirectory: request.skillDirectory,
        nestedSkillInvoker: request.nestedSkillInvoker,
        toolCatalogAdapters: request.toolCatalogAdapters,
      },
    );

    return {
      status: "success",
      stdout: typeof execution.response.payload === "string"
        ? execution.response.payload
        : JSON.stringify(execution.response.payload),
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: Date.now() - startedAt,
      metadata: nativeAgentMetadata(sourceType, request, config, execution),
    };
  } catch (error) {
    return {
      status: "failure",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      metadata: nativeAgentMetadata(sourceType, request, config),
    };
  }
}

async function executeManagedAgentRequest(
  config: ManagedAgentConfig,
  request: CognitiveResolutionRequest,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly searchFromDirectory?: string;
    readonly nestedSkillInvoker?: NestedSkillInvoker;
    readonly toolCatalogAdapters?: AdapterInvokeRequest["toolCatalogAdapters"];
  } = {},
): Promise<ManagedAgentExecutionDetails> {
  const env = options.env ?? process.env;
  const searchFromDirectory = path.resolve(
    options.searchFromDirectory
      ?? request.work.envelope.execution_location?.skill_directory
      ?? env.RUNX_CWD
      ?? process.cwd(),
  );
  const runtimeTools = await resolveManagedRuntimeTools(
    request.work.envelope.allowed_tools,
    searchFromDirectory,
    env,
    options.signal,
    request.work.envelope.execution_location?.tool_roots,
    options.nestedSkillInvoker,
    options.toolCatalogAdapters,
  );

  if (config.provider === "anthropic") {
    return await resolveWithAnthropic(config, request, runtimeTools, options.signal);
  }
  return await resolveWithOpenAi(config, request, runtimeTools, options.signal);
}

async function resolveWithOpenAi(
  config: ManagedAgentConfig,
  request: CognitiveResolutionRequest,
  runtimeTools: readonly ManagedRuntimeTool[],
  signal: AbortSignal | undefined,
): Promise<ManagedAgentExecutionDetails> {
  const tools = buildOpenAiTools(request, runtimeTools);
  const toolByProviderName = new Map(runtimeTools.map((tool) => [tool.providerName, tool] as const));
  const history: OpenAiResponseInputItem[] = [buildOpenAiInitialRequestMessage(request)];
  let toolCalls = 0;
  const toolExecutions: ManagedToolExecutionTrace[] = [];

  for (let round = 1; round <= maxManagedAgentRounds; round += 1) {
    const response = await createOpenAiResponse(config, {
      instructions: buildManagedRuntimeInstructions(request),
      input: history,
      tools,
      signal,
    });
    const functionCalls = collectOpenAiFunctionCalls(response);

    if (functionCalls.length === 0) {
      const assistantText = extractOpenAiAssistantText(response);
      if (!request.work.envelope.expected_outputs) {
        if (!assistantText.trim()) {
          throw new Error(`Managed agent resolution for ${request.id} returned no assistant text.`);
        }
        return {
          response: { actor: "agent", payload: assistantText },
          rounds: round,
          toolCalls,
          tools: runtimeTools.map((tool) => tool.runxName),
          toolExecutions,
        };
      }

      if (Array.isArray(response.output) && response.output.length > 0) {
        history.push(...response.output.filter(isRecord));
      }
      history.push(buildOpenAiCorrectionMessage("Return the final payload by calling submit_result. Do not answer in prose."));
      continue;
    }

    toolCalls += functionCalls.length;
    if (Array.isArray(response.output) && response.output.length > 0) {
      history.push(...response.output.filter(isRecord));
    }

    const toolOutputs: ToolCallOutputItem[] = [];
    for (const call of functionCalls) {
      if (call.name === FINAL_RESULT_TOOL_NAME) {
        try {
          const submittedPayload = parseJsonObject(call.arguments, `${call.name}.arguments`);
          const validationError = validateFinalPayload(submittedPayload, request.work.envelope.expected_outputs);
          if (!validationError) {
            return {
              response: { actor: "agent", payload: submittedPayload },
              rounds: round,
              toolCalls,
              tools: runtimeTools.map((tool) => tool.runxName),
              toolExecutions,
            };
          }
          toolOutputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({ error: validationError }),
          });
        } catch (error) {
          toolOutputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          });
        }
        continue;
      }

      const tool = toolByProviderName.get(call.name);
      if (!tool) {
        toolOutputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({ error: `Unknown tool '${call.name}'.` }),
        });
        continue;
      }

      const result = await executeManagedToolCall(tool, parseJsonValue(call.arguments, `${call.name}.arguments`));
      if (result.trace) {
        toolExecutions.push(result.trace);
      }
      toolOutputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result.value),
      });
    }

    history.push(...toolOutputs);
  }

  throw new Error(`Managed OpenAI agent resolution for ${request.id} exceeded the maximum tool-call rounds.`);
}

async function resolveWithAnthropic(
  config: ManagedAgentConfig,
  request: CognitiveResolutionRequest,
  runtimeTools: readonly ManagedRuntimeTool[],
  signal: AbortSignal | undefined,
): Promise<ManagedAgentExecutionDetails> {
  const tools = buildAnthropicTools(request, runtimeTools);
  const toolByProviderName = new Map(runtimeTools.map((tool) => [tool.providerName, tool] as const));
  const messages: AnthropicMessage[] = [buildAnthropicInitialRequestMessage(request)];
  let toolCalls = 0;
  const toolExecutions: ManagedToolExecutionTrace[] = [];

  for (let round = 1; round <= maxManagedAgentRounds; round += 1) {
    const response = await createAnthropicMessage(config, {
      system: buildManagedRuntimeInstructions(request),
      messages,
      tools,
      signal,
    });
    const assistantContent = normalizeAnthropicAssistantContent(response.content);
    const toolUses = collectAnthropicToolUses(assistantContent);

    if (toolUses.length === 0) {
      const assistantText = extractAnthropicAssistantText(assistantContent);
      if (!request.work.envelope.expected_outputs) {
        if (!assistantText.trim()) {
          throw new Error(`Managed agent resolution for ${request.id} returned no assistant text.`);
        }
        return {
          response: { actor: "agent", payload: assistantText },
          rounds: round,
          toolCalls,
          tools: runtimeTools.map((tool) => tool.runxName),
          toolExecutions,
        };
      }

      messages.push({ role: "assistant", content: assistantContent });
      messages.push({
        role: "user",
        content: [{ type: "text", text: "Return the final payload by calling submit_result. Do not answer in prose." }],
      });
      continue;
    }

    toolCalls += toolUses.length;
    messages.push({ role: "assistant", content: assistantContent });
    const toolResults: AnthropicToolResultBlock[] = [];

    for (const toolUse of toolUses) {
      if (toolUse.name === FINAL_RESULT_TOOL_NAME) {
        const finalized = completeAnthropicFinalResult(toolUse, request, round, toolCalls, runtimeTools, toolExecutions);
        if (finalized.ok) {
          return finalized.value;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: finalized.error }),
          is_error: true,
        });
        continue;
      }

      const tool = toolByProviderName.get(toolUse.name);
      if (!tool) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: `Unknown tool '${toolUse.name}'.` }),
          is_error: true,
        });
        continue;
      }

      const result = await executeManagedToolCall(tool, toolUse.input);
      if (result.trace) {
        toolExecutions.push(result.trace);
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(result.value),
        is_error: isToolErrorResult(result.value),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(`Managed Anthropic agent resolution for ${request.id} exceeded the maximum tool-call rounds.`);
}

async function resolveManagedRuntimeTools(
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

async function executeManagedToolCall(tool: ManagedRuntimeTool, argumentsValue: unknown): Promise<ManagedToolCallResult> {
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

function buildManagedRuntimeInstructions(request: CognitiveResolutionRequest): string {
  const lines = [
    "You are resolving a runx cognitive_work request inside the managed runtime.",
    "Follow the runx instructions and inputs exactly.",
    "Treat current_context, historical_context, provenance, and explicit inputs as grounded evidence.",
    "If more evidence is needed, use the declared runx tools instead of guessing.",
    "Tool outputs come from governed runx executions and should be treated as grounded JSON results.",
    "Do not invent files, repo state, commands, or outputs that you did not inspect or infer from grounded evidence.",
  ];
  if (request.work.envelope.expected_outputs) {
    lines.push(`When you are done, call ${FINAL_RESULT_TOOL_NAME} exactly once with the final payload.`);
  } else {
    lines.push("When you are done, return the final answer as plain assistant text.");
  }
  return lines.join("\n");
}

function buildManagedAgentWorkRequest(
  request: AdapterInvokeRequest,
  sourceType: "agent" | "agent-step",
): AgentWorkRequest {
  const skillName = request.skillName ?? (sourceType === "agent-step" ? "agent-step" : "skill");
  const expectedOutputs = validateOutputContract(request.source.outputs, "source.outputs");
  const base = {
    run_id: request.runId ?? "rx_pending",
    step_id: request.stepId,
    skill: skillName,
    instructions: request.skillBody?.trim() ?? "",
    inputs: request.inputs,
    allowed_tools: request.allowedTools ?? [],
    current_context: request.currentContext ?? [],
    historical_context: request.historicalContext ?? [],
    provenance: request.contextProvenance ?? [],
    context: request.context,
    voice_profile: request.voiceProfile,
    quality_profile: request.qualityProfile,
    execution_location: buildExecutionLocation(request),
    trust_boundary: "native-managed: runx executes the model and tool loop directly, receipts the result, and only yields to a surface for explicit human resolution outside this path",
    ...(expectedOutputs ? { expected_outputs: expectedOutputs } : {}),
  } as const;

  if (sourceType === "agent-step") {
    return {
      id: `agent_step.${normalizeRequestId(request.source.task ?? skillName)}.output`,
      source_type: "agent-step",
      agent: request.source.agent,
      task: request.source.task,
      envelope: base,
    };
  }

  return {
    id: `agent.${normalizeRequestId(skillName)}.output`,
    source_type: "agent",
    agent: request.source.agent,
    task: request.source.task,
    envelope: base,
  };
}

function buildExecutionLocation(request: AdapterInvokeRequest): {
  readonly skill_directory: string;
  readonly tool_roots?: readonly string[];
} {
  const toolRoots = parseConfiguredToolRoots(request.env);
  return {
    skill_directory: request.skillDirectory,
    ...(toolRoots.length > 0 ? { tool_roots: toolRoots } : {}),
  };
}

function nativeAgentMetadata(
  sourceType: "agent" | "agent-step",
  request: AdapterInvokeRequest,
  config: ManagedAgentConfig,
  execution?: ManagedAgentExecutionDetails,
): Readonly<Record<string, unknown>> {
  if (sourceType === "agent-step") {
    return {
      agent_hook: {
        source_type: "agent-step",
        agent: request.source.agent,
        task: request.source.task,
        route: "native",
        provider: config.provider,
        model: config.model,
        status: execution ? "success" : "failure",
        rounds: execution?.rounds,
        tool_calls: execution?.toolCalls,
        tools: execution?.tools,
        tool_executions: execution?.toolExecutions,
      },
    };
  }

  return {
    agent_runner: {
      skill: request.skillName ?? "skill",
      route: "native",
      provider: config.provider,
      model: config.model,
      status: execution ? "success" : "failure",
      rounds: execution?.rounds,
      tool_calls: execution?.toolCalls,
      tools: execution?.tools,
      tool_executions: execution?.toolExecutions,
    },
  };
}

function buildOpenAiTools(
  request: CognitiveResolutionRequest,
  runtimeTools: readonly ManagedRuntimeTool[],
): readonly OpenAiToolDefinition[] {
  const tools = runtimeTools.map((tool) => ({
    type: "function" as const,
    name: tool.providerName,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
  if (!request.work.envelope.expected_outputs) {
    return tools;
  }
  return [
    ...tools,
    {
      type: "function",
      name: FINAL_RESULT_TOOL_NAME,
      description: "Submit the final structured payload for this runx cognitive_work request.",
      strict: false,
      parameters: outputContractToJsonSchema(request.work.envelope.expected_outputs),
    },
  ];
}

function buildAnthropicTools(
  request: CognitiveResolutionRequest,
  runtimeTools: readonly ManagedRuntimeTool[],
): readonly AnthropicToolDefinition[] {
  const tools = runtimeTools.map((tool) => ({
    name: tool.providerName,
    description: tool.description,
    input_schema: tool.parameters,
  }));
  if (!request.work.envelope.expected_outputs) {
    return tools;
  }
  return [
    ...tools,
    {
      name: FINAL_RESULT_TOOL_NAME,
      description: "Submit the final structured payload for this runx cognitive_work request.",
      input_schema: outputContractToJsonSchema(request.work.envelope.expected_outputs),
    },
  ];
}

function buildOpenAiInitialRequestMessage(request: CognitiveResolutionRequest): Readonly<Record<string, unknown>> {
  return {
    role: "user",
    content: [
      {
        type: "input_text",
        text: [
          "Resolve this runx cognitive_work request.",
          JSON.stringify({
            request_id: request.id,
            source_type: request.work.source_type,
            agent: request.work.agent,
            task: request.work.task,
            envelope: request.work.envelope,
          }, null, 2),
        ].join("\n\n"),
      },
    ],
  };
}

function buildOpenAiCorrectionMessage(message: string): Readonly<Record<string, unknown>> {
  return {
    role: "user",
    content: [
      {
        type: "input_text",
        text: message,
      },
    ],
  };
}

function buildAnthropicInitialRequestMessage(request: CognitiveResolutionRequest): AnthropicMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "Resolve this runx cognitive_work request.",
          JSON.stringify({
            request_id: request.id,
            source_type: request.work.source_type,
            agent: request.work.agent,
            task: request.work.task,
            envelope: request.work.envelope,
          }, null, 2),
        ].join("\n\n"),
      },
    ],
  };
}

function completeAnthropicFinalResult(
  toolUse: AnthropicToolUseBlock,
  request: CognitiveResolutionRequest,
  round: number,
  toolCalls: number,
  runtimeTools: readonly ManagedRuntimeTool[],
  toolExecutions: readonly ManagedToolExecutionTrace[],
): { readonly ok: true; readonly value: ManagedAgentExecutionDetails } | { readonly ok: false; readonly error: string } {
  const submittedPayload = asRecord(toolUse.input);
  if (!submittedPayload) {
    return {
      ok: false,
      error: `${FINAL_RESULT_TOOL_NAME}.input must be a JSON object.`,
    };
  }
  const validationError = validateFinalPayload(submittedPayload, request.work.envelope.expected_outputs);
  if (validationError) {
    return {
      ok: false,
      error: validationError,
    };
  }
  return {
    ok: true,
    value: {
      response: { actor: "agent", payload: submittedPayload },
      rounds: round,
      toolCalls,
      tools: runtimeTools.map((tool) => tool.runxName),
      toolExecutions,
    },
  };
}

async function createOpenAiResponse(
  config: ManagedAgentConfig,
  request: {
    readonly instructions: string;
    readonly input: readonly OpenAiResponseInputItem[];
    readonly tools: readonly OpenAiToolDefinition[];
    readonly signal?: AbortSignal;
  },
): Promise<OpenAiResponseBody> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      store: false,
      parallel_tool_calls: false,
      instructions: request.instructions,
      input: request.input,
      tools: request.tools,
    }),
    signal: request.signal,
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`OpenAI Responses API ${response.status}: ${extractApiErrorMessage(bodyText)}`);
  }

  return await response.json() as OpenAiResponseBody;
}

async function createAnthropicMessage(
  config: ManagedAgentConfig,
  request: {
    readonly system: string;
    readonly messages: readonly AnthropicMessage[];
    readonly tools: readonly AnthropicToolDefinition[];
    readonly signal?: AbortSignal;
  },
): Promise<AnthropicResponseBody> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "anthropic-version": anthropicVersion,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      system: request.system,
      max_tokens: 4096,
      messages: request.messages,
      tools: request.tools,
    }),
    signal: request.signal,
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Anthropic Messages API ${response.status}: ${extractApiErrorMessage(bodyText)}`);
  }

  return await response.json() as AnthropicResponseBody;
}

function collectOpenAiFunctionCalls(response: OpenAiResponseBody): readonly OpenAiToolCall[] {
  return Array.isArray(response.output)
    ? response.output
      .filter((item): item is OpenAiToolCall =>
        isRecord(item)
        && item.type === "function_call"
        && typeof item.call_id === "string"
        && typeof item.name === "string"
        && typeof item.arguments === "string")
    : [];
}

function extractOpenAiAssistantText(response: OpenAiResponseBody): string {
  if (!Array.isArray(response.output)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (!isRecord(content)) {
        continue;
      }
      if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string") {
        parts.push(content.text);
        continue;
      }
      if (content.type === "refusal" && typeof content.refusal === "string") {
        throw new Error(`OpenAI agent refused the request: ${content.refusal}`);
      }
    }
  }
  return parts.join("").trim();
}

function normalizeAnthropicAssistantContent(content: readonly unknown[] | undefined): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(isRecord);
}

function collectAnthropicToolUses(content: readonly Readonly<Record<string, unknown>>[]): readonly AnthropicToolUseBlock[] {
  return content.filter((entry): entry is AnthropicToolUseBlock =>
    entry.type === "tool_use"
    && typeof entry.id === "string"
    && typeof entry.name === "string");
}

function extractAnthropicAssistantText(content: readonly Readonly<Record<string, unknown>>[]): string {
  return content
    .filter((entry): entry is AnthropicTextBlock => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("")
    .trim();
}

function skillInputsToJsonSchema(inputs: Readonly<Record<string, SkillInput>>): Readonly<Record<string, unknown>> {
  const properties = Object.fromEntries(
    Object.entries(inputs).map(([name, input]) => [name, skillInputToJsonSchema(input)]),
  );
  const required = Object.entries(inputs)
    .filter(([, input]) => input.required)
    .map(([name]) => name);
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function skillInputToJsonSchema(input: SkillInput): Readonly<Record<string, unknown>> {
  const schema: Record<string, unknown> = {};
  const normalizedType = normalizeInputType(input.type);
  if (normalizedType) {
    schema.type = normalizedType;
  }
  if (input.description) {
    schema.description = input.description;
  }
  if (input.default !== undefined) {
    schema.default = input.default;
  }
  return schema;
}

function normalizeInputType(type: string): string | undefined {
  switch (type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "object":
    case "array":
      return type;
    default:
      return undefined;
  }
}

function outputContractToJsonSchema(contract: OutputContract): Readonly<Record<string, unknown>> {
  const properties = Object.fromEntries(
    Object.entries(contract).map(([key, entry]) => [key, outputContractEntryToJsonSchema(entry)]),
  );
  const required = Object.entries(contract)
    .filter(([, entry]) => outputContractEntryRequired(entry))
    .map(([key]) => key);
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function outputContractEntryToJsonSchema(entry: OutputContractEntry): Readonly<Record<string, unknown>> {
  if (typeof entry === "string") {
    return simpleJsonSchemaForType(entry);
  }
  const record = asRecord(entry) ?? {};
  const type = typeof record.type === "string" ? record.type : Array.isArray(record.enum) ? "string" : undefined;
  const schema: Record<string, unknown> = type ? simpleJsonSchemaForType(type) : {};
  if (typeof record.description === "string") {
    schema.description = record.description;
  }
  if (Array.isArray(record.enum) && record.enum.every((value) => typeof value === "string")) {
    schema.enum = record.enum;
  }
  if (type === "object" && schema.additionalProperties === undefined) {
    schema.additionalProperties = true;
  }
  if (type === "array" && schema.items === undefined) {
    schema.items = {};
  }
  return schema;
}

function simpleJsonSchemaForType(type: string): Record<string, unknown> {
  switch (type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return { type };
    case "array":
      return { type: "array", items: {} };
    case "object":
      return { type: "object", additionalProperties: true };
    default:
      return {};
  }
}

function outputContractEntryRequired(entry: OutputContractEntry): boolean {
  if (typeof entry === "string") {
    return true;
  }
  return entry.required !== false;
}

function validateFinalPayload(payload: unknown, contract: OutputContract | undefined): string | undefined {
  if (!contract) {
    return undefined;
  }
  const record = asRecord(payload);
  if (!record) {
    return `${FINAL_RESULT_TOOL_NAME} must receive a JSON object payload.`;
  }

  const unknownKeys = Object.keys(record).filter((key) => !(key in contract));
  if (unknownKeys.length > 0) {
    return `${FINAL_RESULT_TOOL_NAME} contained unexpected keys: ${unknownKeys.join(", ")}.`;
  }

  for (const [key, entry] of Object.entries(contract)) {
    const value = record[key];
    if (value === undefined) {
      if (outputContractEntryRequired(entry)) {
        return `${FINAL_RESULT_TOOL_NAME} is missing required field '${key}'.`;
      }
      continue;
    }
    const mismatch = validateOutputContractValue(value, entry, key);
    if (mismatch) {
      return mismatch;
    }
  }

  return undefined;
}

function validateOutputContractValue(
  value: unknown,
  entry: OutputContractEntry,
  key: string,
): string | undefined {
  const spec = typeof entry === "string" ? { type: entry } : entry;
  const expectedType = typeof spec.type === "string" ? spec.type : Array.isArray(spec.enum) ? "string" : undefined;
  if (Array.isArray(spec.enum) && (!isString(value) || !spec.enum.includes(value))) {
    return `'${key}' must be one of ${spec.enum.join(", ")}.`;
  }
  if (!expectedType) {
    return undefined;
  }

  const valid =
    (expectedType === "string" && typeof value === "string")
    || (expectedType === "number" && typeof value === "number" && Number.isFinite(value))
    || (expectedType === "integer" && Number.isInteger(value))
    || (expectedType === "boolean" && typeof value === "boolean")
    || (expectedType === "array" && Array.isArray(value))
    || (expectedType === "object" && isRecord(value))
    || (expectedType === "null" && value === null);
  return valid ? undefined : `'${key}' must be ${expectedType}.`;
}

function packetSchemaFromOutput(value: unknown): string | undefined {
  return isRecord(value) && typeof value.schema === "string" ? value.schema : undefined;
}

function unwrapPacketData(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if ("data" in value) {
    return value.data;
  }
  return value;
}

function parseJsonMaybe(value: string): unknown {
  if (!value.trim()) {
    return "";
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseJsonValue(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} must be valid JSON. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonObject(value: string, label: string): Readonly<Record<string, unknown>> {
  const parsed = parseJsonValue(value, label);
  const record = asRecord(parsed);
  if (!record) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return record;
}

function extractApiErrorMessage(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
    if (isRecord(parsed) && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    return bodyText.trim() || "request failed";
  }
  return bodyText.trim() || "request failed";
}

function sanitizeProviderToolName(toolName: string): string {
  const normalized = toolName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 64) || "tool";
}

function normalizeManagedAgentProvider(value: unknown): ManagedAgentProvider | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "openai" || normalized === "anthropic" ? normalized : undefined;
}

function normalizeRequestId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function parseConfiguredToolRoots(env: NodeJS.ProcessEnv | undefined): readonly string[] {
  return String(env?.RUNX_TOOL_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => path.resolve(value));
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.length > 0)));
}

function isToolErrorResult(value: unknown): boolean {
  return isRecord(value) && typeof value.error === "string";
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

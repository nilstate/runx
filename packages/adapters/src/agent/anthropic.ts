import type { CognitiveResolutionRequest } from "@runxhq/core/executor";

import {
  FINAL_RESULT_TOOL_NAME,
  anthropicVersion,
  maxManagedAgentRounds,
  type AnthropicMessage,
  type AnthropicResponseBody,
  type AnthropicTextBlock,
  type AnthropicToolDefinition,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type ManagedAgentExecutionDetails,
  type ManagedAgentPausedExecution,
  type ManagedRuntimeTool,
  type ManagedToolExecutionTrace,
} from "./types.js";
import {
  asRecord,
  extractApiErrorMessage,
  isToolErrorResult,
} from "./helpers.js";
import {
  outputContractToJsonSchema,
  validateFinalPayload,
} from "./json-schema.js";
import { executeManagedToolCall } from "./runtime-tools.js";
import { buildManagedRuntimeInstructions } from "./work-request.js";
import type { ManagedAgentConfig } from "./index.js";

export async function resolveWithAnthropic(
  config: ManagedAgentConfig,
  request: CognitiveResolutionRequest,
  runtimeTools: readonly ManagedRuntimeTool[],
  signal: AbortSignal | undefined,
  allowPauseOnNestedResolution: boolean,
): Promise<ManagedAgentExecutionDetails | ManagedAgentPausedExecution> {
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
      if (result.request && allowPauseOnNestedResolution) {
        return {
          request: result.request,
          rounds: round,
          toolCalls,
          tools: runtimeTools.map((tool) => tool.runxName),
          toolExecutions,
        };
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

function normalizeAnthropicAssistantContent(content: readonly unknown[] | undefined): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((item): item is Readonly<Record<string, unknown>> =>
    typeof item === "object" && item !== null && !Array.isArray(item));
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

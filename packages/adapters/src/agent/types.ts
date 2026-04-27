import type { ResolutionRequest, ResolutionResponse } from "@runxhq/core/executor";

export interface ManagedToolCallResult {
  readonly value: unknown;
  readonly trace?: ManagedToolExecutionTrace;
  readonly request?: ResolutionRequest;
}

export interface ManagedToolExecutionTrace {
  readonly tool: string;
  readonly status: "success" | "failure" | "policy_denied" | "needs_resolution";
  readonly receiptId?: string;
  readonly resolutionKind?: ResolutionRequest["kind"];
}

export interface ManagedRuntimeTool {
  readonly runxName: string;
  readonly providerName: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly invoke: (argumentsValue: unknown) => Promise<ManagedToolCallResult>;
}

export interface ManagedAgentExecutionTelemetry {
  readonly rounds: number;
  readonly toolCalls: number;
  readonly tools: readonly string[];
  readonly toolExecutions: readonly ManagedToolExecutionTrace[];
}

export interface ManagedAgentExecutionDetails extends ManagedAgentExecutionTelemetry {
  readonly response: ResolutionResponse;
}

export interface ManagedAgentPausedExecution extends ManagedAgentExecutionTelemetry {
  readonly request: ResolutionRequest;
}

export interface OpenAiToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

export interface OpenAiToolCall {
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolCallOutputItem {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string;
}

export interface OpenAiResponseBody {
  readonly output?: readonly unknown[];
}

export type OpenAiResponseInputItem =
  | Readonly<Record<string, unknown>>
  | ToolCallOutputItem;

export interface AnthropicToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

export interface AnthropicToolUseBlock extends Readonly<Record<string, unknown>> {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface AnthropicTextBlock extends Readonly<Record<string, unknown>> {
  readonly type: "text";
  readonly text: string;
}

export interface AnthropicToolResultBlock extends Readonly<Record<string, unknown>> {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly Readonly<Record<string, unknown>>[];
}

export interface AnthropicResponseBody {
  readonly content?: readonly unknown[];
}

export const FINAL_RESULT_TOOL_NAME = "submit_result";
export const anthropicVersion = "2023-06-01";
export const maxManagedAgentRounds = 24;

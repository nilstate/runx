import type { ResolutionRequest, ResolutionResponse } from "../../executor/src/index.js";
import type { AuthResolver, Caller, ExecutionEvent, RunLocalSkillResult } from "../../runner-local/src/index.js";

export interface FrameworkBridgeRunOptions {
  readonly skillPath: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly answersPath?: string;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly parentReceipt?: string;
  readonly contextFrom?: readonly string[];
  readonly caller?: Caller;
  readonly authResolver?: AuthResolver;
  readonly allowedSourceTypes?: readonly string[];
  readonly resumeFromRunId?: string;
}

export type FrameworkSkillExecutor = (
  options: FrameworkBridgeRunOptions & { readonly caller: Caller },
) => Promise<RunLocalSkillResult>;

export interface FrameworkBoundaryContext {
  readonly request: ResolutionRequest;
  readonly events: readonly ExecutionEvent[];
}

export type FrameworkBoundaryReply =
  | ResolutionResponse
  | {
      readonly actor?: "agent" | "human";
      readonly payload: unknown;
    }
  | boolean
  | string
  | number
  | Readonly<Record<string, unknown>>
  | undefined;

export type FrameworkBoundaryResolver = (
  context: FrameworkBoundaryContext,
) => Promise<FrameworkBoundaryReply> | FrameworkBoundaryReply;

export interface FrameworkBridgeOptions {
  readonly execute: FrameworkSkillExecutor;
}

export interface FrameworkPausedResult {
  readonly status: "paused";
  readonly skillName: string;
  readonly runId: string;
  readonly requests: readonly ResolutionRequest[];
  readonly stepIds?: readonly string[];
  readonly stepLabels?: readonly string[];
  readonly events: readonly ExecutionEvent[];
}

export interface FrameworkCompletedResult {
  readonly status: "completed";
  readonly skillName: string;
  readonly receiptId: string;
  readonly output: string;
  readonly events: readonly ExecutionEvent[];
}

export interface FrameworkFailedResult {
  readonly status: "failed";
  readonly skillName: string;
  readonly receiptId?: string;
  readonly error: string;
  readonly events: readonly ExecutionEvent[];
}

export interface FrameworkDeniedResult {
  readonly status: "denied";
  readonly skillName: string;
  readonly reasons: readonly string[];
  readonly receiptId?: string;
  readonly events: readonly ExecutionEvent[];
}

export type FrameworkRunResult =
  | FrameworkPausedResult
  | FrameworkCompletedResult
  | FrameworkFailedResult
  | FrameworkDeniedResult;

export interface FrameworkBridge {
  readonly run: (
    options: FrameworkBridgeRunOptions & {
      readonly resolver?: FrameworkBoundaryResolver;
    },
  ) => Promise<FrameworkRunResult>;
  readonly resume: (
    runId: string,
    options: Omit<FrameworkBridgeRunOptions, "resumeFromRunId"> & {
      readonly resolver?: FrameworkBoundaryResolver;
    },
  ) => Promise<FrameworkRunResult>;
}

export interface OpenAIAdapterResponse {
  readonly role: "tool";
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: {
    readonly runx: FrameworkRunResult;
  };
}

export interface AnthropicAdapterResponse {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly metadata: {
    readonly runx: FrameworkRunResult;
  };
}

export interface VercelAiAdapterResponse {
  readonly messages: readonly [{ readonly role: "assistant"; readonly content: string }];
  readonly data: {
    readonly runx: FrameworkRunResult;
  };
}

export interface LangChainAdapterResponse {
  readonly content: string;
  readonly additional_kwargs: {
    readonly runx: FrameworkRunResult;
  };
}

export interface CrewAiAdapterResponse {
  readonly raw: string;
  readonly json_dict: {
    readonly runx: FrameworkRunResult;
  };
}

export interface ProviderFrameworkAdapter<TResponse> {
  readonly run: (
    options: FrameworkBridgeRunOptions & {
      readonly resolver?: FrameworkBoundaryResolver;
    },
  ) => Promise<TResponse>;
  readonly resume: (
    runId: string,
    options: Omit<FrameworkBridgeRunOptions, "resumeFromRunId"> & {
      readonly resolver?: FrameworkBoundaryResolver;
    },
  ) => Promise<TResponse>;
}

export function createFrameworkBridge(options: FrameworkBridgeOptions): FrameworkBridge {
  const bridge: FrameworkBridge = {
    run: async (runOptions) => {
      const events: ExecutionEvent[] = [];
      const caller: Caller = {
        report: async (event) => {
          events.push(event);
          await runOptions.caller?.report(event);
        },
        resolve: async (request) => {
          const resolved = normalizeFrameworkReply(await runOptions.resolver?.({ request, events }), request);
          return resolved ?? await runOptions.caller?.resolve(request);
        },
      };

      const result = await options.execute({
        ...runOptions,
        caller,
      });
      return normalizeRunResult(result, events);
    },
    resume: async (runId, runOptions) => {
      return await bridge.run({
        ...runOptions,
        resumeFromRunId: runId,
      });
    },
  };
  return bridge;
}

export function createOpenAiAdapter(bridge: FrameworkBridge): ProviderFrameworkAdapter<OpenAIAdapterResponse> {
  return {
    run: async (options) => toOpenAiResponse(await bridge.run(options)),
    resume: async (runId, options) => toOpenAiResponse(await bridge.resume(runId, options)),
  };
}

export function createAnthropicAdapter(bridge: FrameworkBridge): ProviderFrameworkAdapter<AnthropicAdapterResponse> {
  return {
    run: async (options) => toAnthropicResponse(await bridge.run(options)),
    resume: async (runId, options) => toAnthropicResponse(await bridge.resume(runId, options)),
  };
}

export function createVercelAiAdapter(bridge: FrameworkBridge): ProviderFrameworkAdapter<VercelAiAdapterResponse> {
  return {
    run: async (options) => toVercelAiResponse(await bridge.run(options)),
    resume: async (runId, options) => toVercelAiResponse(await bridge.resume(runId, options)),
  };
}

export function createLangChainAdapter(bridge: FrameworkBridge): ProviderFrameworkAdapter<LangChainAdapterResponse> {
  return {
    run: async (options) => toLangChainResponse(await bridge.run(options)),
    resume: async (runId, options) => toLangChainResponse(await bridge.resume(runId, options)),
  };
}

export function createCrewAiAdapter(bridge: FrameworkBridge): ProviderFrameworkAdapter<CrewAiAdapterResponse> {
  return {
    run: async (options) => toCrewAiResponse(await bridge.run(options)),
    resume: async (runId, options) => toCrewAiResponse(await bridge.resume(runId, options)),
  };
}

function normalizeFrameworkReply(
  reply: FrameworkBoundaryReply,
  request: ResolutionRequest,
): ResolutionResponse | undefined {
  if (reply === undefined) {
    return undefined;
  }
  if (isResolutionResponse(reply)) {
    return reply;
  }
  if (typeof reply === "object" && reply !== null && "payload" in reply) {
    const candidate = reply as { readonly actor?: "agent" | "human"; readonly payload: unknown };
    return {
      actor: candidate.actor ?? defaultActorForRequest(request),
      payload: candidate.payload,
    };
  }
  if (typeof reply === "boolean" && request.kind === "approval") {
    return { actor: "human", payload: reply };
  }
  return {
    actor: defaultActorForRequest(request),
    payload: reply,
  };
}

function defaultActorForRequest(request: ResolutionRequest): "agent" | "human" {
  return request.kind === "cognitive_work" ? "agent" : "human";
}

function isResolutionResponse(value: unknown): value is ResolutionResponse {
  return typeof value === "object"
    && value !== null
    && "actor" in value
    && "payload" in value
    && (((value as { readonly actor?: unknown }).actor === "agent") || ((value as { readonly actor?: unknown }).actor === "human"));
}

function normalizeRunResult(result: RunLocalSkillResult, events: readonly ExecutionEvent[]): FrameworkRunResult {
  if (result.status === "needs_resolution") {
    return {
      status: "paused",
      skillName: result.skill.name,
      runId: result.runId,
      requests: result.requests,
      stepIds: result.stepIds,
      stepLabels: result.stepLabels,
      events,
    };
  }
  if (result.status === "policy_denied") {
    return {
      status: "denied",
      skillName: result.skill.name,
      reasons: result.reasons,
      receiptId: result.receipt?.id,
      events,
    };
  }
  if (result.status === "success") {
    return {
      status: "completed",
      skillName: result.skill.name,
      receiptId: result.receipt.id,
      output: result.execution.stdout,
      events,
    };
  }
  return {
    status: "failed",
    skillName: result.skill.name,
    receiptId: result.receipt.id,
    error: result.execution.errorMessage ?? (result.execution.stderr || result.execution.stdout),
    events,
  };
}

function toOpenAiResponse(result: FrameworkRunResult): OpenAIAdapterResponse {
  return {
    role: "tool",
    content: [{ type: "text", text: summarizeFrameworkResult(result) }],
    structuredContent: { runx: result },
  };
}

function toAnthropicResponse(result: FrameworkRunResult): AnthropicAdapterResponse {
  return {
    content: [{ type: "text", text: summarizeFrameworkResult(result) }],
    metadata: { runx: result },
  };
}

function toVercelAiResponse(result: FrameworkRunResult): VercelAiAdapterResponse {
  return {
    messages: [{ role: "assistant", content: summarizeFrameworkResult(result) }],
    data: { runx: result },
  };
}

function toLangChainResponse(result: FrameworkRunResult): LangChainAdapterResponse {
  return {
    content: summarizeFrameworkResult(result),
    additional_kwargs: { runx: result },
  };
}

function toCrewAiResponse(result: FrameworkRunResult): CrewAiAdapterResponse {
  return {
    raw: summarizeFrameworkResult(result),
    json_dict: { runx: result },
  };
}

function summarizeFrameworkResult(result: FrameworkRunResult): string {
  switch (result.status) {
    case "completed":
      return `${result.skillName} completed. Inspect receipt ${result.receiptId}.`;
    case "paused":
      return `${result.skillName} paused at ${result.runId}. Resume after resolving ${result.requests.length} request(s).`;
    case "denied":
      return `${result.skillName} was denied by policy.`;
    case "failed":
      return `${result.skillName} failed. Inspect receipt ${result.receiptId ?? "n/a"}.`;
  }
}

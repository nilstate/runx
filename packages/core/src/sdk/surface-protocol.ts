import type { ResolutionRequest, ResolutionResponse } from "../executor/index.js";
import { inspectLocalRunState } from "../runner-local/index.js";
import type { AuthResolver, Caller, ExecutionEvent, RunLocalSkillResult } from "../runner-local/index.js";

// Surface bridges let external hosts act as surfaces over the runx kernel.
// The host gets normalized run states; runx keeps ownership of execution,
// pause/resume, approvals, and receipts.
export interface SurfaceRunOptions {
  readonly skillPath: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly answersPath?: string;
  readonly runner?: string;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly parentReceipt?: string;
  readonly contextFrom?: readonly string[];
  readonly caller?: Caller;
  readonly authResolver?: AuthResolver;
  readonly allowedSourceTypes?: readonly string[];
  readonly resumeFromRunId?: string;
}

export type SurfaceSkillExecutor = (
  options: SurfaceRunOptions & { readonly caller: Caller },
) => Promise<RunLocalSkillResult>;

export interface SurfaceBoundaryContext {
  readonly request: ResolutionRequest;
  readonly events: readonly ExecutionEvent[];
}

export type SurfaceBoundaryReply =
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

export type SurfaceBoundaryResolver = (
  context: SurfaceBoundaryContext,
) => Promise<SurfaceBoundaryReply> | SurfaceBoundaryReply;

export interface SurfaceBridgeOptions {
  readonly execute: SurfaceSkillExecutor;
  readonly inspect?: SurfaceStateInspector;
}

export interface SurfacePausedResult {
  readonly status: "paused";
  readonly skillName: string;
  readonly runId: string;
  readonly requests: readonly ResolutionRequest[];
  readonly stepIds?: readonly string[];
  readonly stepLabels?: readonly string[];
  readonly events: readonly ExecutionEvent[];
}

export interface SurfaceCompletedResult {
  readonly status: "completed";
  readonly skillName: string;
  readonly receiptId: string;
  readonly output: string;
  readonly events: readonly ExecutionEvent[];
}

export interface SurfaceFailedResult {
  readonly status: "failed";
  readonly skillName: string;
  readonly receiptId?: string;
  readonly error: string;
  readonly events: readonly ExecutionEvent[];
}

export interface SurfaceEscalatedResult {
  readonly status: "escalated";
  readonly skillName: string;
  readonly receiptId: string;
  readonly error: string;
  readonly events: readonly ExecutionEvent[];
}

export interface SurfaceDeniedResult {
  readonly status: "denied";
  readonly skillName: string;
  readonly reasons: readonly string[];
  readonly receiptId?: string;
  readonly events: readonly ExecutionEvent[];
}

export type SurfaceRunResult =
  | SurfacePausedResult
  | SurfaceCompletedResult
  | SurfaceFailedResult
  | SurfaceEscalatedResult
  | SurfaceDeniedResult;

export interface SurfaceRunVerification {
  readonly status: "verified" | "unverified" | "invalid";
  readonly reason?: string;
}

export interface SurfaceRunLineage {
  readonly kind: "rerun";
  readonly sourceRunId: string;
  readonly sourceReceiptId?: string;
}

export interface SurfaceRunApproval {
  readonly gateId?: string;
  readonly gateType?: string;
  readonly decision?: "approved" | "denied";
  readonly reason?: string;
}

export interface SurfaceInspectOptions {
  readonly receiptDir?: string;
  readonly runxHome?: string;
}

export type SurfaceStateInspector = (
  referenceId: string,
  options?: SurfaceInspectOptions,
) => Promise<SurfaceRunState>;

export interface SurfacePausedState {
  readonly status: "paused";
  readonly skillName: string;
  readonly runId: string;
  readonly requestedPath?: string;
  readonly resolvedPath?: string;
  readonly selectedRunner?: string;
  readonly requests: readonly ResolutionRequest[];
  readonly stepIds?: readonly string[];
  readonly stepLabels?: readonly string[];
  readonly lineage?: SurfaceRunLineage;
}

interface SurfaceTerminalState {
  readonly kind: "skill_execution" | "graph_execution";
  readonly skillName: string;
  readonly runId: string;
  readonly receiptId: string;
  readonly verification: SurfaceRunVerification;
  readonly sourceType?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly disposition?: string;
  readonly outcomeState?: string;
  readonly actors?: readonly string[];
  readonly artifactTypes?: readonly string[];
  readonly runnerProvider?: string;
  readonly approval?: SurfaceRunApproval;
  readonly lineage?: SurfaceRunLineage;
}

export interface SurfaceCompletedState extends SurfaceTerminalState {
  readonly status: "completed";
}

export interface SurfaceFailedState extends SurfaceTerminalState {
  readonly status: "failed";
}

export interface SurfaceEscalatedState extends SurfaceTerminalState {
  readonly status: "escalated";
}

export interface SurfaceDeniedState extends SurfaceTerminalState {
  readonly status: "denied";
}

export type SurfaceRunState =
  | SurfacePausedState
  | SurfaceCompletedState
  | SurfaceFailedState
  | SurfaceEscalatedState
  | SurfaceDeniedState;

export interface SurfaceBridge {
  readonly run: (
    options: SurfaceRunOptions & {
      readonly resolver?: SurfaceBoundaryResolver;
    },
  ) => Promise<SurfaceRunResult>;
  readonly resume: (
    runId: string,
    options: Omit<SurfaceRunOptions, "resumeFromRunId" | "skillPath"> & {
      readonly skillPath?: string;
      readonly resolver?: SurfaceBoundaryResolver;
    },
  ) => Promise<SurfaceRunResult>;
  readonly inspect: (
    referenceId: string,
    options?: SurfaceInspectOptions,
  ) => Promise<SurfaceRunState>;
}

export interface OpenAISurfaceResponse {
  readonly role: "tool";
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: {
    readonly runx: SurfaceRunResult;
  };
}

export interface AnthropicSurfaceResponse {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly metadata: {
    readonly runx: SurfaceRunResult;
  };
}

export interface VercelAiSurfaceResponse {
  readonly messages: readonly [{ readonly role: "assistant"; readonly content: string }];
  readonly data: {
    readonly runx: SurfaceRunResult;
  };
}

export interface LangChainSurfaceResponse {
  readonly content: string;
  readonly additional_kwargs: {
    readonly runx: SurfaceRunResult;
  };
}

export interface CrewAiSurfaceResponse {
  readonly raw: string;
  readonly json_dict: {
    readonly runx: SurfaceRunResult;
  };
}

export interface ProviderSurfaceAdapter<TResponse> {
  readonly run: (
    options: SurfaceRunOptions & {
      readonly resolver?: SurfaceBoundaryResolver;
    },
  ) => Promise<TResponse>;
  readonly resume: (
    runId: string,
    options: Omit<SurfaceRunOptions, "resumeFromRunId" | "skillPath"> & {
      readonly skillPath?: string;
      readonly resolver?: SurfaceBoundaryResolver;
    },
  ) => Promise<TResponse>;
}

export function createSurfaceBridge(options: SurfaceBridgeOptions): SurfaceBridge {
  const bridge: SurfaceBridge = {
    run: async (runOptions) => {
      const events: ExecutionEvent[] = [];
      const caller: Caller = {
        report: async (event) => {
          events.push(event);
          await runOptions.caller?.report(event);
        },
        resolve: async (request) => {
          const resolved = normalizeSurfaceReply(await runOptions.resolver?.({ request, events }), request);
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
      const skillPath = runOptions.skillPath ?? await resolveSurfaceResumeSkillPath(runId, runOptions, options.inspect);
      return await bridge.run({
        ...runOptions,
        skillPath,
        resumeFromRunId: runId,
      });
    },
    inspect: async (referenceId, inspectOptions) => {
      if (!options.inspect) {
        throw new Error("This surface bridge does not support inspect().");
      }
      return await options.inspect(referenceId, inspectOptions);
    },
  };
  return bridge;
}

export function createOpenAiSurfaceAdapter(bridge: SurfaceBridge): ProviderSurfaceAdapter<OpenAISurfaceResponse> {
  return {
    run: async (options) => toOpenAiResponse(await bridge.run(options)),
    resume: async (runId, options) => toOpenAiResponse(await bridge.resume(runId, options)),
  };
}

export function createAnthropicSurfaceAdapter(bridge: SurfaceBridge): ProviderSurfaceAdapter<AnthropicSurfaceResponse> {
  return {
    run: async (options) => toAnthropicResponse(await bridge.run(options)),
    resume: async (runId, options) => toAnthropicResponse(await bridge.resume(runId, options)),
  };
}

export function createVercelAiSurfaceAdapter(bridge: SurfaceBridge): ProviderSurfaceAdapter<VercelAiSurfaceResponse> {
  return {
    run: async (options) => toVercelAiResponse(await bridge.run(options)),
    resume: async (runId, options) => toVercelAiResponse(await bridge.resume(runId, options)),
  };
}

export function createLangChainSurfaceAdapter(bridge: SurfaceBridge): ProviderSurfaceAdapter<LangChainSurfaceResponse> {
  return {
    run: async (options) => toLangChainResponse(await bridge.run(options)),
    resume: async (runId, options) => toLangChainResponse(await bridge.resume(runId, options)),
  };
}

export function createCrewAiSurfaceAdapter(bridge: SurfaceBridge): ProviderSurfaceAdapter<CrewAiSurfaceResponse> {
  return {
    run: async (options) => toCrewAiResponse(await bridge.run(options)),
    resume: async (runId, options) => toCrewAiResponse(await bridge.resume(runId, options)),
  };
}

function normalizeSurfaceReply(
  reply: SurfaceBoundaryReply,
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

function normalizeRunResult(result: RunLocalSkillResult, events: readonly ExecutionEvent[]): SurfaceRunResult {
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
  if (result.receipt.disposition === "escalated") {
    return {
      status: "escalated",
      skillName: result.skill.name,
      receiptId: result.receipt.id,
      error: result.execution.errorMessage ?? (result.execution.stderr || result.execution.stdout),
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

export async function inspectLocalSurfaceState(
  referenceId: string,
  options: SurfaceInspectOptions & {
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<SurfaceRunState> {
  const inspected = await inspectLocalRunState({
    referenceId,
    receiptDir: options.receiptDir,
    runxHome: options.runxHome,
    env: options.env,
  });
  if (inspected.status === "paused") {
    return {
      status: "paused",
      skillName: inspected.pending.skillName ?? deriveSkillNameFromPending(inspected.pending),
      runId: inspected.runId,
      requestedPath: inspected.pending.skillPath,
      resolvedPath: inspected.pending.resolvedSkillPath,
      selectedRunner: inspected.pending.selectedRunner,
      requests: inspected.pending.requests ?? [],
      stepIds: inspected.pending.stepIds,
      stepLabels: inspected.pending.stepLabels,
      lineage: inspected.pending.lineage,
    };
  }

  const status = inspectStatus(inspected.summary);
  return {
    status,
    kind: inspected.summary.kind,
    skillName: inspected.summary.name,
    runId: inspected.runId,
    receiptId: inspected.receipt.id,
    verification: inspected.verification,
    sourceType: inspected.summary.sourceType,
    startedAt: inspected.summary.startedAt,
    completedAt: inspected.summary.completedAt,
    disposition: inspected.summary.disposition,
    outcomeState: inspected.summary.outcomeState,
    actors: inspected.summary.actors,
    artifactTypes: inspected.summary.artifactTypes,
    runnerProvider: inspected.summary.runnerProvider,
    approval: inspected.summary.approval,
    lineage: inspected.summary.lineage,
  };
}

function inspectStatus(summary: {
  readonly status: string;
  readonly disposition?: string;
}): SurfaceCompletedState["status"] | SurfaceFailedState["status"] | SurfaceEscalatedState["status"] | SurfaceDeniedState["status"] {
  if (summary.disposition === "policy_denied") {
    return "denied";
  }
  if (summary.disposition === "escalated") {
    return "escalated";
  }
  return summary.status === "success" ? "completed" : "failed";
}

function deriveSkillNameFromPending(pending: {
  readonly skillName?: string;
  readonly skillPath?: string;
  readonly resolvedSkillPath?: string;
}): string {
  if (pending.skillName && pending.skillName.trim().length > 0) {
    return pending.skillName;
  }
  const candidate = pending.resolvedSkillPath ?? pending.skillPath;
  if (!candidate) {
    return "unknown";
  }
  const normalized = candidate.replace(/\\/g, "/");
  const trimmed = normalized.endsWith("/SKILL.md")
    ? normalized.slice(0, -"/SKILL.md".length)
    : normalized.endsWith(".md")
      ? normalized.slice(0, -".md".length)
      : normalized;
  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? "unknown";
}

async function resolveSurfaceResumeSkillPath(
  runId: string,
  options: SurfaceInspectOptions & {
    readonly skillPath?: string;
  },
  inspect?: SurfaceStateInspector,
): Promise<string> {
  if (options.skillPath) {
    return options.skillPath;
  }
  if (!inspect) {
    throw new Error(`Run '${runId}' cannot be resumed because this surface bridge cannot resolve pending skill paths.`);
  }
  const state = await inspect(runId, options);
  if (state.status !== "paused") {
    throw new Error(`Run '${runId}' is not paused and cannot be resumed.`);
  }
  const skillPath = state.requestedPath ?? state.resolvedPath;
  if (!skillPath) {
    throw new Error(`Run '${runId}' cannot be resumed because no pending skill path was recorded.`);
  }
  return skillPath;
}

function toOpenAiResponse(result: SurfaceRunResult): OpenAISurfaceResponse {
  return {
    role: "tool",
    content: [{ type: "text", text: summarizeSurfaceResult(result) }],
    structuredContent: { runx: result },
  };
}

function toAnthropicResponse(result: SurfaceRunResult): AnthropicSurfaceResponse {
  return {
    content: [{ type: "text", text: summarizeSurfaceResult(result) }],
    metadata: { runx: result },
  };
}

function toVercelAiResponse(result: SurfaceRunResult): VercelAiSurfaceResponse {
  return {
    messages: [{ role: "assistant", content: summarizeSurfaceResult(result) }],
    data: { runx: result },
  };
}

function toLangChainResponse(result: SurfaceRunResult): LangChainSurfaceResponse {
  return {
    content: summarizeSurfaceResult(result),
    additional_kwargs: { runx: result },
  };
}

function toCrewAiResponse(result: SurfaceRunResult): CrewAiSurfaceResponse {
  return {
    raw: summarizeSurfaceResult(result),
    json_dict: { runx: result },
  };
}

function summarizeSurfaceResult(result: SurfaceRunResult): string {
  switch (result.status) {
    case "completed":
      return `${result.skillName} completed. Inspect receipt ${result.receiptId}.`;
    case "paused":
      return `${result.skillName} paused at ${result.runId}. Resume after resolving ${result.requests.length} request(s).`;
    case "denied":
      return `${result.skillName} was denied by policy.`;
    case "escalated":
      return `${result.skillName} escalated. Inspect receipt ${result.receiptId}.`;
    case "failed":
      return `${result.skillName} failed. Inspect receipt ${result.receiptId ?? "n/a"}.`;
  }
}

import type { ResolutionRequest, ResolutionResponse } from "../executor/index.js";
import { inspectLocalRunState } from "../runner-local/index.js";
import type { AuthResolver, Caller, ExecutionEvent, RunLocalSkillResult } from "../runner-local/index.js";

// Host bridges let external runtimes host the runx kernel. Hosts get
// normalized run states while runx keeps ownership of execution, pause/resume,
// approvals, and receipts.
export interface HostRunOptions {
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

export type HostSkillExecutor = (
  options: HostRunOptions & { readonly caller: Caller },
) => Promise<RunLocalSkillResult>;

export interface HostBoundaryContext {
  readonly request: ResolutionRequest;
  readonly events: readonly ExecutionEvent[];
}

export type HostBoundaryReply =
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

export type HostBoundaryResolver = (
  context: HostBoundaryContext,
) => Promise<HostBoundaryReply> | HostBoundaryReply;

export interface HostBridgeOptions {
  readonly execute: HostSkillExecutor;
  readonly inspect?: HostStateInspector;
}

export interface HostPausedResult {
  readonly status: "paused";
  readonly skillName: string;
  readonly runId: string;
  readonly requests: readonly ResolutionRequest[];
  readonly stepIds?: readonly string[];
  readonly stepLabels?: readonly string[];
  readonly events: readonly ExecutionEvent[];
}

export interface HostCompletedResult {
  readonly status: "completed";
  readonly skillName: string;
  readonly receiptId: string;
  readonly output: string;
  readonly events: readonly ExecutionEvent[];
}

export interface HostFailedResult {
  readonly status: "failed";
  readonly skillName: string;
  readonly receiptId?: string;
  readonly error: string;
  readonly events: readonly ExecutionEvent[];
}

export interface HostEscalatedResult {
  readonly status: "escalated";
  readonly skillName: string;
  readonly receiptId: string;
  readonly error: string;
  readonly events: readonly ExecutionEvent[];
}

export interface HostDeniedResult {
  readonly status: "denied";
  readonly skillName: string;
  readonly reasons: readonly string[];
  readonly receiptId?: string;
  readonly events: readonly ExecutionEvent[];
}

export type HostRunResult =
  | HostPausedResult
  | HostCompletedResult
  | HostFailedResult
  | HostEscalatedResult
  | HostDeniedResult;

export interface HostRunVerification {
  readonly status: "verified" | "unverified" | "invalid";
  readonly reason?: string;
}

export interface HostRunLineage {
  readonly kind: "rerun";
  readonly sourceRunId: string;
  readonly sourceReceiptId?: string;
}

export interface HostRunApproval {
  readonly gateId?: string;
  readonly gateType?: string;
  readonly decision?: "approved" | "denied";
  readonly reason?: string;
}

export interface HostInspectOptions {
  readonly receiptDir?: string;
  readonly runxHome?: string;
}

export type HostStateInspector = (
  referenceId: string,
  options?: HostInspectOptions,
) => Promise<HostRunState>;

export interface HostPausedState {
  readonly status: "paused";
  readonly skillName: string;
  readonly runId: string;
  readonly requestedPath?: string;
  readonly resolvedPath?: string;
  readonly selectedRunner?: string;
  readonly requests: readonly ResolutionRequest[];
  readonly stepIds?: readonly string[];
  readonly stepLabels?: readonly string[];
  readonly lineage?: HostRunLineage;
}

interface HostTerminalState {
  readonly kind: "skill_execution" | "graph_execution";
  readonly skillName: string;
  readonly runId: string;
  readonly receiptId: string;
  readonly verification: HostRunVerification;
  readonly sourceType?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly disposition?: string;
  readonly outcomeState?: string;
  readonly actors?: readonly string[];
  readonly artifactTypes?: readonly string[];
  readonly runnerProvider?: string;
  readonly approval?: HostRunApproval;
  readonly lineage?: HostRunLineage;
}

export interface HostCompletedState extends HostTerminalState {
  readonly status: "completed";
}

export interface HostFailedState extends HostTerminalState {
  readonly status: "failed";
}

export interface HostEscalatedState extends HostTerminalState {
  readonly status: "escalated";
}

export interface HostDeniedState extends HostTerminalState {
  readonly status: "denied";
}

export type HostRunState =
  | HostPausedState
  | HostCompletedState
  | HostFailedState
  | HostEscalatedState
  | HostDeniedState;

export interface HostBridge {
  readonly run: (
    options: HostRunOptions & {
      readonly resolver?: HostBoundaryResolver;
    },
  ) => Promise<HostRunResult>;
  readonly resume: (
    runId: string,
    options: Omit<HostRunOptions, "resumeFromRunId" | "skillPath"> & {
      readonly skillPath?: string;
      readonly resolver?: HostBoundaryResolver;
    },
  ) => Promise<HostRunResult>;
  readonly inspect: (
    referenceId: string,
    options?: HostInspectOptions,
  ) => Promise<HostRunState>;
}

export function createHostBridge(options: HostBridgeOptions): HostBridge {
  const bridge: HostBridge = {
    run: async (runOptions) => {
      const events: ExecutionEvent[] = [];
      const caller: Caller = {
        report: async (event) => {
          events.push(event);
          await runOptions.caller?.report(event);
        },
        resolve: async (request) => {
          const resolved = normalizeHostReply(await runOptions.resolver?.({ request, events }), request);
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
      const skillPath = runOptions.skillPath ?? await resolveHostResumeSkillPath(runId, runOptions, options.inspect);
      return await bridge.run({
        ...runOptions,
        skillPath,
        resumeFromRunId: runId,
      });
    },
    inspect: async (referenceId, inspectOptions) => {
      if (!options.inspect) {
        throw new Error("This host bridge does not support inspect().");
      }
      return await options.inspect(referenceId, inspectOptions);
    },
  };
  return bridge;
}

function normalizeHostReply(
  reply: HostBoundaryReply,
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

function normalizeRunResult(result: RunLocalSkillResult, events: readonly ExecutionEvent[]): HostRunResult {
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

export async function inspectLocalHostState(
  referenceId: string,
  options: HostInspectOptions & {
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<HostRunState> {
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
}): HostCompletedState["status"] | HostFailedState["status"] | HostEscalatedState["status"] | HostDeniedState["status"] {
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

async function resolveHostResumeSkillPath(
  runId: string,
  options: HostInspectOptions & {
    readonly skillPath?: string;
  },
  inspect?: HostStateInspector,
): Promise<string> {
  if (options.skillPath) {
    return options.skillPath;
  }
  if (!inspect) {
    throw new Error(`Run '${runId}' cannot be resumed because this host bridge cannot resolve pending skill paths.`);
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

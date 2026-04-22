export const runnerLocalPackage = "@runx/runner-local";

export * from "./skill-install.js";

const runnerLocalModuleDirectory = path.dirname(fileURLToPath(import.meta.url));

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createA2aAdapter, createFixtureA2aTransport } from "../../adapters/a2a/src/index.js";
import {
  appendJournalEntries,
  createReceiptLinkEntry,
  createRunEventEntry,
  materializeArtifacts,
  readJournalEntries,
  SYSTEM_ARTIFACT_TYPES,
  type ArtifactContract,
  type ArtifactEnvelope,
} from "../../artifacts/src/index.js";
import { runFanout } from "./fanout.js";
import { createCliToolAdapter } from "../../adapters/cli-tool/src/index.js";
import { createMcpAdapter } from "../../adapters/mcp/src/index.js";
import {
  executeSkill,
  type AgentContextProvenance,
  type AdapterInvokeResult,
  type AgentWorkRequest,
  type ApprovalGate,
  type CredentialEnvelope,
  type ProjectConventions,
  type ProjectMemory,
  type Question,
  type ResolutionRequest,
  type ResolutionResponse,
  type SkillAdapter,
  validateOutputContract,
} from "../../executor/src/index.js";
import { createFileJournalStore } from "../../memory/src/index.js";
import { resolveLocalSkillProfile, resolveRunxJournalDir } from "../../config/src/index.js";
import {
  parseGraphYaml,
  parseRunnerManifestYaml,
  parseSkillMarkdown,
  parseToolManifestYaml,
  resolvePostRunReflectPolicy,
  validateGraph,
  validateSkillArtifactContract,
  validateRunnerManifest,
  validateSkillSource,
  validateSkill,
  validateToolManifest,
  type ExecutionGraph,
  type GraphPolicy,
  type GraphStep,
  type PostRunReflectPolicy,
  type SkillInput,
  type SkillRunnerDefinition,
  type SkillSandbox,
  type ValidatedTool,
  type ValidatedSkill,
} from "../../parser/src/index.js";
import {
  admitGraphStepScopes,
  admitLocalSkill,
  admitRetryPolicy,
  sandboxRequiresApproval,
  type GraphScopeGrant,
  type LocalAdmissionGrant,
} from "../../policy/src/index.js";
import {
  hashString,
  hashStable,
  listLocalReceipts,
  listVerifiedLocalReceipts,
  readVerifiedLocalReceipt,
  uniqueReceiptId,
  writeLocalGraphReceipt,
  writeLocalReceipt,
  type GraphReceiptStep,
  type GraphReceiptSyncPoint,
  type ExecutionSemantics,
  type GovernedDisposition,
  type LocalGraphReceipt,
  type LocalReceipt,
  type LocalSkillReceipt,
  type OutcomeState,
  type ReceiptVerification,
  type ReceiptInputContext,
  type ReceiptOutcome,
  type ReceiptSurfaceRef,
} from "../../receipts/src/index.js";
import {
  createSingleStepState,
  createSequentialGraphState,
  evaluateFanoutSync,
  planSequentialGraphTransition,
  transitionSequentialGraph,
  transitionSingleStep,
  type FanoutSyncDecision,
  type SequentialGraphPlan,
  type SequentialGraphState,
  type SingleStepState,
} from "../../state-machine/src/index.js";
import type { RegistryStore } from "../../registry/src/index.js";
import {
  defaultRegistrySkillCacheDir,
  isRegistryRef,
  materializeRegistrySkill,
} from "./registry-resolver.js";

export interface ApprovalDecision {
  readonly gate: ApprovalGate;
  readonly approved: boolean;
}

export interface ExecutionEvent {
  readonly type:
    | "skill_loaded"
    | "inputs_resolved"
    | "auth_resolved"
    | "resolution_requested"
    | "resolution_resolved"
    | "admitted"
    | "executing"
    | "step_started"
    | "step_waiting_resolution"
    | "step_completed"
    | "warning"
    | "completed";
  readonly message: string;
  readonly data?: unknown;
}

export interface Caller {
  readonly resolve: (request: ResolutionRequest) => Promise<ResolutionResponse | undefined>;
  readonly report: (event: ExecutionEvent) => void | Promise<void>;
}

export interface RunLocalSkillOptions {
  readonly skillPath: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly answersPath?: string;
  readonly caller: Caller;
  readonly env?: NodeJS.ProcessEnv;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly parentReceipt?: string;
  readonly contextFrom?: readonly string[];
  readonly adapters?: readonly SkillAdapter[];
  readonly allowedSourceTypes?: readonly string[];
  readonly runner?: string;
  readonly journalDir?: string;
  readonly authResolver?: AuthResolver;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
  readonly resumeFromRunId?: string;
  readonly executionSemantics?: ExecutionSemantics;
  readonly registryStore?: RegistryStore;
  readonly skillCacheDir?: string;
  readonly projectMemory?: ProjectMemory;
  readonly projectConventions?: ProjectConventions;
}

interface ResolvedRunnerSelection {
  readonly skill: ValidatedSkill;
  readonly selectedRunnerName?: string;
}

async function resolveCallerRequest(
  caller: Caller,
  request: ResolutionRequest,
): Promise<ResolutionResponse | undefined> {
  return await caller.resolve(request);
}

interface RunResolvedSkillOptions {
  readonly skill: ValidatedSkill;
  readonly skillDirectory: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly caller: Caller;
  readonly env?: NodeJS.ProcessEnv;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly journalDir?: string;
  readonly parentReceipt?: string;
  readonly contextFrom?: readonly string[];
  readonly adapters?: readonly SkillAdapter[];
  readonly allowedSourceTypes?: readonly string[];
  readonly authResolver?: AuthResolver;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
  readonly resumeFromRunId?: string;
  readonly skillPathForMissingContext?: string;
  readonly orchestrationRunId?: string;
  readonly orchestrationStepId?: string;
  readonly currentContext?: readonly MaterializedContextEdge[];
  readonly executionSemantics?: ExecutionSemantics;
  readonly registryStore?: RegistryStore;
  readonly skillCacheDir?: string;
  readonly projectMemory?: ProjectMemory;
  readonly projectConventions?: ProjectConventions;
  readonly selectedRunnerName?: string;
}

export interface AuthResolver {
  readonly resolveGrants: (request: AuthGrantRequest) => Promise<AuthGrantResolution | undefined>;
  readonly resolveCredential: (request: AuthCredentialRequest) => Promise<AuthCredentialResolution | undefined>;
}

export interface AuthGrantRequest {
  readonly skill: ValidatedSkill;
  readonly inputs: Readonly<Record<string, unknown>>;
}

export interface AuthGrantResolution {
  readonly grants: readonly LocalAdmissionGrant[];
}

export interface AuthCredentialRequest extends AuthGrantRequest {
  readonly grants: readonly LocalAdmissionGrant[];
}

export interface AuthCredentialResolution {
  readonly credential?: CredentialEnvelope;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
}

interface ResolvedSkillReference {
  readonly requestedPath: string;
  readonly skillPath: string;
  readonly skillDirectory: string;
}

interface ResolvedToolReference {
  readonly requestedName: string;
  readonly toolName: string;
  readonly toolPath: string;
  readonly toolDirectory: string;
}

function graphStepExecutionDirectory(step: GraphStep, stepExecutablePath: string, graphDirectory: string): string {
  return step.skill || step.tool ? path.dirname(stepExecutablePath) : graphDirectory;
}

async function reportGraphStepStarted(caller: Caller, step: GraphStep, reference: string): Promise<void> {
  await caller.report({
    type: "step_started",
    message: `Starting step ${step.id}.`,
    data: {
      stepId: step.id,
      stepLabel: step.label,
      skill: reference,
      runner: graphStepRunner(step) ?? "default",
    },
  });
}

async function reportGraphStepWaitingResolution(
  caller: Caller,
  step: GraphStep,
  reference: string,
  requests: readonly ResolutionRequest[],
): Promise<void> {
  await caller.report({
    type: "step_waiting_resolution",
    message: `Step ${step.id} needs resolution.`,
    data: {
      stepId: step.id,
      stepLabel: step.label,
      skill: reference,
      runner: graphStepRunner(step) ?? "default",
      kinds: Array.from(new Set(requests.map((request) => request.kind))),
      requestIds: requests.map((request) => request.id),
      resolutionSkills: Array.from(
        new Set(
          requests
            .filter((request): request is Extract<ResolutionRequest, { kind: "cognitive_work" }> => request.kind === "cognitive_work")
            .map((request) => request.work.envelope.skill),
        ),
      ),
      expectedOutputs: Array.from(
        new Set(
          requests
            .filter((request): request is Extract<ResolutionRequest, { kind: "cognitive_work" }> => request.kind === "cognitive_work")
            .flatMap((request) => Object.keys(request.work.envelope.expected_outputs ?? {})),
        ),
      ),
    },
  });
}

async function reportGraphStepCompleted(
  caller: Caller,
  step: GraphStep,
  reference: string,
  status: "success" | "failure",
  detail?: Readonly<Record<string, unknown>>,
): Promise<void> {
  await caller.report({
    type: "step_completed",
    message: `Step ${step.id} ${status}.`,
    data: {
      stepId: step.id,
      stepLabel: step.label,
      skill: reference,
      runner: graphStepRunner(step) ?? "default",
      status,
      ...detail,
    },
  });
}

export type RunLocalSkillResult =
  | {
      readonly status: "needs_resolution";
      readonly skill: ValidatedSkill;
      readonly skillPath: string;
      readonly inputs: Readonly<Record<string, unknown>>;
      readonly runId: string;
      readonly requests: readonly ResolutionRequest[];
      readonly stepIds?: readonly string[];
      readonly stepLabels?: readonly string[];
    }
  | {
      readonly status: "policy_denied";
      readonly skill: ValidatedSkill;
      readonly reasons: readonly string[];
      readonly approval?: ApprovalDecision;
      readonly receipt?: LocalSkillReceipt;
    }
  | {
      readonly status: "success" | "failure";
      readonly skill: ValidatedSkill;
      readonly inputs: Readonly<Record<string, unknown>>;
      readonly execution: AdapterInvokeResult;
      readonly state: SingleStepState;
      readonly receipt: LocalReceipt;
    };

export interface RunLocalGraphOptions {
  readonly graphPath?: string;
  readonly graph?: ExecutionGraph;
  readonly graphDirectory?: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly caller: Caller;
  readonly env?: NodeJS.ProcessEnv;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly adapters?: readonly SkillAdapter[];
  readonly allowedSourceTypes?: readonly string[];
  readonly authResolver?: AuthResolver;
  readonly graphGrant?: GraphScopeGrant;
  readonly runId?: string;
  readonly skillEnvironment?: {
    readonly name: string;
    readonly body: string;
  };
  readonly resumeFromRunId?: string;
  readonly executionSemantics?: ExecutionSemantics;
  readonly registryStore?: RegistryStore;
  readonly skillCacheDir?: string;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
  readonly projectMemory?: ProjectMemory;
  readonly projectConventions?: ProjectConventions;
  readonly journalDir?: string;
  readonly selectedRunnerName?: string;
  readonly postRunReflectPolicy?: PostRunReflectPolicy;
}

export interface GraphStepRun {
  readonly stepId: string;
  readonly skill: string;
  readonly skillPath: string;
  readonly runner?: string;
  readonly attempt: number;
  readonly status: "success" | "failure";
  readonly receiptId?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly parentReceipt?: string;
  readonly fanoutGroup?: string;
  readonly retry?: RetryReceiptContext;
  readonly contextFrom: readonly {
    readonly input: string;
    readonly fromStep: string;
    readonly output: string;
    readonly receiptId?: string;
  }[];
  readonly governance?: GraphStepGovernance;
  readonly artifactIds?: readonly string[];
  readonly disposition?: GovernedDisposition;
  readonly inputContext?: ReceiptInputContext;
  readonly outcomeState?: OutcomeState;
  readonly outcome?: ReceiptOutcome;
  readonly surfaceRefs?: readonly ReceiptSurfaceRef[];
  readonly evidenceRefs?: readonly ReceiptSurfaceRef[];
}

interface NormalizedExecutionSemantics {
  readonly disposition: GovernedDisposition;
  readonly inputContext?: ReceiptInputContext;
  readonly outcomeState: OutcomeState;
  readonly outcome?: ReceiptOutcome;
  readonly surfaceRefs?: readonly ReceiptSurfaceRef[];
  readonly evidenceRefs?: readonly ReceiptSurfaceRef[];
}

const DEFAULT_INPUT_CONTEXT_MAX_BYTES = 4096;

function normalizeExecutionSemantics(
  semantics: ExecutionSemantics | undefined,
  inputs: Readonly<Record<string, unknown>>,
): NormalizedExecutionSemantics {
  return {
    disposition: semantics?.disposition ?? "completed",
    inputContext: captureInputContext(semantics?.input_context, inputs),
    outcomeState: semantics?.outcome_state ?? "complete",
    outcome: semantics?.outcome,
    surfaceRefs: normalizeSurfaceRefs(semantics?.surface_refs),
    evidenceRefs: normalizeSurfaceRefs(semantics?.evidence_refs),
  };
}

function mergeExecutionSemantics(
  base: ExecutionSemantics | undefined,
  override: ExecutionSemantics | undefined,
): ExecutionSemantics | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }

  return {
    disposition: override.disposition ?? base.disposition,
    outcome_state: override.outcome_state ?? base.outcome_state,
    outcome: override.outcome ?? base.outcome,
    input_context: override.input_context ?? base.input_context,
    surface_refs: override.surface_refs ?? base.surface_refs,
    evidence_refs: override.evidence_refs ?? base.evidence_refs,
  };
}

function captureInputContext(
  directive: ExecutionSemantics["input_context"] | undefined,
  inputs: Readonly<Record<string, unknown>>,
): ReceiptInputContext | undefined {
  if (!directive) {
    return undefined;
  }

  const snapshotSource = directive.snapshot ?? inputs;
  if (directive.capture === false && directive.snapshot === undefined) {
    return undefined;
  }

  const redacted = sanitizeInputContextValue(snapshotSource);
  const serialized = JSON.stringify(redacted);
  const bytes = Buffer.byteLength(serialized);
  const maxBytes = directive.max_bytes ?? DEFAULT_INPUT_CONTEXT_MAX_BYTES;
  return {
    source: directive.source ?? "inputs",
    snapshot: bytes <= maxBytes ? redacted : undefined,
    preview: bytes <= maxBytes ? undefined : serialized.slice(0, maxBytes),
    bytes,
    max_bytes: maxBytes,
    truncated: bytes > maxBytes,
    value_hash: hashStable(redacted),
  };
}

function normalizeSurfaceRefs(
  refs: readonly ReceiptSurfaceRef[] | undefined,
): readonly ReceiptSurfaceRef[] | undefined {
  if (!refs || refs.length === 0) {
    return undefined;
  }
  return refs.map((ref) => ({
    type: ref.type,
    uri: ref.uri,
    label: ref.label,
  }));
}

function sanitizeInputContextValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeInputContextValue(entry));
  }
  if (typeof value === "string") {
    return "[redacted]";
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSensitiveInputContextKey(key) ? "[redacted]" : sanitizeInputContextValue(entry),
    ]),
  );
}

function isSensitiveInputContextKey(key: string): boolean {
  return /(access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|raw[_-]?secret|raw[_-]?token)/i.test(
    key,
  );
}

interface GraphStepGovernance {
  readonly scopeAdmission: {
    readonly status: "allow" | "deny";
    readonly requestedScopes: readonly string[];
    readonly grantedScopes: readonly string[];
    readonly grantId?: string;
    readonly reasons?: readonly string[];
  };
}

interface RetryReceiptContext {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly ruleFired: string;
  readonly idempotencyKeyHash?: string;
}

export type RunLocalGraphResult =
  | {
      readonly status: "needs_resolution";
      readonly graph: ExecutionGraph;
      readonly skillPath: string;
      readonly stepIds: readonly string[];
      readonly requests: readonly ResolutionRequest[];
      readonly skill: ValidatedSkill;
      readonly state: SequentialGraphState;
      readonly runId: string;
      readonly stepLabels?: readonly string[];
    }
  | {
      readonly status: "policy_denied";
      readonly graph: ExecutionGraph;
      readonly stepId: string;
      readonly skill: ValidatedSkill;
      readonly reasons: readonly string[];
      readonly state: SequentialGraphState;
      readonly receipt?: LocalGraphReceipt;
    }
  | {
      readonly status: "success" | "failure";
      readonly graph: ExecutionGraph;
      readonly state: SequentialGraphState;
      readonly steps: readonly GraphStepRun[];
      readonly receipt: LocalGraphReceipt;
      readonly output: string;
      readonly errorMessage?: string;
    };

export interface InspectLocalGraphOptions {
  readonly graphId: string;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface InspectLocalReceiptOptions {
  readonly receiptId: string;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface InspectLocalReceiptResult {
  readonly receipt: LocalReceipt;
  readonly verification: ReceiptVerification;
  readonly summary: LocalReceiptSummary;
}

export interface ListLocalHistoryOptions {
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly limit?: number;
  readonly query?: string;
  readonly skill?: string;
  readonly status?: string;
  readonly sourceType?: string;
  readonly sinceMs?: number;
  readonly untilMs?: number;
}

export interface ListLocalHistoryResult {
  readonly receipts: readonly LocalReceiptSummary[];
}

export interface LocalReceiptSummary {
  readonly id: string;
  readonly kind: LocalReceipt["kind"];
  readonly status: LocalReceipt["status"];
  readonly verification: ReceiptVerification;
  readonly name: string;
  readonly sourceType?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface InspectLocalGraphResult {
  readonly receipt: LocalGraphReceipt;
  readonly verification: ReceiptVerification;
  readonly summary: {
    readonly id: string;
    readonly name: string;
    readonly status: "success" | "failure";
    readonly verification: ReceiptVerification;
    readonly steps: readonly {
      readonly id: string;
      readonly attempt: number;
      readonly status: "success" | "failure";
      readonly receiptId?: string;
      readonly fanoutGroup?: string;
    }[];
    readonly syncPoints: readonly {
      readonly groupId: string;
      readonly decision: "proceed" | "halt" | "pause" | "escalate";
      readonly ruleFired: string;
      readonly reason: string;
    }[];
  };
}

export function createCallerAgentStepAdapter(caller: Caller): SkillAdapter {
  return {
    type: "agent-step",
    invoke: async (request) => {
      const startedAt = Date.now();
      const mediationRequest = buildAgentStepRequest(request);
      const resolutionRequest: ResolutionRequest = {
        id: mediationRequest.id,
        kind: "cognitive_work",
        work: mediationRequest,
      };
      await caller.report({
        type: "resolution_requested",
        message: `Resolution requested for ${mediationRequest.id}.`,
        data: { kind: resolutionRequest.kind, requestId: resolutionRequest.id },
      });
      const resolution = await resolveCallerRequest(caller, resolutionRequest);

      if (resolution === undefined || resolution.payload === undefined || resolution.payload === null || resolution.payload === "") {
        return {
          status: "needs_resolution",
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          durationMs: Date.now() - startedAt,
          request: resolutionRequest,
          metadata: {
            agent_hook: {
              source_type: "agent-step",
              agent: request.source.agent,
              task: request.source.task,
              route: "yielded",
              status: "needs_resolution",
            },
          },
        };
      }

      await caller.report({
        type: "resolution_resolved",
        message: `Resolution satisfied for ${mediationRequest.id}.`,
        data: { kind: resolutionRequest.kind, requestId: resolutionRequest.id, actor: resolution.actor },
      });

      return {
        status: "success",
        stdout: typeof resolution.payload === "string" ? resolution.payload : JSON.stringify(resolution.payload),
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: Date.now() - startedAt,
        metadata: {
          agent_hook: {
            source_type: "agent-step",
            agent: request.source.agent,
            task: request.source.task,
            route: "provided",
            status: "success",
          },
        },
      };
    },
  };
}

export function createCallerAgentAdapter(caller: Caller): SkillAdapter {
  return {
    type: "agent",
    invoke: async (request) => {
      const startedAt = Date.now();
      const mediationRequest = buildAgentRunnerRequest(request);
      const resolutionRequest: ResolutionRequest = {
        id: mediationRequest.id,
        kind: "cognitive_work",
        work: mediationRequest,
      };
      await caller.report({
        type: "resolution_requested",
        message: `Resolution requested for ${mediationRequest.id}.`,
        data: { kind: resolutionRequest.kind, requestId: resolutionRequest.id },
      });
      const resolution = await resolveCallerRequest(caller, resolutionRequest);

      if (resolution === undefined || resolution.payload === undefined || resolution.payload === null || resolution.payload === "") {
        return {
          status: "needs_resolution",
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          durationMs: Date.now() - startedAt,
          request: resolutionRequest,
          metadata: {
            agent_runner: {
              skill: mediationRequest.envelope.skill,
              route: "yielded",
              status: "needs_resolution",
            },
          },
        };
      }

      await caller.report({
        type: "resolution_resolved",
        message: `Resolution satisfied for ${mediationRequest.id}.`,
        data: { kind: resolutionRequest.kind, requestId: resolutionRequest.id, actor: resolution.actor },
      });

      return {
        status: "success",
        stdout: typeof resolution.payload === "string" ? resolution.payload : JSON.stringify(resolution.payload),
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: Date.now() - startedAt,
        metadata: {
          agent_runner: {
            skill: mediationRequest.envelope.skill,
            route: "provided",
            status: "success",
          },
        },
      };
    },
  };
}

export function createCallerApprovalAdapter(caller: Caller): SkillAdapter {
  return {
    type: "approval",
    invoke: async (request) => {
      const startedAt = Date.now();
      const gate = buildApprovalGate(request);
      const resolutionRequest: ResolutionRequest = {
        id: gate.id,
        kind: "approval",
        gate,
      };
      await caller.report({
        type: "resolution_requested",
        message: `Resolution requested for ${gate.id}.`,
        data: { kind: resolutionRequest.kind, requestId: resolutionRequest.id },
      });
      const resolution = await resolveCallerRequest(caller, resolutionRequest);

      if (resolution === undefined) {
        return {
          status: "needs_resolution",
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          durationMs: Date.now() - startedAt,
          request: resolutionRequest,
          metadata: {
            approval: {
              gate_id: gate.id,
              gate_type: gate.type,
              decision: "pending",
              reason: gate.reason,
              summary: gate.summary,
            },
          },
        };
      }
      const approved = typeof resolution.payload === "boolean" ? resolution.payload : Boolean(resolution.payload);
      await caller.report({
        type: "resolution_resolved",
        message: `Resolution satisfied for ${gate.id}.`,
        data: { kind: resolutionRequest.kind, requestId: resolutionRequest.id, actor: resolution.actor, approved },
      });

      return {
        status: "success",
        stdout: JSON.stringify({
          approved,
          reason: gate.reason,
          conditions: [],
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: Date.now() - startedAt,
        metadata: {
          approval: {
            gate_id: gate.id,
            gate_type: gate.type,
            decision: approved ? "approved" : "denied",
            reason: gate.reason,
            summary: gate.summary,
          },
        },
      };
    },
  };
}

export async function runLocalSkill(options: RunLocalSkillOptions): Promise<RunLocalSkillResult> {
  const runId = options.resumeFromRunId ?? uniqueReceiptId("rx");
  const resolvedSkill = await resolveSkillReference(options.skillPath);
  const rawMarkdown = await readFile(resolvedSkill.skillPath, "utf8");
  const rawSkill = parseSkillMarkdown(rawMarkdown);
  const resumedRunnerName =
    options.runner || !options.resumeFromRunId
      ? undefined
      : await readResumedSelectedRunner(options.receiptDir ?? defaultReceiptDir(options.env), options.resumeFromRunId);
  const runnerSelection = await resolveSkillRunner(
    validateSkill(rawSkill, { mode: "strict" }),
    resolvedSkill.skillPath,
    options.runner ?? resumedRunnerName,
  );
  const skill = runnerSelection.skill;

  await options.caller.report({
    type: "skill_loaded",
    message: `Loaded skill ${skill.name}.`,
    data: { skillPath: resolvedSkill.skillPath, requestedPath: resolvedSkill.requestedPath },
  });

  const inputResolution = await resolveInputs(skill, options);
  if (inputResolution.status === "needs_resolution") {
    const pendingResult = {
      status: "needs_resolution",
      skill,
      skillPath: resolvedSkill.skillPath,
      inputs: options.inputs ?? {},
      runId,
      requests: [inputResolution.request],
    } satisfies Extract<RunLocalSkillResult, { readonly status: "needs_resolution" }>;
    await appendPendingSkillJournalEntries({
      receiptDir: options.receiptDir ?? defaultReceiptDir(options.env),
      runId: pendingResult.runId,
      skill,
      startedAt: new Date().toISOString(),
      kind: "resolution_requested",
      detail: {
        skill_path: resolvedSkill.requestedPath,
        selected_runner: runnerSelection.selectedRunnerName,
        request_ids: [inputResolution.request.id],
        resolution_kinds: [inputResolution.request.kind],
        step_ids: [],
        step_labels: [],
        inputs: pendingResult.inputs,
      },
      includeRunStarted: !options.resumeFromRunId,
    });
    return pendingResult;
  }

  await options.caller.report({
    type: "inputs_resolved",
    message: `Resolved ${Object.keys(inputResolution.inputs).length} input(s).`,
  });

  const result = await runResolvedSkill({
    skill,
    skillDirectory: resolvedSkill.skillDirectory,
    inputs: inputResolution.inputs,
    caller: options.caller,
    env: options.env,
    receiptDir: options.receiptDir,
    runxHome: options.runxHome,
    journalDir: options.journalDir,
    parentReceipt: options.parentReceipt,
    contextFrom: options.contextFrom,
    adapters: options.adapters,
    allowedSourceTypes: options.allowedSourceTypes,
    authResolver: options.authResolver,
    receiptMetadata: options.receiptMetadata,
    resumeFromRunId: runId,
    skillPathForMissingContext: resolvedSkill.skillPath,
    executionSemantics: options.executionSemantics,
    registryStore: options.registryStore,
    skillCacheDir: options.skillCacheDir,
    projectMemory: options.projectMemory,
    projectConventions: options.projectConventions,
    selectedRunnerName: runnerSelection.selectedRunnerName,
  });

  if (result.status === "needs_resolution") {
    const pendingResult = {
      ...result,
      inputs: inputResolution.inputs,
    } satisfies Extract<RunLocalSkillResult, { readonly status: "needs_resolution" }>;
    await appendPendingSkillJournalEntries({
      receiptDir: options.receiptDir ?? defaultReceiptDir(options.env),
      runId: pendingResult.runId,
      skill,
      startedAt: new Date().toISOString(),
      kind: "resolution_requested",
      detail: {
        skill_path: resolvedSkill.requestedPath,
        selected_runner: runnerSelection.selectedRunnerName,
        request_ids: pendingResult.requests.map((request) => request.id),
        resolution_kinds: Array.from(new Set(pendingResult.requests.map((request) => request.kind))),
        step_ids: pendingResult.stepIds ?? [],
        step_labels: pendingResult.stepLabels ?? [],
        inputs: pendingResult.inputs,
      },
      includeRunStarted: !options.resumeFromRunId,
    });
    return pendingResult;
  }

  return result;
}

async function runResolvedSkill(options: RunResolvedSkillOptions): Promise<RunLocalSkillResult> {
  const { skill } = options;
  const runId = options.resumeFromRunId ?? uniqueReceiptId("rx");
  const contextEnvelopeRunId = options.orchestrationRunId ?? runId;
  const projectMemory =
    options.projectMemory
    ?? (await loadProjectMemory({
      inputs: options.inputs,
      env: options.env,
      fallbackStart: options.skillDirectory,
    }));
  const projectConventions =
    options.projectConventions
    ?? (await loadProjectConventions({
      inputs: options.inputs,
      env: options.env,
      fallbackStart: options.skillDirectory,
    }));
  const inheritedReceiptMetadata = mergeMetadata(
    projectMemoryReceiptMetadata(projectMemory),
    projectConventionsReceiptMetadata(projectConventions),
    options.receiptMetadata,
  );
  const executionSemantics = normalizeExecutionSemantics(
    mergeExecutionSemantics(skill.execution, options.executionSemantics),
    options.inputs,
  );

  const structuralAdmission = admitLocalSkill(skill, {
    allowedSourceTypes: options.allowedSourceTypes,
    skipConnectedAuth: true,
    skipSandboxEscalation: true,
  });
  if (structuralAdmission.status === "deny") {
    return {
      status: "policy_denied",
      skill,
      reasons: structuralAdmission.reasons,
    };
  }

  const grantResolution = await options.authResolver?.resolveGrants({
    skill,
    inputs: options.inputs,
  });
  if (grantResolution) {
    await options.caller.report({
      type: "auth_resolved",
      message: `Resolved ${grantResolution.grants.length} auth grant(s).`,
    });
  }

  const sandboxApproval = await approveSandboxEscalationIfNeeded(skill, options.caller);
  const approvedSandboxEscalation = sandboxApproval?.approved ?? false;

  const admission = admitLocalSkill(skill, {
    allowedSourceTypes: options.allowedSourceTypes,
    connectedGrants: grantResolution?.grants,
    approvedSandboxEscalation,
  });
  if (admission.status === "deny") {
    const receipt =
      sandboxApproval && !sandboxApproval.approved
        ? await writeApprovalDeniedReceipt({
            skill,
            inputs: options.inputs,
            reasons: admission.reasons,
            approval: sandboxApproval,
            runOptions: options,
            receiptMetadata: inheritedReceiptMetadata,
            executionSemantics,
          })
        : undefined;
    return {
      status: "policy_denied",
      skill,
      reasons: admission.reasons,
      approval: sandboxApproval && !sandboxApproval.approved ? sandboxApproval : undefined,
      receipt,
    };
  }

  await options.caller.report({
    type: "admitted",
    message: "Local policy admitted skill execution.",
  });

  if (skill.source.type === "chain" && skill.source.chain) {
    await options.caller.report({
      type: "executing",
      message: "Executing graph skill source.",
    });

    const graphResult = await runLocalGraph({
      graph: materializeInlineGraph(skill),
      graphDirectory: options.skillDirectory,
      inputs: options.inputs,
      caller: options.caller,
      env: options.env,
      receiptDir: options.receiptDir,
      runxHome: options.runxHome,
      journalDir: options.journalDir,
      adapters: options.adapters,
      allowedSourceTypes: options.allowedSourceTypes,
      authResolver: options.authResolver,
      runId: options.resumeFromRunId ?? uniqueReceiptId("gx"),
      skillEnvironment: {
        name: skill.name,
        body: skill.body,
      },
      resumeFromRunId: options.resumeFromRunId,
      executionSemantics: mergeExecutionSemantics(skill.execution, options.executionSemantics),
      registryStore: options.registryStore,
      skillCacheDir: options.skillCacheDir,
      receiptMetadata: inheritedReceiptMetadata,
      projectMemory,
      projectConventions,
      selectedRunnerName: options.selectedRunnerName,
      postRunReflectPolicy: resolvePostRunReflectPolicy(skill.runx),
    });

    if (graphResult.status === "needs_resolution") {
      return {
        status: "needs_resolution",
        skill,
        skillPath: options.skillPathForMissingContext ?? options.skillDirectory,
        inputs: options.inputs,
        runId: graphResult.runId,
        requests: graphResult.requests,
        stepIds: graphResult.stepIds,
        stepLabels: graphResult.stepLabels,
      };
    }

    if (graphResult.status === "policy_denied") {
      return {
        status: "policy_denied",
        skill,
        reasons: graphResult.reasons,
      };
    }

    let state = createSingleStepState(skill.name);
    state = transitionSingleStep(state, { type: "admit" });
    state = transitionSingleStep(state, { type: "start", at: graphResult.receipt.started_at ?? new Date().toISOString() });
    if (graphResult.status === "success") {
      state = transitionSingleStep(state, {
        type: "succeed",
        at: graphResult.receipt.completed_at ?? new Date().toISOString(),
      });
    } else {
      state = transitionSingleStep(state, {
        type: "fail",
        at: graphResult.receipt.completed_at ?? new Date().toISOString(),
        error: graphResult.errorMessage ?? "graph execution failed",
      });
    }

    await options.caller.report({
      type: "completed",
      message: `Skill execution ${graphResult.status}.`,
      data: {
        receiptId: graphResult.receipt.id,
      },
    });

    return {
      status: graphResult.status,
      skill,
      inputs: options.inputs,
      execution: {
        status: graphResult.status,
        stdout: graphResult.output,
        stderr: graphResult.errorMessage ?? "",
        exitCode: graphResult.status === "success" ? 0 : 1,
        signal: null,
        durationMs: graphResult.receipt.duration_ms,
        errorMessage: graphResult.errorMessage,
        metadata: {
          composite: {
            graph_receipt_id: graphResult.receipt.id,
            top_level_skill: skill.name,
          },
        },
      },
      state,
      receipt: graphResult.receipt,
    };
  }

  let state = createSingleStepState(skill.name);
  state = transitionSingleStep(state, { type: "admit" });
  const startedAt = new Date().toISOString();
  const preparedAgentContext = await prepareAgentContext({
    skill,
    inputs: options.inputs,
    env: options.env,
    receiptDir: options.receiptDir ?? defaultReceiptDir(options.env),
    runId: contextEnvelopeRunId,
    stepId: options.orchestrationStepId,
    currentContext: options.currentContext,
    skillDirectory: options.skillDirectory,
    projectMemory,
    projectConventions,
  });

  const credentialResolution = await options.authResolver?.resolveCredential({
    skill,
    inputs: options.inputs,
    grants: grantResolution?.grants ?? [],
  });

  await options.caller.report({
    type: "executing",
    message: `Executing ${skill.source.type} skill source.`,
  });

  const executionSkill = withSandboxApproval(skill, approvedSandboxEscalation);

  const execution = await executeSkill({
    skill: executionSkill,
    inputs: options.inputs,
    skillDirectory: options.skillDirectory,
    adapters: [
      ...(options.adapters ?? []),
      createCallerAgentAdapter(options.caller),
      createCallerAgentStepAdapter(options.caller),
      createCallerApprovalAdapter(options.caller),
      createCliToolAdapter(),
      createMcpAdapter(),
      ...defaultA2aAdapters(),
    ],
    env: options.env,
    credential: credentialResolution?.credential,
    allowedTools: executionSkill.allowedTools,
    runId: contextEnvelopeRunId,
    stepId: options.orchestrationStepId,
    currentContext: preparedAgentContext.currentContext,
    historicalContext: preparedAgentContext.historicalContext,
    contextProvenance: preparedAgentContext.provenance,
    projectMemory: preparedAgentContext.projectMemory,
    projectConventions: preparedAgentContext.projectConventions,
  });

  if (execution.status === "needs_resolution") {
    return {
      status: "needs_resolution",
      skill,
      skillPath: options.skillPathForMissingContext ?? options.skillDirectory,
      inputs: options.inputs,
      runId,
      requests: [execution.request],
    };
  }

  state = transitionSingleStep(state, { type: "start", at: startedAt });
  const completedAt = new Date().toISOString();
  if (execution.status === "success") {
    state = transitionSingleStep(state, {
      type: "succeed",
      at: completedAt,
    });
  } else {
    state = transitionSingleStep(state, {
      type: "fail",
      at: completedAt,
      error: execution.errorMessage ?? execution.stderr,
    });
  }

  const artifactResult = materializeArtifacts({
    stdout: execution.stdout,
    contract: skill.artifacts,
    runId,
    producer: {
      skill: skill.name,
      runner: skill.source.type,
    },
    createdAt: completedAt,
  });

  const receipt = await writeLocalReceipt({
    receiptId: runId,
    receiptDir: options.receiptDir ?? defaultReceiptDir(options.env),
    runxHome: options.runxHome ?? options.env?.RUNX_HOME,
    skillName: skill.name,
    sourceType: skill.source.type,
    inputs: options.inputs,
    stdout: execution.stdout,
    stderr: execution.stderr,
    execution: {
      status: execution.status,
      exitCode: execution.exitCode,
      signal: execution.signal,
      durationMs: execution.durationMs,
      errorMessage: execution.errorMessage,
      metadata: mergeMetadata(
        runnerTrustMetadata(skill.source.type),
        execution.metadata,
        credentialResolution?.receiptMetadata,
        preparedAgentContext.receiptMetadata,
        sandboxApproval ? approvalReceiptMetadata(sandboxApproval) : undefined,
        inheritedReceiptMetadata,
      ),
    },
    startedAt,
    completedAt,
    parentReceipt: options.parentReceipt,
    contextFrom: options.contextFrom,
    artifactIds: artifactResult.envelopes.map((envelope) => envelope.meta.artifact_id),
    disposition: executionSemantics.disposition,
    inputContext: executionSemantics.inputContext,
    outcomeState: executionSemantics.outcomeState,
    outcome: executionSemantics.outcome,
    surfaceRefs: executionSemantics.surfaceRefs,
    evidenceRefs: executionSemantics.evidenceRefs,
  });
  await appendSkillJournalEntries({
    receiptDir: options.receiptDir ?? defaultReceiptDir(options.env),
    runId,
    skill,
    startedAt,
    completedAt,
    status: execution.status,
    artifactEnvelopes: artifactResult.envelopes,
    receiptId: receipt.id,
    includeRunStarted: !options.resumeFromRunId,
  });
  try {
    await indexReceiptIfEnabled(receipt, options.receiptDir ?? defaultReceiptDir(options.env), options);
  } catch (error) {
    await options.caller.report({
      type: "warning",
      message: "Local journal indexing failed after receipt write; continuing with the persisted receipt.",
      data: {
        receiptId: receipt.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
  await projectReflectIfEnabled({
    caller: options.caller,
    receipt,
    receiptDir: options.receiptDir ?? defaultReceiptDir(options.env),
    runId,
    skillName: skill.name,
    journalDir: options.journalDir,
    env: options.env,
    selectedRunnerName: options.selectedRunnerName,
    postRunReflectPolicy: resolvePostRunReflectPolicy(skill.runx),
    involvedAgentMediatedWork: isAgentMediatedSource(skill.source.type),
  });

  await options.caller.report({
    type: "completed",
    message: `Skill execution ${execution.status}.`,
  });

  return {
    status: execution.status,
    skill,
    inputs: options.inputs,
    execution,
    state,
    receipt,
  };
}

async function approveSandboxEscalationIfNeeded(skill: ValidatedSkill, caller: Caller): Promise<ApprovalDecision | undefined> {
  if (!sandboxRequiresApproval(skill.source.sandbox)) {
    return undefined;
  }

  const gate: ApprovalGate = {
    id: `sandbox.${skill.name}.unrestricted-local-dev`,
    type: "sandbox",
    reason: `Skill '${skill.name}' requests unrestricted-local-dev sandbox authority.`,
    summary: {
      skill_name: skill.name,
      source_type: skill.source.type,
      sandbox_profile: "unrestricted-local-dev",
    },
  };
  await caller.report({
    type: "resolution_requested",
    message: gate.reason,
    data: {
      kind: "approval",
      requestId: gate.id,
      gate,
    },
  });
  const resolution = await resolveCallerRequest(caller, {
    id: gate.id,
    kind: "approval",
    gate,
  });
  const approved = typeof resolution?.payload === "boolean" ? resolution.payload : false;
  await caller.report({
    type: "resolution_resolved",
    message: approved ? `Approval ${gate.id} approved.` : `Approval ${gate.id} denied.`,
    data: {
      kind: "approval",
      requestId: gate.id,
      gate,
      approved,
      actor: resolution?.actor ?? "human",
    },
  });
  return {
    gate,
    approved,
  };
}

function withSandboxApproval(skill: ValidatedSkill, approvedSandboxEscalation: boolean): ValidatedSkill {
  if (!approvedSandboxEscalation || !skill.source.sandbox) {
    return skill;
  }

  const sandbox: SkillSandbox = {
    ...skill.source.sandbox,
    approvedEscalation: true,
  };
  return {
    ...skill,
    source: {
      ...skill.source,
      sandbox,
    },
  };
}

async function writeApprovalDeniedReceipt(options: {
  readonly skill: ValidatedSkill;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly reasons: readonly string[];
  readonly approval: ApprovalDecision;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
  readonly executionSemantics: NormalizedExecutionSemantics;
  readonly runOptions: Pick<
    RunResolvedSkillOptions,
    "receiptDir" | "runxHome" | "env" | "parentReceipt" | "contextFrom"
  >;
}): Promise<LocalSkillReceipt> {
  const startedAt = new Date().toISOString();
  return await writeLocalReceipt({
    receiptDir: options.runOptions.receiptDir ?? defaultReceiptDir(options.runOptions.env),
    runxHome: options.runOptions.runxHome ?? options.runOptions.env?.RUNX_HOME,
    skillName: options.skill.name,
    sourceType: options.skill.source.type,
    inputs: options.inputs,
    stdout: "",
    stderr: options.reasons.join("; "),
    execution: {
      status: "failure",
      exitCode: null,
      signal: null,
      durationMs: 0,
      errorMessage: options.reasons.join("; "),
      metadata: mergeMetadata(
        runnerTrustMetadata(options.skill.source.type),
        approvalReceiptMetadata(options.approval),
        options.receiptMetadata,
      ),
    },
    startedAt,
    completedAt: startedAt,
    parentReceipt: options.runOptions.parentReceipt,
    contextFrom: options.runOptions.contextFrom,
    disposition: "policy_denied",
    inputContext: options.executionSemantics.inputContext,
    outcomeState: options.executionSemantics.outcomeState,
    outcome: options.executionSemantics.outcome,
    surfaceRefs: options.executionSemantics.surfaceRefs,
    evidenceRefs: options.executionSemantics.evidenceRefs,
  });
}

function approvalReceiptMetadata(approval: ApprovalDecision): Readonly<Record<string, unknown>> {
  return {
    approval: {
      gate_id: approval.gate.id,
      gate_type: approval.gate.type ?? "unspecified",
      decision: approval.approved ? "approved" : "denied",
      reason: approval.gate.reason,
      summary: approval.gate.summary,
    },
  };
}

async function resolveSkillRunner(
  skill: ValidatedSkill,
  skillPath: string,
  runnerName: string | undefined,
): Promise<ResolvedRunnerSelection> {
  const profile = await resolveLocalSkillProfile(skillPath, skill.name);
  const profileDocument = profile.profileDocument;
  if (!profileDocument) {
    if (!runnerName) {
      return { skill };
    }
    throw new Error(`Runner '${runnerName}' requested but no execution profile was found for skill '${skill.name}'.`);
  }

  const manifest = validateRunnerManifest(parseRunnerManifestYaml(profileDocument));
  if (manifest.skill && manifest.skill !== skill.name) {
    throw new Error(`Runner manifest skill '${manifest.skill}' does not match skill '${skill.name}'.`);
  }

  const selectedRunnerName = runnerName ?? defaultRunnerName(manifest.runners);
  if (!selectedRunnerName) {
    return { skill };
  }

  const runner = manifest.runners[selectedRunnerName];
  if (!runner) {
    throw new Error(`Runner '${selectedRunnerName}' is not defined for skill '${skill.name}'.`);
  }

  return {
    skill: applyRunner(skill, runner),
    selectedRunnerName,
  };
}

function defaultRunnerName(runners: Readonly<Record<string, SkillRunnerDefinition>>): string | undefined {
  const defaults = Object.values(runners).filter((runner) => runner.default);
  if (defaults.length > 1) {
    throw new Error(`Runner manifest declares multiple default runners: ${defaults.map((runner) => runner.name).join(", ")}.`);
  }
  return defaults[0]?.name;
}

function applyRunner(skill: ValidatedSkill, runner: SkillRunnerDefinition): ValidatedSkill {
  return {
    ...skill,
    source: runner.source,
    inputs: {
      ...skill.inputs,
      ...runner.inputs,
    },
    auth: runner.auth ?? skill.auth,
    risk: runner.risk ?? skill.risk,
    runtime: runner.runtime ?? skill.runtime,
    retry: runner.retry ?? skill.retry,
    idempotency: runner.idempotency ?? skill.idempotency,
    mutating: runner.mutating ?? skill.mutating,
    artifacts: runner.artifacts ?? skill.artifacts,
    allowedTools: runner.allowedTools ?? skill.allowedTools,
    execution: runner.execution ?? skill.execution,
    runx: runner.runx ?? skill.runx,
  };
}

async function resolveSkillReference(skillPath: string): Promise<ResolvedSkillReference> {
  const requestedPath = path.resolve(skillPath);
  if (!(await pathExists(requestedPath))) {
    throw new Error(`Skill package not found: ${requestedPath}`);
  }
  const referenceStat = await stat(requestedPath);

  if (referenceStat.isDirectory()) {
    const skillMarkdownPath = path.join(requestedPath, "SKILL.md");
    if (!(await pathExists(skillMarkdownPath))) {
      throw new Error(`Skill package '${requestedPath}' is missing SKILL.md.`);
    }
    return {
      requestedPath,
      skillPath: skillMarkdownPath,
      skillDirectory: requestedPath,
    };
  }

  const skillDirectory = path.dirname(requestedPath);
  const skillFileName = path.basename(requestedPath).toLowerCase();
  if (skillFileName !== "skill.md") {
    throw new Error(
      `Skill references must point to a skill package directory or SKILL.md. Flat markdown files are not supported: ${requestedPath}`,
    );
  }
  return {
    requestedPath,
    skillPath: requestedPath,
    skillDirectory,
  };
}

async function resolveToolReference(toolName: string, searchFromDirectory: string): Promise<ResolvedToolReference> {
  const segments = toolName.split(".").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new Error(`Tool '${toolName}' must include a namespace, for example fs.read.`);
  }

  const searchRoots = await resolveToolRoots(searchFromDirectory);
  for (const root of searchRoots) {
    const toolPath = path.join(root, ...segments, "tool.yaml");
    if (await pathExists(toolPath)) {
      return {
        requestedName: toolName,
        toolName,
        toolPath,
        toolDirectory: path.dirname(toolPath),
      };
    }
  }

  throw new Error(`Tool '${toolName}' was not found in configured tool roots.`);
}

async function resolveToolRoots(searchFromDirectory: string): Promise<readonly string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  let current = path.resolve(searchFromDirectory);

  while (true) {
    const candidate = path.join(current, ".runx", "tools");
    if (!seen.has(candidate) && await isDirectory(candidate)) {
      roots.push(candidate);
      seen.add(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  for (const builtinRoot of await resolveBuiltinToolRoots()) {
    if (!seen.has(builtinRoot)) {
      roots.push(builtinRoot);
      seen.add(builtinRoot);
    }
  }

  return roots;
}

async function resolveBuiltinToolRoots(): Promise<readonly string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  const envRoots = (process.env.RUNX_TOOL_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => path.resolve(value));

  for (const envRoot of envRoots) {
    if (!seen.has(envRoot) && await isDirectory(envRoot)) {
      roots.push(envRoot);
      seen.add(envRoot);
    }
  }

  let current = runnerLocalModuleDirectory;

  while (true) {
    const candidate = path.join(current, "tools");
    if (!seen.has(candidate) && await isDirectory(candidate)) {
      roots.push(candidate);
      seen.add(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
}

async function isDirectory(candidatePath: string): Promise<boolean> {
  try {
    return (await stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await stat(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function materializeInlineGraph(skill: ValidatedSkill): ExecutionGraph {
  if (!skill.source.chain) {
    throw new Error(`Skill '${skill.name}' does not declare an inline chain.`);
  }
  return {
    ...skill.source.chain,
    name: skill.name,
  };
}

async function resolveGraphExecution(options: RunLocalGraphOptions): Promise<{
  readonly graph: ExecutionGraph;
  readonly graphDirectory: string;
  readonly resolvedGraphPath?: string;
}> {
  if (options.graph) {
    return {
      graph: options.graph,
      graphDirectory: path.resolve(options.graphDirectory ?? process.cwd()),
    };
  }
  if (!options.graphPath) {
    throw new Error("runLocalGraph requires graphPath or graph.");
  }
  const resolvedGraphPath = path.resolve(options.graphPath);
  return {
    graph: validateGraph(parseGraphYaml(await readFile(resolvedGraphPath, "utf8"))),
    graphDirectory: path.dirname(resolvedGraphPath),
    resolvedGraphPath,
  };
}

async function appendSkillJournalEntries(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly skill: ValidatedSkill;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "success" | "failure";
  readonly artifactEnvelopes: readonly ArtifactEnvelope[];
  readonly receiptId: string;
  readonly includeRunStarted?: boolean;
}): Promise<void> {
  const producer = {
    skill: options.skill.name,
    runner: options.skill.source.type,
  };
  await appendJournalEntries({
    receiptDir: options.receiptDir,
    runId: options.runId,
    entries: [
      ...(options.includeRunStarted === false
        ? []
        : [
            createRunEventEntry({
              runId: options.runId,
              producer,
              kind: "run_started",
              status: "started",
              createdAt: options.startedAt,
            }),
          ]),
      ...options.artifactEnvelopes,
      ...options.artifactEnvelopes.map((envelope) =>
        createReceiptLinkEntry({
          runId: options.runId,
          producer,
          artifactId: envelope.meta.artifact_id,
          receiptId: options.receiptId,
          createdAt: options.completedAt,
        }),
      ),
      createRunEventEntry({
        runId: options.runId,
        producer,
        kind: "run_completed",
        status: options.status,
        createdAt: options.completedAt,
        detail: {
          receipt_id: options.receiptId,
        },
      }),
    ],
  });
}

async function appendPendingSkillJournalEntries(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly skill: ValidatedSkill;
  readonly startedAt: string;
  readonly kind: "resolution_requested";
  readonly detail: Readonly<Record<string, unknown>>;
  readonly includeRunStarted?: boolean;
}): Promise<void> {
  const producer = {
    skill: options.skill.name,
    runner: options.skill.source.type,
  };
  await appendJournalEntries({
    receiptDir: options.receiptDir,
    runId: options.runId,
    entries: [
      ...(options.includeRunStarted === false
        ? []
        : [
            createRunEventEntry({
              runId: options.runId,
              producer,
              kind: "run_started",
              status: "started",
              createdAt: options.startedAt,
            }),
          ]),
      createRunEventEntry({
        runId: options.runId,
        producer,
        kind: options.kind,
        status: "waiting",
        detail: options.detail,
        createdAt: options.startedAt,
      }),
    ],
  });
}

async function appendGraphJournalEntries(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly topLevelSkillName: string;
  readonly stepId: string;
  readonly skill: ValidatedSkill;
  readonly artifactEnvelopes: readonly ArtifactEnvelope[];
  readonly receiptId: string;
  readonly status: "success" | "failure";
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}): Promise<void> {
  const producer = {
    skill: options.topLevelSkillName,
    runner: "graph",
  };
  await appendJournalEntries({
    receiptDir: options.receiptDir,
    runId: options.runId,
    entries: [
      ...options.artifactEnvelopes,
      ...options.artifactEnvelopes.map((envelope) =>
        createReceiptLinkEntry({
          runId: options.runId,
          stepId: options.stepId,
          producer,
          artifactId: envelope.meta.artifact_id,
          receiptId: options.receiptId,
          createdAt: options.createdAt,
        }),
      ),
      createRunEventEntry({
        runId: options.runId,
        stepId: options.stepId,
        producer,
        kind: options.status === "success" ? "step_succeeded" : "step_failed",
        status: options.status,
        detail: {
          skill: options.skill.name,
          receipt_id: options.receiptId,
          ...options.detail,
        },
        createdAt: options.createdAt,
      }),
    ],
  });
}

async function appendPendingGraphJournalEntry(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly topLevelSkillName: string;
  readonly stepId: string;
  readonly kind: "step_waiting_resolution";
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}): Promise<void> {
  await appendJournalEntries({
    receiptDir: options.receiptDir,
    runId: options.runId,
    entries: [
      createRunEventEntry({
        runId: options.runId,
        stepId: options.stepId,
        producer: {
          skill: options.topLevelSkillName,
          runner: "graph",
        },
        kind: options.kind,
        status: "waiting",
        detail: options.detail,
        createdAt: options.createdAt,
      }),
    ],
  });
}

async function appendGraphStepStartedJournalEntry(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly topLevelSkillName: string;
  readonly step: GraphStep;
  readonly reference: string;
  readonly createdAt: string;
}): Promise<void> {
  await appendJournalEntries({
    receiptDir: options.receiptDir,
    runId: options.runId,
    entries: [
      createRunEventEntry({
        runId: options.runId,
        stepId: options.step.id,
        producer: {
          skill: options.topLevelSkillName,
          runner: "graph",
        },
        kind: "step_started",
        status: "started",
        detail: {
          skill: options.reference,
          runner: graphStepRunner(options.step) ?? "default",
        },
        createdAt: options.createdAt,
      }),
    ],
  });
}

function admitGraphTransition(
  policy: GraphPolicy | undefined,
  stepId: string,
  outputs: ReadonlyMap<string, GraphStepOutput>,
): { readonly status: "allow" } | { readonly status: "deny"; readonly reason: string } {
  const gates = policy?.transitions.filter((gate) => gate.to === stepId) ?? [];
  for (const gate of gates) {
    let value: unknown;
    try {
      value = resolveTransitionGateValue(outputs, gate.field);
    } catch (error) {
      return {
        status: "deny",
        reason: error instanceof Error ? error.message : `unable to resolve policy field '${gate.field}'`,
      };
    }
    if (gate.equals !== undefined && !isDeepEqual(value, gate.equals)) {
      return {
        status: "deny",
        reason: `transition policy blocked step '${stepId}': expected ${gate.field} == ${JSON.stringify(gate.equals)}`,
      };
    }
    if (gate.notEquals !== undefined && isDeepEqual(value, gate.notEquals)) {
      return {
        status: "deny",
        reason: `transition policy blocked step '${stepId}': expected ${gate.field} != ${JSON.stringify(gate.notEquals)}`,
      };
    }
  }
  return { status: "allow" };
}

function resolveTransitionGateValue(
  outputs: ReadonlyMap<string, GraphStepOutput>,
  field: string,
): unknown {
  const dotIndex = field.indexOf(".");
  if (dotIndex <= 0) {
    throw new Error(`invalid transition policy field '${field}'`);
  }
  const stepId = field.slice(0, dotIndex);
  const outputPath = field.slice(dotIndex + 1);
  const output = outputs.get(stepId);
  if (!output) {
    throw new Error(`transition policy references missing step '${stepId}'`);
  }
  return resolveOutputPath(output, outputPath);
}

function hydrateGraphFromJournal(options: {
  readonly entries: readonly ArtifactEnvelope[];
  readonly graph: ExecutionGraph;
  readonly graphStepCache: ReadonlyMap<string, ValidatedSkill>;
  readonly skillEnvironment?: {
    readonly name: string;
    readonly body: string;
  };
  readonly graphSteps: readonly {
    readonly id: string;
    readonly contextFrom: readonly string[];
    readonly retry?: GraphStep["retry"];
    readonly fanoutGroup?: string;
  }[];
  readonly stepRuns: GraphStepRun[];
  readonly outputs: Map<string, GraphStepOutput>;
  readonly syncPoints: GraphReceiptSyncPoint[];
  readonly stateRef: {
    get value(): SequentialGraphState;
    set value(next: SequentialGraphState);
  };
  readonly lastReceiptRef: {
    get value(): string | undefined;
    set value(next: string | undefined);
  };
}): void {
  if (options.entries.length === 0) {
    return;
  }
  if (options.graph.steps.some((step) => step.fanoutGroup)) {
    throw new Error("resumeFromRunId currently supports sequential chains only.");
  }

  const stepsById = new Map(options.graph.steps.map((step) => [step.id, step]));
  const latestEvents = new Map<string, ArtifactEnvelope>();
  const artifactsByStep = new Map<string, ArtifactEnvelope[]>();
  const receiptLinks = new Map<string, string>();

  for (const entry of options.entries) {
    if (entry.type === "run_event") {
      const stepId = entry.data.step_id;
      if (typeof stepId === "string" && stepId.length > 0) {
        latestEvents.set(stepId, entry);
      }
      continue;
    }
    if (entry.type === "receipt_link") {
      const artifactId = typeof entry.data.artifact_id === "string" ? entry.data.artifact_id : undefined;
      const receiptId = typeof entry.data.receipt_id === "string" ? entry.data.receipt_id : undefined;
      if (artifactId && receiptId) {
        receiptLinks.set(artifactId, receiptId);
      }
      continue;
    }
    if (entry.meta.step_id) {
      artifactsByStep.set(entry.meta.step_id, [...(artifactsByStep.get(entry.meta.step_id) ?? []), entry]);
    }
  }

  let state = options.stateRef.value;
  for (const chainStep of options.graphSteps) {
    const step = stepsById.get(chainStep.id);
    const stepSkill =
      options.graphStepCache.get(chainStep.id)
      ?? (step?.run ? buildInlineGraphStepSkill(step, options.skillEnvironment) : undefined);
    const event = latestEvents.get(chainStep.id);
    if (!step || !stepSkill || !event) {
      break;
    }
    const stepArtifacts = artifactsByStep.get(chainStep.id) ?? [];
    const stepFields = reconstructStepFields(stepArtifacts, stepSkill.artifacts);
    const receiptId = receiptLinksForStep(stepArtifacts, receiptLinks)[0];
    if (event.data.kind === "step_started") {
      state = transitionSequentialGraph(state, {
        type: "start_step",
        stepId: chainStep.id,
        at: entryTimestamp(event),
      });
      break;
    }
    if (event.data.kind === "step_succeeded") {
      state = transitionSequentialGraph(state, {
        type: "start_step",
        stepId: chainStep.id,
        at: entryTimestamp(event),
      });
      state = transitionSequentialGraph(state, {
        type: "step_succeeded",
        stepId: chainStep.id,
        at: entryTimestamp(event),
        receiptId,
        outputs: stepFields,
      });
      options.outputs.set(chainStep.id, {
        status: "success",
        stdout: reconstructStdout(stepArtifacts, stepFields),
        stderr: "",
        receiptId: receiptId ?? "",
        fields: stepFields,
        artifactIds: stepArtifacts.map((artifact) => artifact.meta.artifact_id),
        artifacts: stepArtifacts.filter(isDomainArtifactEnvelope),
      });
      options.stepRuns.push({
        stepId: chainStep.id,
        skill: graphStepReference(step),
        skillPath: step.skill ? step.skill : `inline:${chainStep.id}`,
        runner: step.runner,
        attempt: 1,
        status: "success",
        receiptId,
        stdout: reconstructStdout(stepArtifacts, stepFields),
        stderr: "",
        artifactIds: stepArtifacts.map((artifact) => artifact.meta.artifact_id),
        contextFrom: [],
      });
      options.lastReceiptRef.value = receiptId ?? options.lastReceiptRef.value;
      continue;
    }
    if (event.data.kind === "step_failed") {
      state = transitionSequentialGraph(state, {
        type: "start_step",
        stepId: chainStep.id,
        at: entryTimestamp(event),
      });
      state = transitionSequentialGraph(state, {
        type: "step_failed",
        stepId: chainStep.id,
        at: entryTimestamp(event),
        error: typeof event.data.detail === "object" && event.data.detail && "reason" in event.data.detail
          ? String((event.data.detail as Record<string, unknown>).reason)
          : "previous attempt failed",
      });
      break;
    }
    if (event.data.kind === "step_waiting_resolution") {
      break;
    }
    break;
  }
  options.stateRef.value = state;
}

function reconstructStepFields(
  artifacts: readonly ArtifactEnvelope[],
  contract: ArtifactContract | undefined,
): Readonly<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  const skillArtifacts = artifacts.filter((artifact) => artifact.type !== "run_event" && artifact.type !== "receipt_link");
  if (skillArtifacts.length === 1 && skillArtifacts[0]?.type === null) {
    const untypedData = skillArtifacts[0].data;
    if ("raw" in untypedData && typeof untypedData.raw === "string") {
      fields.raw = untypedData.raw;
      return fields;
    }
    Object.assign(fields, untypedData);
    fields.raw = JSON.stringify(untypedData);
    return fields;
  }
  for (const artifact of skillArtifacts) {
    const key = declaredArtifactField(contract, artifact.type) ?? artifact.type ?? "raw";
    fields[key] = artifact;
  }
  return fields;
}

function declaredArtifactField(contract: ArtifactContract | undefined, artifactType: string | null): string | undefined {
  if (!artifactType) {
    return undefined;
  }
  for (const [fieldName, declaredType] of Object.entries(contract?.namedEmits ?? {})) {
    if (declaredType === artifactType) {
      return fieldName;
    }
  }
  if (contract?.wrapAs === artifactType) {
    return artifactType;
  }
  return undefined;
}

function receiptLinksForStep(
  artifacts: readonly ArtifactEnvelope[],
  receiptLinks: ReadonlyMap<string, string>,
): readonly string[] {
  return artifacts
    .map((artifact) => receiptLinks.get(artifact.meta.artifact_id))
    .filter((receiptId): receiptId is string => typeof receiptId === "string");
}

function reconstructStdout(
  artifacts: readonly ArtifactEnvelope[],
  fields: Readonly<Record<string, unknown>>,
): string {
  const raw = artifacts.find((artifact) => artifact.type === null)?.data.raw;
  if (typeof raw === "string") {
    return raw;
  }
  if ("raw" in fields && typeof fields.raw === "string") {
    return fields.raw;
  }
  return JSON.stringify(fields);
}

function entryTimestamp(entry: ArtifactEnvelope): string {
  return entry.meta.created_at;
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function runLocalGraph(options: RunLocalGraphOptions): Promise<RunLocalGraphResult> {
  const graphResolution = await resolveGraphExecution(options);
  const receiptDir = options.receiptDir ?? defaultReceiptDir(options.env);
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const executionSemantics = normalizeExecutionSemantics(options.executionSemantics, options.inputs ?? {});
  const graph = graphResolution.graph;
  const graphDirectory = graphResolution.graphDirectory;
  const projectMemory =
    options.projectMemory
    ?? (await loadProjectMemory({
      inputs: options.inputs ?? {},
      env: options.env,
      fallbackStart: graphDirectory,
    }));
  const projectConventions =
    options.projectConventions
    ?? (await loadProjectConventions({
      inputs: options.inputs ?? {},
      env: options.env,
      fallbackStart: graphDirectory,
    }));
  const inheritedReceiptMetadata = mergeMetadata(
    projectMemoryReceiptMetadata(projectMemory),
    projectConventionsReceiptMetadata(projectConventions),
    options.receiptMetadata,
  );
  const graphId = options.runId ?? options.resumeFromRunId ?? uniqueReceiptId("gx");
  const graphStepCache = await loadGraphStepExecutables(graph, graphDirectory, options.registryStore, options.skillCacheDir);
  const graphGrant = options.graphGrant ?? defaultLocalGraphGrant();
  const graphSteps = graph.steps.map((step) => ({
    id: step.id,
    contextFrom: unique(step.contextEdges.map((edge) => edge.fromStep)),
    retry: step.retry ?? graphStepCache.get(step.id)?.retry,
    fanoutGroup: step.fanoutGroup,
  }));
  let state = createSequentialGraphState(graphId, graphSteps);
  const stepRuns: GraphStepRun[] = [];
  const syncPoints: GraphReceiptSyncPoint[] = [];
  const outputs = new Map<string, GraphStepOutput>();
  let lastReceiptId: string | undefined;
  let finalOutput = "";
  let finalError: string | undefined;
  let involvedAgentMediatedWork = false;
  if (options.resumeFromRunId) {
    hydrateGraphFromJournal({
      entries: await readJournalEntries(receiptDir, options.resumeFromRunId),
      graph,
      graphStepCache,
      skillEnvironment: options.skillEnvironment,
      graphSteps,
      stepRuns,
      outputs,
      syncPoints,
      stateRef: {
        get value() {
          return state;
        },
        set value(next: SequentialGraphState) {
          state = next;
        },
      },
      lastReceiptRef: {
        get value() {
          return lastReceiptId;
        },
        set value(next: string | undefined) {
          lastReceiptId = next;
        },
      },
    });
    involvedAgentMediatedWork = stepRuns.some((stepRun) => {
      const step = graph.steps.find((candidate) => candidate.id === stepRun.stepId);
      const cachedSkill = graphStepCache.get(stepRun.stepId);
      if (cachedSkill) {
        return isAgentMediatedSource(cachedSkill.source.type);
      }
      return isAgentMediatedSource(String(step?.run?.type ?? ""));
    });
  }

  await options.caller.report({
    type: "skill_loaded",
    message: `Loaded graph ${graph.name}.`,
    data: { graphPath: graphResolution.resolvedGraphPath, graphId },
  });

  while (true) {
    const plan = planSequentialGraphTransition(state, graphSteps, graph.fanoutGroups);
    if (plan.type === "complete") {
      state = transitionSequentialGraph(state, { type: "complete" });
      break;
    }

    if (plan.type === "failed") {
      finalError = resolveSequentialGraphFailureReason(plan, state, stepRuns);
      if (plan.syncDecision) {
        syncPoints.push(toGraphReceiptSyncPoint(plan.syncDecision, latestFanoutReceiptIds(stepRuns, plan.syncDecision.groupId)));
      }
      state = transitionSequentialGraph(state, { type: "fail_graph", error: finalError });
      break;
    }

    if (plan.type === "blocked") {
      finalError = plan.reason;
      if (plan.syncDecision) {
        syncPoints.push(toGraphReceiptSyncPoint(plan.syncDecision, latestFanoutReceiptIds(stepRuns, plan.syncDecision.groupId)));
      }
      state = transitionSequentialGraph(state, { type: "fail_graph", error: plan.reason });
      break;
    }

    if (plan.type === "run_fanout") {
      const fanoutParentReceipt = lastReceiptId;

      // Pre-flight: admission and retry checks (synchronous, before parallel execution)
      const branchPreps: Array<{
        step: GraphStep;
        stepSkillPath: string;
        stepSkill: ValidatedSkill;
        stepReference: string;
        stepInputs: Readonly<Record<string, unknown>>;
        context: ReturnType<typeof materializeContext>;
        contextFromReceiptIds: string[];
        governance: ReturnType<typeof buildGraphStepGovernance>;
        retryContext: ReturnType<typeof buildRetryReceiptContext>;
      }> = [];

      for (const stepId of plan.stepIds) {
        const step = findGraphStep(graph, stepId);
        const context = materializeContext(step, outputs);
        const contextFromReceiptIds = context
          .map((edge) => edge.receiptId)
          .filter((receiptId): receiptId is string => typeof receiptId === "string");
        const resolvedStep = await resolveGraphStepExecution({
          step,
          graphDirectory,
          graphStepCache,
          skillEnvironment: options.skillEnvironment,
          registryStore: options.registryStore,
          skillCacheDir: options.skillCacheDir,
        });
        const stepSkillPath = resolvedStep.skillPath;
        const stepSkill = resolvedStep.skill;
        involvedAgentMediatedWork ||= isAgentMediatedSource(stepSkill.source.type);
        const stepInputs = materializeDeclaredInputs(stepSkill.inputs, {
          ...(options.inputs ?? {}),
          ...step.inputs,
          ...Object.fromEntries(context.map((edge) => [edge.input, edge.value])),
        });
        const governance = buildGraphStepGovernance(step, graphGrant);

        if (governance.scopeAdmission.status === "deny") {
          const deniedRun = buildDeniedGraphStepRun({
            step, stepSkillPath,
            attempt: plan.attempts[step.id] ?? 1,
            parentReceipt: fanoutParentReceipt,
            fanoutGroup: plan.groupId,
            governance, context,
          });
          const receipt = await writePolicyDeniedGraphReceipt({
            receiptDir,
            runxHome: options.runxHome ?? options.env?.RUNX_HOME,
            graph, graphId, startedAt, startedAtMs,
            inputs: options.inputs ?? {},
            stepRuns: [...stepRuns, deniedRun],
            errorMessage: governance.scopeAdmission.reasons?.join("; ") ?? "graph step scope denied",
            executionSemantics,
            receiptMetadata: inheritedReceiptMetadata,
          });
          return {
            status: "policy_denied", graph, stepId: step.id,
            skill: stepSkill,
            reasons: governance.scopeAdmission.reasons ?? [],
            state, receipt,
          };
        }

        const effectiveRetry = step.retry ?? stepSkill.retry;
        const retryContext = buildRetryReceiptContext(step, stepInputs, plan.attempts[step.id] ?? 1, stepSkill, effectiveRetry);
        const retryAdmission = admitRetryPolicy({
          stepId: step.id, retry: effectiveRetry,
          mutating: step.mutating || stepSkill.mutating === true,
          idempotencyKey: retryContext.idempotencyKey,
        });
        if (retryAdmission.status === "deny") {
          return {
            status: "policy_denied", graph, stepId: step.id,
            skill: stepSkill, reasons: retryAdmission.reasons, state,
          };
        }

        branchPreps.push({
          step,
          stepSkillPath,
          stepSkill,
          stepReference: resolvedStep.reference,
          stepInputs,
          context,
          contextFromReceiptIds,
          governance,
          retryContext,
        });
      }

      for (const prep of branchPreps) {
        const stepStartedAt = new Date().toISOString();
        state = transitionSequentialGraph(state, {
          type: "start_step",
          stepId: prep.step.id,
          at: stepStartedAt,
        });
        await reportGraphStepStarted(options.caller, prep.step, prep.stepReference);
        await appendGraphStepStartedJournalEntry({
          receiptDir,
          runId: graphId,
          topLevelSkillName: graphProducerSkillName(options, graph),
          step: prep.step,
          reference: prep.stepReference,
          createdAt: stepStartedAt,
        });
      }

      // Parallel execution: all branches run concurrently
      const branchTasks = branchPreps.map((prep) => ({
        id: prep.step.id,
        fn: async (_signal: AbortSignal) => {
          return await runResolvedSkill({
            skill: prep.stepSkill,
            skillDirectory: graphStepExecutionDirectory(prep.step, prep.stepSkillPath, graphDirectory),
            inputs: prep.stepInputs,
            caller: options.caller,
            env: options.env,
            receiptDir,
            runxHome: options.runxHome,
            journalDir: options.journalDir,
            parentReceipt: fanoutParentReceipt,
            contextFrom: prep.contextFromReceiptIds,
            adapters: options.adapters,
            allowedSourceTypes: options.allowedSourceTypes,
            authResolver: options.authResolver,
            receiptMetadata: mergeMetadata(
              inheritedReceiptMetadata,
              prep.retryContext.receiptMetadata,
              governanceReceiptMetadata(prep.step, prep.governance),
            ),
            orchestrationRunId: graphId,
            orchestrationStepId: prep.step.id,
            currentContext: prep.context,
            registryStore: options.registryStore,
            skillCacheDir: options.skillCacheDir,
            projectMemory,
            projectConventions,
          });
        },
      }));

      const fanoutResults = await runFanout(branchTasks);
      const pendingResolutionRequests: ResolutionRequest[] = [];
      const pendingStepIds: string[] = [];
      const pendingStepLabels: string[] = [];

      // Apply results to state machine in declaration order
      for (let i = 0; i < branchPreps.length; i++) {
        const prep = branchPreps[i];
        const result = fanoutResults[i];

        if (result.status === "aborted" || !result.value) {
          state = transitionSequentialGraph(state, {
            type: "step_failed", stepId: prep.step.id,
            at: new Date().toISOString(),
            error: result.error ?? "fanout branch aborted",
          });
          continue;
        }

        const stepResult = result.value;

        if (stepResult.status === "needs_resolution") {
          pendingResolutionRequests.push(...stepResult.requests);
          pendingStepIds.push(prep.step.id);
          pendingStepLabels.push(prep.step.label ?? prep.step.id);
          await reportGraphStepWaitingResolution(
            options.caller,
            prep.step,
            prep.stepReference,
            stepResult.requests,
          );
          await appendPendingGraphJournalEntry({
            receiptDir,
            runId: graphId,
            topLevelSkillName: graphProducerSkillName(options, graph),
            stepId: prep.step.id,
            kind: "step_waiting_resolution",
            detail: {
              request_ids: stepResult.requests.map((request) => request.id),
              resolution_kinds: Array.from(new Set(stepResult.requests.map((request) => request.kind))),
              runner: graphStepRunner(prep.step) ?? "default",
              step_label: prep.step.label,
            },
            createdAt: new Date().toISOString(),
          });
          continue;
        }

        // In fanout, policy_denied is a branch failure, not a graph halt.
        if (stepResult.status === "policy_denied") {
          await reportGraphStepCompleted(
            options.caller,
            prep.step,
            prep.stepReference,
            "failure",
            {
              reason: `policy denied: ${stepResult.reasons.join("; ")}`,
            },
          );
          await appendJournalEntries({
            receiptDir,
            runId: graphId,
            entries: [
              createRunEventEntry({
                runId: graphId,
                stepId: prep.step.id,
                producer: {
                  skill: graphProducerSkillName(options, graph),
                  runner: "graph",
                },
                kind: "step_failed",
                status: "failure",
                detail: {
                  reason: `policy denied: ${stepResult.reasons.join("; ")}`,
                },
              }),
            ],
          });
          state = transitionSequentialGraph(state, {
            type: "step_failed", stepId: prep.step.id,
            at: new Date().toISOString(),
            error: `policy denied: ${stepResult.reasons.join("; ")}`,
          });
          continue;
        }

        const stepCompletedAt = new Date().toISOString();
        const artifactResult = materializeArtifacts({
          stdout: stepResult.execution.stdout,
          contract: stepResult.skill.artifacts,
          runId: graphId,
          stepId: prep.step.id,
          producer: {
            skill: stepResult.skill.name,
            runner: stepResult.skill.source.type,
          },
          createdAt: stepCompletedAt,
        });
        const stepRun: GraphStepRun = {
          stepId: prep.step.id,
          skill: prep.stepReference,
          skillPath: prep.stepSkillPath,
          runner: graphStepRunner(prep.step),
          attempt: plan.attempts[prep.step.id] ?? 1,
          status: stepResult.status,
          receiptId: stepResult.receipt.id,
          stdout: stepResult.execution.stdout,
          stderr: stepResult.execution.stderr,
          parentReceipt: fanoutParentReceipt,
          fanoutGroup: plan.groupId,
          retry: prep.retryContext.receipt,
          governance: prep.governance,
          artifactIds: artifactResult.envelopes.map((envelope) => envelope.meta.artifact_id),
          disposition: stepResult.receipt.disposition,
          inputContext: stepResult.receipt.input_context,
          outcomeState: stepResult.receipt.outcome_state,
          outcome: stepResult.receipt.outcome,
          surfaceRefs: stepResult.receipt.surface_refs,
          evidenceRefs: stepResult.receipt.evidence_refs,
          contextFrom: prep.context.map((edge) => ({
            input: edge.input, fromStep: edge.fromStep,
            output: edge.output, receiptId: edge.receiptId,
          })),
        };
        stepRuns.push(stepRun);
        outputs.set(prep.step.id, {
          status: stepResult.status,
          stdout: stepResult.execution.stdout,
          stderr: stepResult.execution.stderr,
          receiptId: stepResult.receipt.id,
          fields: artifactResult.fields,
          artifactIds: artifactResult.envelopes.map((envelope) => envelope.meta.artifact_id),
          artifacts: artifactResult.envelopes,
        });
        finalOutput = stepResult.execution.stdout;
        await appendGraphJournalEntries({
          receiptDir,
          runId: graphId,
          topLevelSkillName: graphProducerSkillName(options, graph),
          stepId: prep.step.id,
          skill: stepResult.skill,
          artifactEnvelopes: artifactResult.envelopes,
          receiptId: stepResult.receipt.id,
          status: stepResult.status,
          detail: {
            runner: graphStepRunner(prep.step) ?? "default",
          },
          createdAt: stepCompletedAt,
        });

        state = stepResult.status === "success"
          ? transitionSequentialGraph(state, {
              type: "step_succeeded", stepId: prep.step.id,
              at: stepCompletedAt, receiptId: stepResult.receipt.id,
              outputs: artifactResult.fields,
            })
          : transitionSequentialGraph(state, {
              type: "step_failed", stepId: prep.step.id,
              at: stepCompletedAt,
              error: stepResult.execution.errorMessage ?? stepResult.execution.stderr,
            });
        await reportGraphStepCompleted(
          options.caller,
          prep.step,
          prep.stepReference,
          stepResult.status,
          {
            receiptId: stepResult.receipt.id,
          },
        );
      }

      if (pendingResolutionRequests.length > 0) {
        return {
          status: "needs_resolution",
          graph,
          stepIds: pendingStepIds,
          stepLabels: pendingStepLabels,
          skillPath: branchPreps.find((prep) => pendingStepIds.includes(prep.step.id))?.stepSkillPath ?? graphDirectory,
          skill: branchPreps.find((prep) => pendingStepIds.includes(prep.step.id))?.stepSkill ?? branchPreps[0]!.stepSkill,
          requests: pendingResolutionRequests,
          state,
          runId: graphId,
        };
      }

      const followUpPlan = planSequentialGraphTransition(state, graphSteps, graph.fanoutGroups);
      if (followUpPlan.type === "run_fanout" && followUpPlan.groupId === plan.groupId) {
        continue;
      }
      if ((followUpPlan.type === "failed" || followUpPlan.type === "blocked") && followUpPlan.syncDecision?.groupId === plan.groupId) {
        finalError =
          followUpPlan.type === "failed"
            ? resolveSequentialGraphFailureReason(followUpPlan, state, stepRuns)
            : followUpPlan.reason;
        syncPoints.push(toGraphReceiptSyncPoint(followUpPlan.syncDecision, latestFanoutReceiptIds(stepRuns, plan.groupId)));
        state = transitionSequentialGraph(state, { type: "fail_graph", error: finalError });
        break;
      }

      const policy = graph.fanoutGroups[plan.groupId];
      if (policy) {
        const decision = evaluateFanoutSync(
          policy,
          graphSteps
            .filter((step) => step.fanoutGroup === plan.groupId)
            .map((step) => {
              const stepState = state.steps.find((candidate) => candidate.stepId === step.id);
              return {
                stepId: step.id,
                status: stepState?.status ?? "failed",
                outputs: stepState?.outputs,
              };
            }),
        );
        syncPoints.push(toGraphReceiptSyncPoint(decision, latestFanoutReceiptIds(stepRuns, plan.groupId)));
      }

      const groupReceiptIds = latestFanoutReceiptIds(stepRuns, plan.groupId);
      lastReceiptId = groupReceiptIds[groupReceiptIds.length - 1] ?? lastReceiptId;
      continue;
    }

    const step = findGraphStep(graph, plan.stepId);
    const context = materializeContext(step, outputs);
    const contextFromReceiptIds = context
      .map((edge) => edge.receiptId)
      .filter((receiptId): receiptId is string => typeof receiptId === "string");
    const resolvedStep = await resolveGraphStepExecution({
      step,
      graphDirectory,
      graphStepCache,
      skillEnvironment: options.skillEnvironment,
      registryStore: options.registryStore,
      skillCacheDir: options.skillCacheDir,
    });
    const stepSkillPath = resolvedStep.skillPath;
    const stepSkill = resolvedStep.skill;
    involvedAgentMediatedWork ||= isAgentMediatedSource(stepSkill.source.type);
    const stepInputs = materializeDeclaredInputs(stepSkill.inputs, {
      ...(options.inputs ?? {}),
      ...step.inputs,
      ...Object.fromEntries(context.map((edge) => [edge.input, edge.value])),
    });
    const governance = buildGraphStepGovernance(step, graphGrant);
    const transitionGate = admitGraphTransition(graph.policy, step.id, outputs);
    if (transitionGate.status === "deny") {
      const deniedRun = buildDeniedGraphStepRun({
        step,
        stepSkillPath,
        attempt: plan.attempt,
        parentReceipt: lastReceiptId,
        governance,
        context,
        stderr: transitionGate.reason,
      });
      const receipt = await writePolicyDeniedGraphReceipt({
        receiptDir,
        runxHome: options.runxHome ?? options.env?.RUNX_HOME,
        graph,
        graphId,
        startedAt,
        startedAtMs,
        inputs: options.inputs ?? {},
        stepRuns: [...stepRuns, deniedRun],
        errorMessage: transitionGate.reason,
        executionSemantics,
        receiptMetadata: inheritedReceiptMetadata,
      });
      return {
        status: "policy_denied",
        graph,
        stepId: step.id,
        skill: stepSkill,
        reasons: [transitionGate.reason],
        state,
        receipt,
      };
    }
    if (governance.scopeAdmission.status === "deny") {
      const deniedRun = buildDeniedGraphStepRun({
        step,
        stepSkillPath,
        attempt: plan.attempt,
        parentReceipt: lastReceiptId,
        governance,
        context,
      });
      const receipt = await writePolicyDeniedGraphReceipt({
        receiptDir,
        runxHome: options.runxHome ?? options.env?.RUNX_HOME,
        graph,
        graphId,
        startedAt,
        startedAtMs,
        inputs: options.inputs ?? {},
        stepRuns: [...stepRuns, deniedRun],
        errorMessage: governance.scopeAdmission.reasons?.join("; ") ?? "graph step scope denied",
        executionSemantics,
        receiptMetadata: inheritedReceiptMetadata,
      });
      return {
        status: "policy_denied",
        graph,
        stepId: step.id,
        skill: stepSkill,
        reasons: governance.scopeAdmission.reasons ?? [],
        state,
        receipt,
      };
    }
    const effectiveRetry = step.retry ?? stepSkill.retry;
    const retryContext = buildRetryReceiptContext(step, stepInputs, plan.attempt, stepSkill, effectiveRetry);
    const retryAdmission = admitRetryPolicy({
      stepId: step.id,
      retry: effectiveRetry,
      mutating: step.mutating || stepSkill.mutating === true,
      idempotencyKey: retryContext.idempotencyKey,
    });
    if (retryAdmission.status === "deny") {
      return {
        status: "policy_denied",
        graph,
        stepId: step.id,
        skill: stepSkill,
        reasons: retryAdmission.reasons,
        state,
      };
    }

    const stepStartedAt = new Date().toISOString();
    state = transitionSequentialGraph(state, {
      type: "start_step",
      stepId: step.id,
      at: stepStartedAt,
    });
    await reportGraphStepStarted(options.caller, step, resolvedStep.reference);
    await appendGraphStepStartedJournalEntry({
      receiptDir,
      runId: graphId,
      topLevelSkillName: graphProducerSkillName(options, graph),
      step,
      reference: resolvedStep.reference,
      createdAt: stepStartedAt,
    });

    const stepResult = await runResolvedSkill({
      skill: stepSkill,
      skillDirectory: graphStepExecutionDirectory(step, stepSkillPath, graphDirectory),
      inputs: stepInputs,
      caller: options.caller,
      env: options.env,
      receiptDir,
      runxHome: options.runxHome,
      journalDir: options.journalDir,
      parentReceipt: lastReceiptId,
      contextFrom: contextFromReceiptIds,
      adapters: options.adapters,
      allowedSourceTypes: options.allowedSourceTypes,
      authResolver: options.authResolver,
      receiptMetadata: mergeMetadata(
        inheritedReceiptMetadata,
        retryContext.receiptMetadata,
        governanceReceiptMetadata(step, governance),
      ),
      orchestrationRunId: graphId,
      orchestrationStepId: step.id,
      currentContext: context,
      registryStore: options.registryStore,
      skillCacheDir: options.skillCacheDir,
      projectMemory,
      projectConventions,
    });

    if (stepResult.status === "needs_resolution") {
      await reportGraphStepWaitingResolution(
        options.caller,
        step,
        resolvedStep.reference,
        stepResult.requests,
      );
      await appendPendingGraphJournalEntry({
        receiptDir,
        runId: graphId,
        topLevelSkillName: graphProducerSkillName(options, graph),
        stepId: step.id,
        kind: "step_waiting_resolution",
        detail: {
          request_ids: stepResult.requests.map((request) => request.id),
          resolution_kinds: Array.from(new Set(stepResult.requests.map((request) => request.kind))),
          runner: graphStepRunner(step) ?? "default",
          step_label: step.label,
        },
        createdAt: new Date().toISOString(),
      });
      return {
        status: "needs_resolution",
        graph,
        stepIds: [step.id],
        stepLabels: [step.label ?? step.id],
        skillPath: stepSkillPath,
        skill: stepSkill,
        requests: stepResult.requests,
        state,
        runId: graphId,
      };
    }

    if (stepResult.status === "policy_denied") {
      await reportGraphStepCompleted(options.caller, step, resolvedStep.reference, "failure", {
        reason: `policy denied: ${stepResult.reasons.join("; ")}`,
      });
      await appendJournalEntries({
        receiptDir,
        runId: graphId,
        entries: [
          createRunEventEntry({
            runId: graphId,
            stepId: step.id,
            producer: {
              skill: graphProducerSkillName(options, graph),
              runner: "graph",
            },
            kind: "step_failed",
            status: "failure",
            detail: {
              reason: `policy denied: ${stepResult.reasons.join("; ")}`,
            },
          }),
        ],
      });
      return {
        status: "policy_denied",
        graph,
        stepId: step.id,
        skill: stepResult.skill,
        reasons: stepResult.reasons,
        state: transitionSequentialGraph(state, {
          type: "step_failed",
          stepId: step.id,
          at: new Date().toISOString(),
          error: `policy denied: ${stepResult.reasons.join("; ")}`,
        }),
      };
    }

    const stepCompletedAt = new Date().toISOString();
    const artifactResult = materializeArtifacts({
      stdout: stepResult.execution.stdout,
      contract: stepResult.skill.artifacts,
      runId: graphId,
      stepId: step.id,
      producer: {
        skill: stepResult.skill.name,
        runner: stepResult.skill.source.type,
      },
      createdAt: stepCompletedAt,
    });
    const stepRun: GraphStepRun = {
      stepId: step.id,
      skill: resolvedStep.reference,
      skillPath: stepSkillPath,
      runner: graphStepRunner(step),
      attempt: plan.attempt,
      status: stepResult.status,
      receiptId: stepResult.receipt.id,
      stdout: stepResult.execution.stdout,
      stderr: stepResult.execution.stderr,
      parentReceipt: lastReceiptId,
      retry: retryContext.receipt,
      governance,
      artifactIds: artifactResult.envelopes.map((envelope) => envelope.meta.artifact_id),
      disposition: stepResult.receipt.disposition,
      inputContext: stepResult.receipt.input_context,
      outcomeState: stepResult.receipt.outcome_state,
      outcome: stepResult.receipt.outcome,
      surfaceRefs: stepResult.receipt.surface_refs,
      evidenceRefs: stepResult.receipt.evidence_refs,
      contextFrom: context.map((edge) => ({
        input: edge.input,
        fromStep: edge.fromStep,
        output: edge.output,
        receiptId: edge.receiptId,
      })),
    };
    stepRuns.push(stepRun);
    outputs.set(step.id, {
      status: stepResult.status,
      stdout: stepResult.execution.stdout,
      stderr: stepResult.execution.stderr,
      receiptId: stepResult.receipt.id,
      fields: artifactResult.fields,
      artifactIds: artifactResult.envelopes.map((envelope) => envelope.meta.artifact_id),
      artifacts: artifactResult.envelopes,
    });
    lastReceiptId = stepResult.receipt.id;
    finalOutput = stepResult.execution.stdout;
    await appendGraphJournalEntries({
      receiptDir,
      runId: graphId,
      topLevelSkillName: graphProducerSkillName(options, graph),
      stepId: step.id,
      skill: stepResult.skill,
      artifactEnvelopes: artifactResult.envelopes,
      receiptId: stepResult.receipt.id,
      status: stepResult.status,
      detail: {
        runner: graphStepRunner(step) ?? "default",
      },
      createdAt: stepCompletedAt,
    });

    state =
      stepResult.status === "success"
        ? transitionSequentialGraph(state, {
            type: "step_succeeded",
            stepId: step.id,
            at: stepCompletedAt,
            receiptId: stepResult.receipt.id,
            outputs: artifactResult.fields,
          })
        : transitionSequentialGraph(state, {
            type: "step_failed",
            stepId: step.id,
            at: stepCompletedAt,
            error: stepResult.execution.errorMessage ?? stepResult.execution.stderr,
          });
    await reportGraphStepCompleted(options.caller, step, resolvedStep.reference, stepResult.status, {
      receiptId: stepResult.receipt.id,
    });
  }

  const completedAt = new Date().toISOString();
  const receipt = await writeLocalGraphReceipt({
    receiptDir,
    runxHome: options.runxHome ?? options.env?.RUNX_HOME,
    graphId,
    graphName: graph.name,
    owner: graph.owner,
    status: state.status === "succeeded" ? "success" : "failure",
    inputs: options.inputs ?? {},
    output: finalOutput,
    steps: stepRuns.map(toGraphReceiptStep),
    syncPoints,
    startedAt,
    completedAt,
    durationMs: Date.now() - startedAtMs,
    errorMessage: finalError,
    disposition: executionSemantics.disposition,
    inputContext: executionSemantics.inputContext,
    outcomeState: executionSemantics.outcomeState,
    outcome: executionSemantics.outcome,
    surfaceRefs: executionSemantics.surfaceRefs,
    evidenceRefs: executionSemantics.evidenceRefs,
    metadata: inheritedReceiptMetadata,
  });
  await appendJournalEntries({
    receiptDir,
    runId: graphId,
    entries: [
      createRunEventEntry({
        runId: graphId,
        producer: {
          skill: graphProducerSkillName(options, graph),
          runner: "graph",
        },
        kind: "chain_completed",
        status: receipt.status,
        detail: {
          receipt_id: receipt.id,
          step_count: stepRuns.length,
        },
        createdAt: completedAt,
      }),
    ],
  });
  try {
    await indexReceiptIfEnabled(receipt, receiptDir, options);
  } catch (error) {
    await options.caller.report({
      type: "warning",
      message: "Local journal indexing failed after receipt write; continuing with the persisted receipt.",
      data: {
        receiptId: receipt.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
  await projectReflectIfEnabled({
    caller: options.caller,
    receipt,
    receiptDir,
    runId: graphId,
    skillName: graphProducerSkillName(options, graph),
    journalDir: options.journalDir,
    env: options.env,
    selectedRunnerName: options.selectedRunnerName,
    postRunReflectPolicy: options.postRunReflectPolicy,
    involvedAgentMediatedWork,
  });

  return {
    status: receipt.status,
    graph,
    state,
    steps: stepRuns,
    receipt,
    output: finalOutput,
    errorMessage: finalError,
  };
}

function resolveSequentialGraphFailureReason(
  plan: Extract<SequentialGraphPlan, { type: "failed" }>,
  state: SequentialGraphState,
  stepRuns: readonly GraphStepRun[],
): string {
  const stepState = state.steps.find((candidate) => candidate.stepId === plan.stepId);
  const stateError = stepState?.error?.trim();
  if (stateError && stateError !== plan.reason) {
    return stateError;
  }

  const stepRun = [...stepRuns]
    .reverse()
    .find((candidate) => candidate.stepId === plan.stepId && candidate.status === "failure");
  const runError = stepRun?.stderr.trim();
  if (runError && runError !== plan.reason) {
    return runError;
  }

  return plan.reason;
}

export async function inspectLocalGraph(options: InspectLocalGraphOptions): Promise<InspectLocalGraphResult> {
  const { receipt, verification } = await readVerifiedLocalReceipt(
    options.receiptDir ?? defaultReceiptDir(options.env),
    options.graphId,
    options.runxHome ?? options.env?.RUNX_HOME,
  );
  if (receipt.kind !== "graph_execution") {
    throw new Error(`Receipt ${options.graphId} is not a graph execution receipt.`);
  }

  return {
    receipt,
    verification,
    summary: {
      id: receipt.id,
      name: receipt.subject.graph_name,
      status: receipt.status,
      verification,
      steps: receipt.steps.map((step) => ({
        id: step.step_id,
        attempt: step.attempt,
        status: step.status,
        receiptId: step.receipt_id,
        fanoutGroup: step.fanout_group,
      })),
      syncPoints: (receipt.sync_points ?? []).map((syncPoint) => ({
        groupId: syncPoint.group_id,
        decision: syncPoint.decision,
        ruleFired: syncPoint.rule_fired,
        reason: syncPoint.reason,
      })),
    },
  };
}

export async function inspectLocalReceipt(options: InspectLocalReceiptOptions): Promise<InspectLocalReceiptResult> {
  const { receipt, verification } = await readVerifiedLocalReceipt(
    options.receiptDir ?? defaultReceiptDir(options.env),
    options.receiptId,
    options.runxHome ?? options.env?.RUNX_HOME,
  );
  return {
    receipt,
    verification,
    summary: summarizeLocalReceipt(receipt, verification),
  };
}

export async function listLocalHistory(options: ListLocalHistoryOptions = {}): Promise<ListLocalHistoryResult> {
  const receipts = await listVerifiedLocalReceipts(
    options.receiptDir ?? defaultReceiptDir(options.env),
    options.runxHome ?? options.env?.RUNX_HOME,
  );
  const normalizedQuery = options.query?.trim().toLowerCase();
  const skillFilter = options.skill?.trim().toLowerCase();
  const statusFilter = options.status?.trim().toLowerCase();
  const sourceFilter = options.sourceType?.trim().toLowerCase();
  const sinceMs = options.sinceMs;
  const untilMs = options.untilMs;
  return {
    receipts: receipts
      .map(({ receipt, verification }) => summarizeLocalReceipt(receipt, verification))
      .filter((summary) => {
        if (normalizedQuery) {
          const matchesQuery =
            summary.name.toLowerCase().includes(normalizedQuery) ||
            summary.id.toLowerCase().includes(normalizedQuery) ||
            (summary.sourceType?.toLowerCase().includes(normalizedQuery) ?? false);
          if (!matchesQuery) return false;
        }
        if (skillFilter && !summary.name.toLowerCase().includes(skillFilter)) {
          return false;
        }
        if (statusFilter && String(summary.status ?? "").toLowerCase() !== statusFilter) {
          return false;
        }
        if (sourceFilter && (summary.sourceType ?? "").toLowerCase() !== sourceFilter) {
          return false;
        }
        if (sinceMs !== undefined) {
          const startedMs = summary.startedAt ? Date.parse(summary.startedAt) : NaN;
          if (!Number.isFinite(startedMs) || startedMs < sinceMs) return false;
        }
        if (untilMs !== undefined) {
          const startedMs = summary.startedAt ? Date.parse(summary.startedAt) : NaN;
          if (!Number.isFinite(startedMs) || startedMs > untilMs) return false;
        }
        return true;
      })
      .slice(0, options.limit ?? receipts.length),
  };
}

async function indexReceiptIfEnabled(
  receipt: LocalReceipt,
  receiptDir: string,
  options: {
    readonly journalDir?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const journalDir = resolveOptionalJournalDir(options);
  if (!journalDir) {
    return;
  }
  await createFileJournalStore(journalDir).indexReceipt({
    receipt,
    receiptPath: path.join(receiptDir, `${receipt.id}.json`),
    project: resolveJournalProject(options.env),
  });
}

interface ReflectProjectionOptions {
  readonly caller: Caller;
  readonly receipt: LocalReceipt;
  readonly receiptDir: string;
  readonly runId: string;
  readonly skillName: string;
  readonly journalDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly selectedRunnerName?: string;
  readonly postRunReflectPolicy?: PostRunReflectPolicy;
  readonly involvedAgentMediatedWork: boolean;
}

interface LocalReflectProjection {
  readonly schema_version: "runx.reflect.v1";
  readonly skill_ref: string;
  readonly receipt_id: string;
  readonly run_id: string;
  readonly receipt_kind: LocalReceipt["kind"];
  readonly status: LocalReceipt["status"];
  readonly selected_runner?: string;
  readonly policy: PostRunReflectPolicy;
  readonly mediation: "agentic" | "deterministic";
  readonly summary: string;
  readonly signals: readonly string[];
  readonly journal: {
    readonly event_kinds: readonly string[];
    readonly artifact_count: number;
    readonly artifact_types: readonly string[];
  };
  readonly step_summary?: {
    readonly total_steps: number;
    readonly successful_steps: number;
    readonly failed_steps: number;
    readonly runner_types: readonly string[];
  };
  readonly projected_at: string;
}

async function projectReflectIfEnabled(options: ReflectProjectionOptions): Promise<void> {
  const policy = options.postRunReflectPolicy ?? "never";
  if (!shouldProjectReflect(policy, options.involvedAgentMediatedWork)) {
    return;
  }

  const journalDir = resolveOptionalJournalDir(options);
  if (!journalDir) {
    return;
  }

  const projectedAt = options.receipt.completed_at ?? new Date().toISOString();

  try {
    const journalEntries = await readJournalEntries(options.receiptDir, options.runId);
    const reflectFact = buildReflectProjection({
      receipt: options.receipt,
      runId: options.runId,
      skillName: options.skillName,
      selectedRunnerName: options.selectedRunnerName,
      policy,
      involvedAgentMediatedWork: options.involvedAgentMediatedWork,
      journalEntries,
      projectedAt,
    });
    const factEntry = await createFileJournalStore(journalDir).addFact({
      project: resolveJournalProject(options.env),
      scope: "reflect",
      key: `receipt:${options.receipt.id}`,
      value: reflectFact,
      source: "post_run.reflect",
      confidence: 1,
      freshness: "derived",
      receiptId: options.receipt.id,
      createdAt: projectedAt,
    });
    await appendJournalEntries({
      receiptDir: options.receiptDir,
      runId: options.runId,
      entries: [
        createRunEventEntry({
          runId: options.runId,
          producer: {
            skill: options.skillName,
            runner: options.receipt.kind === "graph_execution" ? "graph" : options.receipt.subject.source_type,
          },
          kind: "reflect_projected",
          status: "success",
          detail: {
            fact_entry_id: factEntry.entry_id,
            receipt_id: options.receipt.id,
            policy,
            mediation: reflectFact.mediation,
          },
          createdAt: projectedAt,
        }),
      ],
    });
  } catch (error) {
    await options.caller.report({
      type: "warning",
      message: "Post-run reflect projection failed; continuing with the persisted receipt.",
      data: {
        receiptId: options.receipt.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function buildReflectProjection(options: {
  readonly receipt: LocalReceipt;
  readonly runId: string;
  readonly skillName: string;
  readonly selectedRunnerName?: string;
  readonly policy: PostRunReflectPolicy;
  readonly involvedAgentMediatedWork: boolean;
  readonly journalEntries: readonly ArtifactEnvelope[];
  readonly projectedAt: string;
}): LocalReflectProjection {
  const eventKinds = uniqueStrings(
    options.journalEntries
      .filter((entry) => entry.type === "run_event")
      .map((entry) => String(entry.data.kind)),
  );
  const artifactEntries = options.journalEntries.filter((entry) => entry.type === null || !SYSTEM_ARTIFACT_TYPES.has(entry.type));
  const artifactTypes = uniqueStrings(
    artifactEntries
      .map((entry) => entry.type)
      .filter((type): type is string => typeof type === "string"),
  );
  const signals = [
    options.involvedAgentMediatedWork ? "agent-mediated" : "deterministic",
    options.receipt.kind === "graph_execution" ? "graph-execution" : "skill-execution",
    options.receipt.status === "failure" ? "run-failed" : "run-succeeded",
    ...(artifactEntries.length > 0 ? ["artifacts-emitted"] : []),
    ...(eventKinds.includes("step_waiting_resolution") ? ["paused-before-completion"] : []),
  ];

  const stepSummary =
    options.receipt.kind === "graph_execution"
      ? {
          total_steps: options.receipt.steps.length,
          successful_steps: options.receipt.steps.filter((step) => step.status === "success").length,
          failed_steps: options.receipt.steps.filter((step) => step.status === "failure").length,
          runner_types: uniqueStrings(options.receipt.steps.map((step) => step.runner ?? "default")),
        }
      : undefined;

  return {
    schema_version: "runx.reflect.v1",
    skill_ref: options.skillName,
    receipt_id: options.receipt.id,
    run_id: options.runId,
    receipt_kind: options.receipt.kind,
    status: options.receipt.status,
    selected_runner: options.selectedRunnerName,
    policy: options.policy,
    mediation: options.involvedAgentMediatedWork ? "agentic" : "deterministic",
    summary:
      options.receipt.kind === "graph_execution"
        ? `${options.skillName} ${options.receipt.status} with ${options.receipt.steps.length} step(s)`
        : `${options.skillName} ${options.receipt.status} via ${options.receipt.subject.source_type}`,
    signals,
    journal: {
      event_kinds: eventKinds,
      artifact_count: artifactEntries.length,
      artifact_types: artifactTypes,
    },
    step_summary: stepSummary,
    projected_at: options.projectedAt,
  };
}

function shouldProjectReflect(policy: PostRunReflectPolicy, involvedAgentMediatedWork: boolean): boolean {
  if (policy === "always") {
    return true;
  }
  if (policy === "auto") {
    return involvedAgentMediatedWork;
  }
  return false;
}

function resolveOptionalJournalDir(options: {
  readonly journalDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (options.journalDir) {
    return options.journalDir;
  }
  if (!options.env?.RUNX_JOURNAL_DIR) {
    return undefined;
  }
  return resolveRunxJournalDir(options.env);
}

function resolveJournalProject(env?: NodeJS.ProcessEnv): string {
  return path.resolve(env?.RUNX_PROJECT ?? env?.RUNX_CWD ?? env?.INIT_CWD ?? process.cwd());
}

function uniqueStrings(values: readonly (string | null | undefined)[]): readonly string[] {
  return Array.from(
    new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)),
  );
}

function isAgentMediatedSource(sourceType: string | undefined): boolean {
  return sourceType === "agent" || sourceType === "agent-step";
}

function summarizeLocalReceipt(receipt: LocalReceipt, verification: ReceiptVerification): LocalReceiptSummary {
  if (receipt.kind === "skill_execution") {
    return {
      id: receipt.id,
      kind: receipt.kind,
      status: receipt.status,
      verification,
      name: receipt.subject.skill_name,
      sourceType: receipt.subject.source_type,
      startedAt: receipt.started_at,
      completedAt: receipt.completed_at,
    };
  }

  return {
    id: receipt.id,
    kind: receipt.kind,
    status: receipt.status,
    verification,
    name: receipt.subject.graph_name,
    startedAt: receipt.started_at,
    completedAt: receipt.completed_at,
  };
}

interface GraphStepOutput {
  readonly status: "success" | "failure";
  readonly stdout: string;
  readonly stderr: string;
  readonly receiptId: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly artifactIds: readonly string[];
  readonly artifacts: readonly ArtifactEnvelope[];
}

interface MaterializedContextEdge {
  readonly input: string;
  readonly fromStep: string;
  readonly output: string;
  readonly receiptId?: string;
  readonly artifact?: ArtifactEnvelope;
  readonly value: unknown;
}

function findGraphStep(graph: ExecutionGraph, stepId: string): GraphStep {
  const step = graph.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new Error(`Chain step '${stepId}' is missing.`);
  }
  return step;
}

function graphStepReference(step: GraphStep): string {
  return step.skill ?? step.tool ?? `run:${String(step.run?.type ?? "unknown")}`;
}

function graphStepRunner(step: GraphStep): string | undefined {
  if (step.tool) {
    return "tool";
  }
  return typeof step.run?.type === "string" ? step.run.type : step.runner;
}

function graphProducerSkillName(options: RunLocalGraphOptions, graph: ExecutionGraph): string {
  return options.skillEnvironment?.name ?? graph.name;
}

function materializeContext(
  step: GraphStep,
  outputs: ReadonlyMap<string, GraphStepOutput>,
): readonly MaterializedContextEdge[] {
  return step.contextEdges.map((edge) => {
    const sourceOutput = outputs.get(edge.fromStep);
    if (!sourceOutput) {
      throw new Error(`Step '${step.id}' is missing context output from '${edge.fromStep}'.`);
    }

    return {
      input: edge.input,
      fromStep: edge.fromStep,
      output: edge.output,
      receiptId: sourceOutput.receiptId,
      artifact: resolveOutputArtifact(sourceOutput, edge.output),
      value: resolveOutputPath(sourceOutput, edge.output),
    };
  });
}

function resolveOutputArtifact(output: GraphStepOutput, outputPath: string): ArtifactEnvelope | undefined {
  const [field] = outputPath.split(".", 1);
  if (!field) {
    return undefined;
  }
  const candidate = output.fields[field];
  return isArtifactEnvelopeValue(candidate) ? candidate : undefined;
}

function resolveOutputPath(output: GraphStepOutput, outputPath: string): unknown {
  const record: Record<string, unknown> = {
    ...output.fields,
    status: output.status,
    stdout: output.stdout,
    stderr: output.stderr,
    receipt_id: output.receiptId,
    receiptId: output.receiptId,
  };

  return outputPath.split(".").reduce<unknown>((value, key) => {
    if (!isRecord(value) || !(key in value)) {
      throw new Error(`Context output path '${outputPath}' was not produced by the source step.`);
    }
    return value[key];
  }, record);
}

const MAX_HISTORICAL_AGENT_ARTIFACTS = 12;

interface PreparedAgentContext {
  readonly currentContext: readonly ArtifactEnvelope[];
  readonly historicalContext: readonly ArtifactEnvelope[];
  readonly provenance: readonly AgentContextProvenance[];
  readonly projectMemory?: ProjectMemory;
  readonly projectConventions?: ProjectConventions;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
}

interface ProjectDocumentReceiptRef {
  readonly root_path: string;
  readonly path: string;
  readonly sha256: string;
}

function isArtifactEnvelopeValue(value: unknown): value is ArtifactEnvelope {
  if (!isPlainRecord(value) || !isPlainRecord(value.meta)) {
    return false;
  }
  return (
    typeof value.version === "string"
    && "data" in value
    && typeof value.meta.artifact_id === "string"
    && typeof value.meta.run_id === "string"
  );
}

function isDomainArtifactEnvelope(entry: ArtifactEnvelope): boolean {
  return entry.type !== null && !SYSTEM_ARTIFACT_TYPES.has(entry.type);
}

function dedupeArtifacts(artifacts: readonly ArtifactEnvelope[]): readonly ArtifactEnvelope[] {
  const seen = new Set<string>();
  const uniqueArtifacts: ArtifactEnvelope[] = [];
  for (const artifact of artifacts) {
    if (seen.has(artifact.meta.artifact_id)) {
      continue;
    }
    seen.add(artifact.meta.artifact_id);
    uniqueArtifacts.push(artifact);
  }
  return uniqueArtifacts;
}

async function loadProjectMemory(options: {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly fallbackStart?: string;
}): Promise<ProjectMemory | undefined> {
  return await loadProjectDocument({
    fileName: "MEMORY.md",
    inputs: options.inputs,
    env: options.env,
    fallbackStart: options.fallbackStart,
  });
}

async function loadProjectConventions(options: {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly fallbackStart?: string;
}): Promise<ProjectConventions | undefined> {
  return await loadProjectDocument({
    fileName: "CONVENTIONS.md",
    inputs: options.inputs,
    env: options.env,
    fallbackStart: options.fallbackStart,
  });
}

function projectMemoryReceiptMetadata(projectMemory: ProjectMemory | undefined): Readonly<Record<string, unknown>> | undefined {
  return projectMemory
    ? {
        project_memory: toProjectDocumentReceiptRef(projectMemory),
      }
    : undefined;
}

function projectConventionsReceiptMetadata(
  projectConventions: ProjectConventions | undefined,
): Readonly<Record<string, unknown>> | undefined {
  return projectConventions
    ? {
        project_conventions: toProjectDocumentReceiptRef(projectConventions),
      }
    : undefined;
}

function toProjectDocumentReceiptRef(document: {
  readonly root_path: string;
  readonly path: string;
  readonly sha256: string;
}): ProjectDocumentReceiptRef {
  return {
    root_path: document.root_path,
    path: document.path,
    sha256: document.sha256,
  };
}

function resolveProjectDocumentSearchStart(
  inputs: Readonly<Record<string, unknown>>,
  env?: NodeJS.ProcessEnv,
  fallbackStart?: string,
): string {
  const projectScope = resolveProjectScopePath(inputs, env);
  if (projectScope) {
    return projectScope;
  }
  return path.resolve(
    env?.RUNX_PROJECT
      ?? env?.RUNX_CWD
      ?? env?.INIT_CWD
      ?? fallbackStart
      ?? process.cwd(),
  );
}

async function loadProjectDocument(options: {
  readonly fileName: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly fallbackStart?: string;
}): Promise<{
  readonly root_path: string;
  readonly path: string;
  readonly sha256: string;
  readonly content: string;
} | undefined> {
  const searchStart = resolveProjectDocumentSearchStart(options.inputs, options.env, options.fallbackStart);
  const documentPath = await findNearestProjectDocument(searchStart, options.fileName);
  if (!documentPath) {
    return undefined;
  }
  const content = await readFile(documentPath, "utf8");
  return {
    root_path: path.dirname(documentPath),
    path: documentPath,
    sha256: hashString(content),
    content,
  };
}

async function findNearestProjectDocument(start: string, fileName: string): Promise<string | undefined> {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, fileName);
    if (await pathExists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function resolveProjectScopeKeyHash(
  inputs: Readonly<Record<string, unknown>>,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  const projectScope = resolveProjectScopePath(inputs, env);
  if (!projectScope) {
    return undefined;
  }
  return hashStable({ project_scope: projectScope });
}

function resolveProjectScopePath(
  inputs: Readonly<Record<string, unknown>>,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  const candidate =
    firstString(inputs.project)
    ?? firstString(inputs.repo_root)
    ?? firstString(inputs.repoRoot)
    ?? env?.RUNX_PROJECT
    ?? env?.RUNX_CWD
    ?? env?.INIT_CWD;
  if (!candidate) {
    return undefined;
  }
  return path.resolve(env?.RUNX_CWD ?? env?.INIT_CWD ?? process.cwd(), candidate);
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  return undefined;
}

function receiptProjectScopeKeyHash(receipt: LocalReceipt): string | undefined {
  if (receipt.kind !== "skill_execution" || !isPlainRecord(receipt.metadata)) {
    return undefined;
  }
  const contextScope = receipt.metadata.context_scope;
  if (!isPlainRecord(contextScope)) {
    return undefined;
  }
  const keyHash = contextScope.project_key_hash;
  return typeof keyHash === "string" ? keyHash : undefined;
}

async function loadHistoricalAgentContext(options: {
  readonly receiptDir: string;
  readonly skillName: string;
  readonly projectKeyHash?: string;
  readonly excludeRunId: string;
}): Promise<readonly ArtifactEnvelope[]> {
  if (!options.projectKeyHash) {
    return [];
  }
  const receipts = await listLocalReceipts(options.receiptDir);
  const candidate = receipts.find((receipt) =>
    receipt.kind === "skill_execution"
    && receipt.id !== options.excludeRunId
    && receipt.status === "success"
    && receipt.subject.skill_name === options.skillName
    && receiptProjectScopeKeyHash(receipt) === options.projectKeyHash
    && Array.isArray(receipt.artifact_ids)
    && receipt.artifact_ids.length > 0,
  );
  if (!candidate || candidate.kind !== "skill_execution") {
    return [];
  }
  const entries = await readJournalEntries(options.receiptDir, candidate.id);
  return entries.filter(isDomainArtifactEnvelope).slice(-MAX_HISTORICAL_AGENT_ARTIFACTS);
}

async function prepareAgentContext(options: {
  readonly skill: ValidatedSkill;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly receiptDir: string;
  readonly runId: string;
  readonly stepId?: string;
  readonly currentContext?: readonly MaterializedContextEdge[];
  readonly skillDirectory?: string;
  readonly projectMemory?: ProjectMemory;
  readonly projectConventions?: ProjectConventions;
}): Promise<PreparedAgentContext> {
  const currentContext = dedupeArtifacts(
    (options.currentContext ?? [])
      .map((edge) => edge.artifact)
      .filter((artifact): artifact is ArtifactEnvelope => artifact !== undefined && isDomainArtifactEnvelope(artifact)),
  );
  const provenance = (options.currentContext ?? [])
    .filter((edge) => edge.artifact !== undefined)
    .map((edge) => ({
      input: edge.input,
      output: edge.output,
      from_step: edge.fromStep,
      artifact_id: edge.artifact?.meta.artifact_id,
      receipt_id: edge.receiptId,
    }));
  const projectKeyHash = resolveProjectScopeKeyHash(options.inputs, options.env);
  const projectMemory =
    options.projectMemory
    ?? (await loadProjectMemory({
      inputs: options.inputs,
      env: options.env,
      fallbackStart: options.skillDirectory,
    }));
  const projectConventions =
    options.projectConventions
    ?? (await loadProjectConventions({
      inputs: options.inputs,
      env: options.env,
      fallbackStart: options.skillDirectory,
    }));
  const historicalContext = await loadHistoricalAgentContext({
    receiptDir: options.receiptDir,
    skillName: options.skill.name,
    projectKeyHash,
    excludeRunId: options.runId,
  });
  return {
    currentContext,
    historicalContext,
    provenance,
    projectMemory,
    projectConventions,
    receiptMetadata: projectKeyHash
      ? mergeMetadata(
        {
          context_scope: {
            project_key_hash: projectKeyHash,
          },
        },
        projectMemoryReceiptMetadata(projectMemory),
        projectConventionsReceiptMetadata(projectConventions),
      )
      : mergeMetadata(
        projectMemoryReceiptMetadata(projectMemory),
        projectConventionsReceiptMetadata(projectConventions),
      ),
  };
}

function defaultLocalGraphGrant(): GraphScopeGrant {
  return {
    grant_id: "local-default",
    scopes: ["*"],
  };
}

function buildGraphStepGovernance(step: GraphStep, graphGrant: GraphScopeGrant): GraphStepGovernance {
  const decision = admitGraphStepScopes({
    stepId: step.id,
    requestedScopes: step.scopes,
    grant: graphGrant,
  });
  return {
    scopeAdmission: {
      status: decision.status,
      requestedScopes: decision.requestedScopes,
      grantedScopes: decision.grantedScopes,
      grantId: decision.grantId,
      reasons: decision.status === "deny" ? decision.reasons : undefined,
    },
  };
}

function governanceReceiptMetadata(
  step: GraphStep,
  governance: GraphStepGovernance,
): Readonly<Record<string, unknown>> {
  return {
    chain_governance: {
      step_id: step.id,
      selected_runner: graphStepRunner(step) ?? "default",
      scope_admission: {
        status: governance.scopeAdmission.status,
        requested_scopes: governance.scopeAdmission.requestedScopes,
        granted_scopes: governance.scopeAdmission.grantedScopes,
        grant_id: governance.scopeAdmission.grantId,
        reasons: governance.scopeAdmission.reasons,
      },
    },
  };
}

function buildDeniedGraphStepRun(options: {
  readonly step: GraphStep;
  readonly stepSkillPath: string;
  readonly attempt: number;
  readonly parentReceipt?: string;
  readonly fanoutGroup?: string;
  readonly governance: GraphStepGovernance;
  readonly context: readonly MaterializedContextEdge[];
  readonly stderr?: string;
}): GraphStepRun {
  return {
    stepId: options.step.id,
    skill: graphStepReference(options.step),
    skillPath: options.stepSkillPath,
    runner: graphStepRunner(options.step),
    attempt: options.attempt,
    status: "failure",
    stdout: "",
    stderr: options.stderr ?? options.governance.scopeAdmission.reasons?.join("; ") ?? "graph step scope denied",
    parentReceipt: options.parentReceipt,
    fanoutGroup: options.fanoutGroup,
    governance: options.governance,
    artifactIds: [],
    disposition: "policy_denied",
    outcomeState: "complete",
    contextFrom: options.context.map((edge) => ({
      input: edge.input,
      fromStep: edge.fromStep,
      output: edge.output,
      receiptId: edge.receiptId,
    })),
  };
}

async function writePolicyDeniedGraphReceipt(options: {
  readonly receiptDir: string;
  readonly runxHome?: string;
  readonly graph: ExecutionGraph;
  readonly graphId: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly stepRuns: readonly GraphStepRun[];
  readonly errorMessage: string;
  readonly executionSemantics: NormalizedExecutionSemantics;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
}): Promise<LocalGraphReceipt> {
  return await writeLocalGraphReceipt({
    receiptDir: options.receiptDir,
    runxHome: options.runxHome,
    graphId: options.graphId,
    graphName: options.graph.name,
    owner: options.graph.owner,
    status: "failure",
    inputs: options.inputs,
    output: "",
    steps: options.stepRuns.map(toGraphReceiptStep),
    startedAt: options.startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - options.startedAtMs,
    errorMessage: options.errorMessage,
    disposition: "policy_denied",
    inputContext: options.executionSemantics.inputContext,
    outcomeState: options.executionSemantics.outcomeState,
    outcome: options.executionSemantics.outcome,
    surfaceRefs: options.executionSemantics.surfaceRefs,
    evidenceRefs: options.executionSemantics.evidenceRefs,
    metadata: options.receiptMetadata,
  });
}

function toGraphReceiptStep(step: GraphStepRun): GraphReceiptStep {
  return {
    step_id: step.stepId,
    attempt: step.attempt,
    skill: step.skill,
    runner: step.runner,
    status: step.status,
    receipt_id: step.receiptId,
    parent_receipt: step.parentReceipt,
    fanout_group: step.fanoutGroup,
    retry: step.retry
      ? {
          attempt: step.retry.attempt,
          max_attempts: step.retry.maxAttempts,
          rule_fired: step.retry.ruleFired,
          idempotency_key_hash: step.retry.idempotencyKeyHash,
        }
      : undefined,
    context_from: step.contextFrom.map((edge) => ({
      input: edge.input,
      from_step: edge.fromStep,
      output: edge.output,
      receipt_id: edge.receiptId,
    })),
    governance: step.governance ? toReceiptGovernance(step.governance) : undefined,
    artifact_ids: step.artifactIds && step.artifactIds.length > 0 ? step.artifactIds : undefined,
    disposition: step.disposition,
    input_context: step.inputContext,
    outcome_state: step.outcomeState,
    outcome: step.outcome,
    surface_refs: step.surfaceRefs,
    evidence_refs: step.evidenceRefs,
  };
}

function toReceiptGovernance(governance: GraphStepGovernance): GraphReceiptStep["governance"] {
  return {
    scope_admission: {
      status: governance.scopeAdmission.status,
      requested_scopes: governance.scopeAdmission.requestedScopes,
      granted_scopes: governance.scopeAdmission.grantedScopes,
      grant_id: governance.scopeAdmission.grantId,
      reasons: governance.scopeAdmission.reasons,
    },
  };
}

function toGraphReceiptSyncPoint(
  decision: FanoutSyncDecision,
  branchReceipts: readonly string[],
): GraphReceiptSyncPoint {
  return {
    group_id: decision.groupId,
    strategy: decision.strategy,
    decision: decision.decision,
    rule_fired: decision.ruleFired,
    reason: decision.reason,
    branch_count: decision.branchCount,
    success_count: decision.successCount,
    failure_count: decision.failureCount,
    required_successes: decision.requiredSuccesses,
    branch_receipts: branchReceipts,
    gate: decision.gate,
  };
}

function latestFanoutReceiptIds(stepRuns: readonly GraphStepRun[], groupId: string): readonly string[] {
  const latest = new Map<string, string>();
  for (const stepRun of stepRuns) {
    if (stepRun.fanoutGroup === groupId && stepRun.receiptId) {
      latest.set(stepRun.stepId, stepRun.receiptId);
    }
  }
  return Array.from(latest.values());
}

function parseStructuredOutput(stdout: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function loadValidatedSkill(skillPath: string, runner?: string): Promise<ValidatedSkill> {
  const resolvedSkill = await resolveSkillReference(skillPath);
  const rawSkill = parseSkillMarkdown(await readFile(resolvedSkill.skillPath, "utf8"));
  const selection = await resolveSkillRunner(
    validateSkill(rawSkill, { mode: "strict" }),
    resolvedSkill.skillPath,
    runner,
  );
  return selection.skill;
}

async function loadValidatedTool(toolName: string, searchFromDirectory: string): Promise<ValidatedSkill> {
  const resolvedTool = await resolveToolReference(toolName, searchFromDirectory);
  const manifestContents = await readFile(resolvedTool.toolPath, "utf8");
  const tool = validateToolManifest(parseToolManifestYaml(manifestContents));
  return validatedToolToExecutableSkill(tool);
}

function validatedToolToExecutableSkill(tool: ValidatedTool): ValidatedSkill {
  return {
    name: tool.name,
    description: tool.description,
    body: tool.description ?? "",
    source: tool.source,
    inputs: tool.inputs,
    risk: tool.risk,
    runtime: tool.runtime,
    retry: tool.retry,
    idempotency: tool.idempotency,
    mutating: tool.mutating,
    artifacts: tool.artifacts,
    runx: tool.runx,
    raw: {
      frontmatter: {},
      rawFrontmatter: "",
      body: tool.description ?? "",
    },
  };
}

async function resolveGraphStepSkillPath(
  stepSkill: string,
  graphDirectory: string,
  registryStore: RegistryStore | undefined,
  skillCacheDir: string | undefined,
): Promise<string> {
  if (isRegistryRef(stepSkill)) {
    if (!registryStore) {
      throw new Error(
        `Registry ref '${stepSkill}' used in graph step, but no registry store is configured. Pass registryStore to runLocalGraph, or set RUNX_REGISTRY_URL / RUNX_REGISTRY_DIR to a local registry path.`,
      );
    }
    const materialized = await materializeRegistrySkill({
      ref: stepSkill,
      store: registryStore,
      cacheDir: skillCacheDir ?? defaultRegistrySkillCacheDir(),
    });
    return materialized.skillDirectory;
  }
  return path.resolve(graphDirectory, stepSkill);
}

async function loadGraphStepExecutables(
  graph: ExecutionGraph,
  graphDirectory: string,
  registryStore?: RegistryStore,
  skillCacheDir?: string,
): Promise<ReadonlyMap<string, ValidatedSkill>> {
  const skills = new Map<string, ValidatedSkill>();
  for (const step of graph.steps) {
    if (step.skill) {
      const resolvedPath = await resolveGraphStepSkillPath(step.skill, graphDirectory, registryStore, skillCacheDir);
      skills.set(step.id, await loadValidatedSkill(resolvedPath, step.runner));
      continue;
    }
    if (step.tool) {
      skills.set(step.id, await loadValidatedTool(step.tool, graphDirectory));
    }
  }
  return skills;
}

async function resolveGraphStepExecution(options: {
  readonly step: GraphStep;
  readonly graphDirectory: string;
  readonly graphStepCache: ReadonlyMap<string, ValidatedSkill>;
  readonly skillEnvironment?: {
    readonly name: string;
    readonly body: string;
  };
  readonly registryStore?: RegistryStore;
  readonly skillCacheDir?: string;
}): Promise<{
  readonly skill: ValidatedSkill;
  readonly skillPath: string;
  readonly reference: string;
}> {
  if (options.step.skill) {
    const resolvedPath = await resolveGraphStepSkillPath(
      options.step.skill,
      options.graphDirectory,
      options.registryStore,
      options.skillCacheDir,
    );
    return {
      skill:
        options.graphStepCache.get(options.step.id)
        ?? (await loadValidatedSkill(resolvedPath, options.step.runner)),
      skillPath: resolvedPath,
      reference: options.step.skill,
    };
  }

  if (options.step.tool) {
    const resolvedTool = await resolveToolReference(options.step.tool, options.graphDirectory);
    return {
      skill: options.graphStepCache.get(options.step.id) ?? (await loadValidatedTool(options.step.tool, options.graphDirectory)),
      skillPath: resolvedTool.toolPath,
      reference: options.step.tool,
    };
  }

  if (!options.step.run) {
    throw new Error(`Chain step '${options.step.id}' is missing skill, tool, or run.`);
  }

  return {
    skill: buildInlineGraphStepSkill(options.step, options.skillEnvironment),
    skillPath: `inline:${options.step.id}`,
    reference: `run:${String(options.step.run.type)}`,
  };
}

function composeInlineStepBody(skillBody: string | undefined, step: GraphStep): string {
  const parts = [
    skillBody?.trim(),
    step.instructions?.trim(),
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));
  return parts.join("\n\n");
}

function buildInlineGraphStepSkill(
  step: GraphStep,
  skillEnvironment?: {
    readonly name: string;
    readonly body: string;
  },
): ValidatedSkill {
  if (!step.run) {
    throw new Error(`Chain step '${step.id}' is missing an inline run definition.`);
  }
  const body = composeInlineStepBody(skillEnvironment?.body, step);
  return {
    name: `${skillEnvironment?.name ?? "graph"}.${step.id}`,
    description: step.instructions,
    body,
    source: validateSkillSource(step.run),
    inputs: {},
    retry: step.retry,
    idempotency: step.idempotencyKey ? { key: step.idempotencyKey } : undefined,
    mutating: step.mutating,
    artifacts: validateSkillArtifactContract(step.artifacts, `steps.${step.id}.artifacts`),
    allowedTools: step.allowedTools,
    runx: step.allowedTools ? { allowed_tools: step.allowedTools } : undefined,
    raw: {
      frontmatter: {},
      rawFrontmatter: "",
      body,
    },
  };
}

function buildRetryReceiptContext(
  step: GraphStep,
  inputs: Readonly<Record<string, unknown>>,
  attempt: number,
  skill: ValidatedSkill,
  retry: { readonly maxAttempts: number } | undefined,
): {
  readonly idempotencyKey?: string;
  readonly receipt?: RetryReceiptContext;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
} {
  const maxAttempts = retry?.maxAttempts ?? 1;
  const idempotencyKey = resolveIdempotencyKey(step.idempotencyKey ?? skill.idempotency?.key, inputs);
  const idempotencyKeyHash = idempotencyKey ? hashStable({ idempotencyKey }) : undefined;
  if (maxAttempts <= 1 && !idempotencyKeyHash) {
    return {
      idempotencyKey,
    };
  }

  const receipt: RetryReceiptContext = {
    attempt,
    maxAttempts,
    ruleFired: attempt === 1 ? "initial_attempt" : "retry_attempt",
    idempotencyKeyHash,
  };
  return {
    idempotencyKey,
    receipt,
    receiptMetadata: {
      retry: {
        attempt,
        max_attempts: maxAttempts,
        rule_fired: receipt.ruleFired,
        idempotency_key_hash: idempotencyKeyHash,
      },
    },
  };
}

function resolveIdempotencyKey(template: string | undefined, inputs: Readonly<Record<string, unknown>>): string | undefined {
  if (!template) {
    return undefined;
  }
  const resolved = template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) =>
    stringifyContextValue(resolveInputPath(inputs, key)),
  );
  return resolved.trim() === "" ? undefined : resolved;
}

function resolveInputPath(inputs: Readonly<Record<string, unknown>>, inputPath: string): unknown {
  return inputPath.split(".").reduce<unknown>((value, key) => {
    if (!isRecord(value) || !(key in value)) {
      return undefined;
    }
    return value[key];
  }, inputs);
}

function stringifyContextValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function unique(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function mergeMetadata(
  ...metadata: readonly (Readonly<Record<string, unknown>> | undefined)[]
): Readonly<Record<string, unknown>> | undefined {
  const merged = metadata
    .filter((item): item is Readonly<Record<string, unknown>> => Boolean(item))
    .reduce<Record<string, unknown>>((accumulator, item) => mergeRecord(accumulator, item), {});
  if (Object.keys(merged).length === 0) {
    return undefined;
  }
  return merged;
}

function mergeRecord(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = merged[key];
    merged[key] = isPlainRecord(existing) && isPlainRecord(value) ? mergeRecord(existing, value) : value;
  }
  return merged;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultA2aAdapters(): readonly SkillAdapter[] {
  try {
    return [createA2aAdapter({ transport: createFixtureA2aTransport() })];
  } catch {
    return [];
  }
}

function runnerTrustMetadata(sourceType: string): Readonly<Record<string, unknown>> {
  const approvalMediated = sourceType === "approval";
  const agentMediated = sourceType === "agent" || sourceType === "agent-step";
  return {
    runner: {
      type: sourceType,
      enforcement: approvalMediated ? "approval-mediated" : agentMediated ? "agent-mediated" : "runx-enforced",
      attestation: approvalMediated ? "decision-reported" : agentMediated ? "agent-reported" : "runx-observed",
    },
  };
}

function normalizeQuestionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function buildAgentStepRequest(request: Parameters<SkillAdapter["invoke"]>[0]): AgentWorkRequest {
  const skillName = request.skillName ?? "agent-step";
  return {
    id: `agent_step.${normalizeQuestionId(request.source.task ?? skillName)}.output`,
    source_type: "agent-step",
    agent: request.source.agent,
    task: request.source.task,
    envelope: {
      run_id: request.runId ?? "rx_pending",
      step_id: request.stepId,
      skill: skillName,
      instructions: request.skillBody?.trim() ?? "",
      inputs: request.inputs,
      allowed_tools: request.allowedTools ?? [],
      current_context: request.currentContext ?? [],
      historical_context: request.historicalContext ?? [],
      provenance: request.contextProvenance ?? [],
      project_memory: request.projectMemory,
      project_conventions: request.projectConventions,
      expected_outputs: validateOutputContract(request.source.outputs, "source.outputs") ?? {},
      trust_boundary: "agent-mediated: runx yields skill context and receipts the supplied result on completion",
    },
  };
}

function buildAgentRunnerRequest(request: Parameters<SkillAdapter["invoke"]>[0]): AgentWorkRequest {
  const skillName = request.skillName ?? "skill";
  return {
    id: `agent.${normalizeQuestionId(skillName)}.output`,
    source_type: "agent",
    envelope: {
      run_id: request.runId ?? "rx_pending",
      step_id: request.stepId,
      skill: skillName,
      instructions: request.skillBody?.trim() ?? "",
      inputs: request.inputs,
      allowed_tools: request.allowedTools ?? [],
      current_context: request.currentContext ?? [],
      historical_context: request.historicalContext ?? [],
      provenance: request.contextProvenance ?? [],
      project_memory: request.projectMemory,
      project_conventions: request.projectConventions,
      trust_boundary: "agent-mediated: runx yields skill context and receipts the supplied result on completion",
    },
  };
}

function buildApprovalGate(request: Parameters<SkillAdapter["invoke"]>[0]): ApprovalGate {
  const summary = isPlainRecord(request.inputs.summary) ? request.inputs.summary : request.inputs;
  return {
    id: String(request.inputs.gate_id ?? `${request.skillName ?? "approval"}.gate`),
    type: "approval",
    reason:
      typeof request.inputs.reason === "string"
        ? request.inputs.reason
        : `Approval required for ${request.skillName ?? "approval"}.`,
    summary,
  };
}

function buildInputResolutionRequest(skill: ValidatedSkill, questions: readonly Question[]): ResolutionRequest {
  return {
    id: `input.${normalizeQuestionId(skill.name)}.${questions.map((question) => question.id).join(".")}`,
    kind: "input",
    questions,
  };
}

async function resolveInputs(
  skill: ValidatedSkill,
  options: RunLocalSkillOptions,
): Promise<
  | { readonly status: "resolved"; readonly inputs: Readonly<Record<string, unknown>> }
  | { readonly status: "needs_resolution"; readonly request: ResolutionRequest }
> {
  const answers = options.answersPath ? await readAnswersFile(options.answersPath) : {};
  const resolved = materializeDeclaredInputs(skill.inputs);
  const resumedInputs = options.resumeFromRunId
    ? await readResumedInputs(options.receiptDir ?? defaultReceiptDir(options.env), options.resumeFromRunId)
    : {};
  const providedInputs = normalizeDeclaredInputAliases(skill.inputs, options.inputs ?? {});

  assignDefined(resolved, resumedInputs);
  assignDefined(resolved, answers);
  assignDefined(resolved, providedInputs);

  const missing = missingRequiredInputs(skill.inputs, resolved);
  if (missing.length === 0) {
    return {
      status: "resolved",
      inputs: resolved,
    };
  }

  const request = buildInputResolutionRequest(skill, missing);
  await options.caller.report({
    type: "resolution_requested",
    message: `Resolution requested for ${request.id}.`,
    data: { kind: request.kind, requestId: request.id },
  });
  const resolution = await resolveCallerRequest(options.caller, request);
  if (resolution && isRecord(resolution.payload)) {
    Object.assign(resolved, resolution.payload);
  }
  if (resolution !== undefined) {
    await options.caller.report({
      type: "resolution_resolved",
      message: `Resolution satisfied for ${request.id}.`,
      data: { kind: request.kind, requestId: request.id, actor: resolution.actor },
    });
  }

  const stillMissing = missingRequiredInputs(skill.inputs, resolved);
  if (stillMissing.length > 0) {
    return {
      status: "needs_resolution",
      request: buildInputResolutionRequest(skill, stillMissing),
    };
  }

  return {
    status: "resolved",
    inputs: resolved,
  };
}

function normalizeDeclaredInputAliases(
  declaredInputs: Readonly<Record<string, SkillInput>>,
  providedInputs: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const normalized: Record<string, unknown> = {};
  const providedKeys = new Set(Object.keys(providedInputs));
  for (const [key, value] of Object.entries(providedInputs)) {
    const targetKey = resolveDeclaredInputAliasKey(declaredInputs, key);
    if (targetKey !== key && providedKeys.has(targetKey)) {
      continue;
    }
    normalized[targetKey] = value;
  }
  return normalized;
}

function materializeDeclaredInputs(
  declaredInputs: Readonly<Record<string, SkillInput>>,
  providedInputs: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, input] of Object.entries(declaredInputs)) {
    if (input.default !== undefined) {
      resolved[key] = input.default;
    }
  }
  assignDefined(resolved, normalizeDeclaredInputAliases(declaredInputs, providedInputs));
  return resolved;
}

function resolveDeclaredInputAliasKey(
  declaredInputs: Readonly<Record<string, SkillInput>>,
  key: string,
): string {
  if (declaredInputs[key] !== undefined) {
    return key;
  }
  const snakeCase = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
  if (snakeCase !== key && declaredInputs[snakeCase] !== undefined) {
    return snakeCase;
  }
  return key;
}

async function readResumedInputs(receiptDir: string, runId: string): Promise<Record<string, unknown>> {
  const entries = await readJournalEntries(receiptDir, runId);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "run_event") {
      continue;
    }
    const kind = typeof entry.data.kind === "string" ? entry.data.kind : "";
    const detail = isPlainRecord(entry.data.detail) ? entry.data.detail : undefined;
    if (!detail || kind !== "resolution_requested") {
      continue;
    }
    if (isPlainRecord(detail.inputs)) {
      return { ...detail.inputs };
    }
  }
  return {};
}

async function readResumedSelectedRunner(receiptDir: string, runId: string): Promise<string | undefined> {
  const entries = await readJournalEntries(receiptDir, runId);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "run_event") {
      continue;
    }
    const kind = typeof entry.data.kind === "string" ? entry.data.kind : "";
    const detail = isPlainRecord(entry.data.detail) ? entry.data.detail : undefined;
    if (!detail || kind !== "resolution_requested") {
      continue;
    }
    return typeof detail.selected_runner === "string" ? detail.selected_runner : undefined;
  }
  return undefined;
}

function assignDefined(target: Record<string, unknown>, value: Readonly<Record<string, unknown>>): void {
  for (const [key, candidate] of Object.entries(value)) {
    if (candidate !== undefined) {
      target[key] = candidate;
    }
  }
}

async function readAnswersFile(answersPath: string): Promise<Record<string, unknown>> {
  const contents = await readFile(path.resolve(answersPath), "utf8");
  const parsed = JSON.parse(contents) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("--answers file must contain a JSON object.");
  }

  const answers = parsed.answers;
  if (answers === undefined) {
    return parsed;
  }
  if (!isRecord(answers)) {
    throw new Error("--answers answers field must be an object.");
  }
  return answers;
}

function missingRequiredInputs(
  inputs: Readonly<Record<string, SkillInput>>,
  resolved: Readonly<Record<string, unknown>>,
): readonly Question[] {
  const questions: Question[] = [];

  for (const [id, input] of Object.entries(inputs)) {
    if (!input.required) {
      continue;
    }

    const value = resolved[id];
    if (value === undefined || value === null || value === "") {
      questions.push({
        id,
        prompt: input.description ?? `Provide ${id}`,
        description: input.description,
        required: true,
        type: input.type,
      });
    }
  }

  return questions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultReceiptDir(env: NodeJS.ProcessEnv | undefined): string {
  return path.resolve(env?.RUNX_RECEIPT_DIR ?? env?.INIT_CWD ?? process.cwd(), ".runx", "receipts");
}

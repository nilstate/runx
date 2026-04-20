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
  type Question,
  type ResolutionRequest,
  type ResolutionResponse,
  type SkillAdapter,
  validateOutputContract,
} from "../../executor/src/index.js";
import { createFileMemoryStore } from "../../memory/src/index.js";
import { resolveLocalSkillProfile } from "../../config/src/index.js";
import {
  parseChainYaml,
  parseRunnerManifestYaml,
  parseSkillMarkdown,
  parseToolManifestYaml,
  validateChain,
  validateSkillArtifactContract,
  validateRunnerManifest,
  validateSkillSource,
  validateSkill,
  validateToolManifest,
  type ChainDefinition,
  type ChainPolicy,
  type ChainStep,
  type SkillInput,
  type SkillRunnerDefinition,
  type SkillSandbox,
  type ValidatedTool,
  type ValidatedSkill,
} from "../../parser/src/index.js";
import {
  admitChainStepScopes,
  admitLocalSkill,
  admitRetryPolicy,
  sandboxRequiresApproval,
  type ChainScopeGrant,
  type LocalAdmissionGrant,
} from "../../policy/src/index.js";
import {
  hashStable,
  listLocalReceipts,
  listVerifiedLocalReceipts,
  readVerifiedLocalReceipt,
  uniqueReceiptId,
  writeLocalChainReceipt,
  writeLocalReceipt,
  type ChainReceiptStep,
  type ChainReceiptSyncPoint,
  type ExecutionSemantics,
  type GovernedDisposition,
  type LocalChainReceipt,
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
  createSequentialChainState,
  evaluateFanoutSync,
  planSequentialChainTransition,
  transitionSequentialChain,
  transitionSingleStep,
  type FanoutSyncDecision,
  type SequentialChainPlan,
  type SequentialChainState,
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
  readonly memoryDir?: string;
  readonly authResolver?: AuthResolver;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
  readonly resumeFromRunId?: string;
  readonly executionSemantics?: ExecutionSemantics;
  readonly registryStore?: RegistryStore;
  readonly skillCacheDir?: string;
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

function chainStepExecutionDirectory(step: ChainStep, stepExecutablePath: string, chainDirectory: string): string {
  return step.skill || step.tool ? path.dirname(stepExecutablePath) : chainDirectory;
}

async function reportChainStepStarted(caller: Caller, step: ChainStep, reference: string): Promise<void> {
  await caller.report({
    type: "step_started",
    message: `Starting step ${step.id}.`,
    data: {
      stepId: step.id,
      stepLabel: step.label,
      skill: reference,
      runner: chainStepRunner(step) ?? "default",
    },
  });
}

async function reportChainStepWaitingResolution(
  caller: Caller,
  step: ChainStep,
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
      runner: chainStepRunner(step) ?? "default",
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

async function reportChainStepCompleted(
  caller: Caller,
  step: ChainStep,
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
      runner: chainStepRunner(step) ?? "default",
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

export interface RunLocalChainOptions {
  readonly chainPath?: string;
  readonly chain?: ChainDefinition;
  readonly chainDirectory?: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly caller: Caller;
  readonly env?: NodeJS.ProcessEnv;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly adapters?: readonly SkillAdapter[];
  readonly allowedSourceTypes?: readonly string[];
  readonly authResolver?: AuthResolver;
  readonly chainGrant?: ChainScopeGrant;
  readonly runId?: string;
  readonly skillEnvironment?: {
    readonly name: string;
    readonly body: string;
  };
  readonly resumeFromRunId?: string;
  readonly executionSemantics?: ExecutionSemantics;
  readonly registryStore?: RegistryStore;
  readonly skillCacheDir?: string;
}

export interface ChainStepRun {
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
  readonly governance?: ChainStepGovernance;
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

interface ChainStepGovernance {
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

export type RunLocalChainResult =
  | {
      readonly status: "needs_resolution";
      readonly chain: ChainDefinition;
      readonly skillPath: string;
      readonly stepIds: readonly string[];
      readonly requests: readonly ResolutionRequest[];
      readonly skill: ValidatedSkill;
      readonly state: SequentialChainState;
      readonly runId: string;
      readonly stepLabels?: readonly string[];
    }
  | {
      readonly status: "policy_denied";
      readonly chain: ChainDefinition;
      readonly stepId: string;
      readonly skill: ValidatedSkill;
      readonly reasons: readonly string[];
      readonly state: SequentialChainState;
      readonly receipt?: LocalChainReceipt;
    }
  | {
      readonly status: "success" | "failure";
      readonly chain: ChainDefinition;
      readonly state: SequentialChainState;
      readonly steps: readonly ChainStepRun[];
      readonly receipt: LocalChainReceipt;
      readonly output: string;
      readonly errorMessage?: string;
    };

export interface InspectLocalChainOptions {
  readonly chainId: string;
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

export interface InspectLocalChainResult {
  readonly receipt: LocalChainReceipt;
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
      message: "Executing chain skill source.",
    });

    const chainResult = await runLocalChain({
      chain: materializeInlineChain(skill),
      chainDirectory: options.skillDirectory,
      inputs: options.inputs,
      caller: options.caller,
      env: options.env,
      receiptDir: options.receiptDir,
      runxHome: options.runxHome,
      adapters: options.adapters,
      allowedSourceTypes: options.allowedSourceTypes,
      authResolver: options.authResolver,
      runId: options.resumeFromRunId ?? uniqueReceiptId("cx"),
      skillEnvironment: {
        name: skill.name,
        body: skill.body,
      },
      resumeFromRunId: options.resumeFromRunId,
      executionSemantics: mergeExecutionSemantics(skill.execution, options.executionSemantics),
      registryStore: options.registryStore,
      skillCacheDir: options.skillCacheDir,
    });

    if (chainResult.status === "needs_resolution") {
      return {
        status: "needs_resolution",
        skill,
        skillPath: options.skillPathForMissingContext ?? options.skillDirectory,
        inputs: options.inputs,
        runId: chainResult.runId,
        requests: chainResult.requests,
        stepIds: chainResult.stepIds,
        stepLabels: chainResult.stepLabels,
      };
    }

    if (chainResult.status === "policy_denied") {
      return {
        status: "policy_denied",
        skill,
        reasons: chainResult.reasons,
      };
    }

    let state = createSingleStepState(skill.name);
    state = transitionSingleStep(state, { type: "admit" });
    state = transitionSingleStep(state, { type: "start", at: chainResult.receipt.started_at ?? new Date().toISOString() });
    if (chainResult.status === "success") {
      state = transitionSingleStep(state, {
        type: "succeed",
        at: chainResult.receipt.completed_at ?? new Date().toISOString(),
      });
    } else {
      state = transitionSingleStep(state, {
        type: "fail",
        at: chainResult.receipt.completed_at ?? new Date().toISOString(),
        error: chainResult.errorMessage ?? "chain execution failed",
      });
    }

    await options.caller.report({
      type: "completed",
      message: `Skill execution ${chainResult.status}.`,
      data: {
        receiptId: chainResult.receipt.id,
      },
    });

    return {
      status: chainResult.status,
      skill,
      inputs: options.inputs,
      execution: {
        status: chainResult.status,
        stdout: chainResult.output,
        stderr: chainResult.errorMessage ?? "",
        exitCode: chainResult.status === "success" ? 0 : 1,
        signal: null,
        durationMs: chainResult.receipt.duration_ms,
        errorMessage: chainResult.errorMessage,
        metadata: {
          composite: {
            chain_receipt_id: chainResult.receipt.id,
            top_level_skill: skill.name,
          },
        },
      },
      state,
      receipt: chainResult.receipt,
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
        options.receiptMetadata,
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
      message: "Local memory indexing failed after receipt write; continuing with the persisted receipt.",
      data: {
        receiptId: receipt.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }

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
  readonly executionSemantics: NormalizedExecutionSemantics;
  readonly runOptions: Pick<
    RunResolvedSkillOptions,
    "receiptDir" | "runxHome" | "env" | "receiptMetadata" | "parentReceipt" | "contextFrom"
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
        options.runOptions.receiptMetadata,
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

function materializeInlineChain(skill: ValidatedSkill): ChainDefinition {
  if (!skill.source.chain) {
    throw new Error(`Skill '${skill.name}' does not declare an inline chain.`);
  }
  return {
    ...skill.source.chain,
    name: skill.name,
  };
}

async function resolveChainExecution(options: RunLocalChainOptions): Promise<{
  readonly chain: ChainDefinition;
  readonly chainDirectory: string;
  readonly resolvedChainPath?: string;
}> {
  if (options.chain) {
    return {
      chain: options.chain,
      chainDirectory: path.resolve(options.chainDirectory ?? process.cwd()),
    };
  }
  if (!options.chainPath) {
    throw new Error("runLocalChain requires chainPath or chain.");
  }
  const resolvedChainPath = path.resolve(options.chainPath);
  return {
    chain: validateChain(parseChainYaml(await readFile(resolvedChainPath, "utf8"))),
    chainDirectory: path.dirname(resolvedChainPath),
    resolvedChainPath,
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

async function appendChainJournalEntries(options: {
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
    runner: "chain",
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

async function appendPendingChainJournalEntry(options: {
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
          runner: "chain",
        },
        kind: options.kind,
        status: "waiting",
        detail: options.detail,
        createdAt: options.createdAt,
      }),
    ],
  });
}

async function appendChainStepStartedJournalEntry(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly topLevelSkillName: string;
  readonly step: ChainStep;
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
          runner: "chain",
        },
        kind: "step_started",
        status: "started",
        detail: {
          skill: options.reference,
          runner: chainStepRunner(options.step) ?? "default",
        },
        createdAt: options.createdAt,
      }),
    ],
  });
}

function admitChainTransition(
  policy: ChainPolicy | undefined,
  stepId: string,
  outputs: ReadonlyMap<string, ChainStepOutput>,
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
  outputs: ReadonlyMap<string, ChainStepOutput>,
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

function hydrateChainFromJournal(options: {
  readonly entries: readonly ArtifactEnvelope[];
  readonly chain: ChainDefinition;
  readonly chainStepCache: ReadonlyMap<string, ValidatedSkill>;
  readonly skillEnvironment?: {
    readonly name: string;
    readonly body: string;
  };
  readonly chainSteps: readonly {
    readonly id: string;
    readonly contextFrom: readonly string[];
    readonly retry?: ChainStep["retry"];
    readonly fanoutGroup?: string;
  }[];
  readonly stepRuns: ChainStepRun[];
  readonly outputs: Map<string, ChainStepOutput>;
  readonly syncPoints: ChainReceiptSyncPoint[];
  readonly stateRef: {
    get value(): SequentialChainState;
    set value(next: SequentialChainState);
  };
  readonly lastReceiptRef: {
    get value(): string | undefined;
    set value(next: string | undefined);
  };
}): void {
  if (options.entries.length === 0) {
    return;
  }
  if (options.chain.steps.some((step) => step.fanoutGroup)) {
    throw new Error("resumeFromRunId currently supports sequential chains only.");
  }

  const stepsById = new Map(options.chain.steps.map((step) => [step.id, step]));
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
  for (const chainStep of options.chainSteps) {
    const step = stepsById.get(chainStep.id);
    const stepSkill =
      options.chainStepCache.get(chainStep.id)
      ?? (step?.run ? buildInlineChainStepSkill(step, options.skillEnvironment) : undefined);
    const event = latestEvents.get(chainStep.id);
    if (!step || !stepSkill || !event) {
      break;
    }
    const stepArtifacts = artifactsByStep.get(chainStep.id) ?? [];
    const stepFields = reconstructStepFields(stepArtifacts, stepSkill.artifacts);
    const receiptId = receiptLinksForStep(stepArtifacts, receiptLinks)[0];
    if (event.data.kind === "step_started") {
      state = transitionSequentialChain(state, {
        type: "start_step",
        stepId: chainStep.id,
        at: entryTimestamp(event),
      });
      break;
    }
    if (event.data.kind === "step_succeeded") {
      state = transitionSequentialChain(state, {
        type: "start_step",
        stepId: chainStep.id,
        at: entryTimestamp(event),
      });
      state = transitionSequentialChain(state, {
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
        skill: chainStepReference(step),
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
      state = transitionSequentialChain(state, {
        type: "start_step",
        stepId: chainStep.id,
        at: entryTimestamp(event),
      });
      state = transitionSequentialChain(state, {
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

export async function runLocalChain(options: RunLocalChainOptions): Promise<RunLocalChainResult> {
  const chainResolution = await resolveChainExecution(options);
  const receiptDir = options.receiptDir ?? defaultReceiptDir(options.env);
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const executionSemantics = normalizeExecutionSemantics(options.executionSemantics, options.inputs ?? {});
  const chain = chainResolution.chain;
  const chainDirectory = chainResolution.chainDirectory;
  const chainId = options.runId ?? options.resumeFromRunId ?? uniqueReceiptId("cx");
  const chainStepCache = await loadChainStepExecutables(chain, chainDirectory, options.registryStore, options.skillCacheDir);
  const chainGrant = options.chainGrant ?? defaultLocalChainGrant();
  const chainSteps = chain.steps.map((step) => ({
    id: step.id,
    contextFrom: unique(step.contextEdges.map((edge) => edge.fromStep)),
    retry: step.retry ?? chainStepCache.get(step.id)?.retry,
    fanoutGroup: step.fanoutGroup,
  }));
  let state = createSequentialChainState(chainId, chainSteps);
  const stepRuns: ChainStepRun[] = [];
  const syncPoints: ChainReceiptSyncPoint[] = [];
  const outputs = new Map<string, ChainStepOutput>();
  let lastReceiptId: string | undefined;
  let finalOutput = "";
  let finalError: string | undefined;
  if (options.resumeFromRunId) {
    hydrateChainFromJournal({
      entries: await readJournalEntries(receiptDir, options.resumeFromRunId),
      chain,
      chainStepCache,
      skillEnvironment: options.skillEnvironment,
      chainSteps,
      stepRuns,
      outputs,
      syncPoints,
      stateRef: {
        get value() {
          return state;
        },
        set value(next: SequentialChainState) {
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
  }

  await options.caller.report({
    type: "skill_loaded",
    message: `Loaded chain ${chain.name}.`,
    data: { chainPath: chainResolution.resolvedChainPath, chainId },
  });

  while (true) {
    const plan = planSequentialChainTransition(state, chainSteps, chain.fanoutGroups);
    if (plan.type === "complete") {
      state = transitionSequentialChain(state, { type: "complete" });
      break;
    }

    if (plan.type === "failed") {
      finalError = resolveSequentialChainFailureReason(plan, state, stepRuns);
      if (plan.syncDecision) {
        syncPoints.push(toChainReceiptSyncPoint(plan.syncDecision, latestFanoutReceiptIds(stepRuns, plan.syncDecision.groupId)));
      }
      state = transitionSequentialChain(state, { type: "fail_chain", error: finalError });
      break;
    }

    if (plan.type === "blocked") {
      finalError = plan.reason;
      if (plan.syncDecision) {
        syncPoints.push(toChainReceiptSyncPoint(plan.syncDecision, latestFanoutReceiptIds(stepRuns, plan.syncDecision.groupId)));
      }
      state = transitionSequentialChain(state, { type: "fail_chain", error: plan.reason });
      break;
    }

    if (plan.type === "run_fanout") {
      const fanoutParentReceipt = lastReceiptId;

      // Pre-flight: admission and retry checks (synchronous, before parallel execution)
      const branchPreps: Array<{
        step: ChainStep;
        stepSkillPath: string;
        stepSkill: ValidatedSkill;
        stepReference: string;
        stepInputs: Readonly<Record<string, unknown>>;
        context: ReturnType<typeof materializeContext>;
        contextFromReceiptIds: string[];
        governance: ReturnType<typeof buildChainStepGovernance>;
        retryContext: ReturnType<typeof buildRetryReceiptContext>;
      }> = [];

      for (const stepId of plan.stepIds) {
        const step = findChainStep(chain, stepId);
        const context = materializeContext(step, outputs);
        const contextFromReceiptIds = context
          .map((edge) => edge.receiptId)
          .filter((receiptId): receiptId is string => typeof receiptId === "string");
        const resolvedStep = await resolveChainStepExecution({
          step,
          chainDirectory,
          chainStepCache,
          skillEnvironment: options.skillEnvironment,
          registryStore: options.registryStore,
          skillCacheDir: options.skillCacheDir,
        });
        const stepSkillPath = resolvedStep.skillPath;
        const stepSkill = resolvedStep.skill;
        const stepInputs = materializeDeclaredInputs(stepSkill.inputs, {
          ...(options.inputs ?? {}),
          ...step.inputs,
          ...Object.fromEntries(context.map((edge) => [edge.input, edge.value])),
        });
        const governance = buildChainStepGovernance(step, chainGrant);

        if (governance.scopeAdmission.status === "deny") {
          const deniedRun = buildDeniedChainStepRun({
            step, stepSkillPath,
            attempt: plan.attempts[step.id] ?? 1,
            parentReceipt: fanoutParentReceipt,
            fanoutGroup: plan.groupId,
            governance, context,
          });
          const receipt = await writePolicyDeniedChainReceipt({
            receiptDir,
            runxHome: options.runxHome ?? options.env?.RUNX_HOME,
            chain, chainId, startedAt, startedAtMs,
            inputs: options.inputs ?? {},
            stepRuns: [...stepRuns, deniedRun],
            errorMessage: governance.scopeAdmission.reasons?.join("; ") ?? "chain step scope denied",
            executionSemantics,
          });
          return {
            status: "policy_denied", chain, stepId: step.id,
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
            status: "policy_denied", chain, stepId: step.id,
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
        state = transitionSequentialChain(state, {
          type: "start_step",
          stepId: prep.step.id,
          at: stepStartedAt,
        });
        await reportChainStepStarted(options.caller, prep.step, prep.stepReference);
        await appendChainStepStartedJournalEntry({
          receiptDir,
          runId: chainId,
          topLevelSkillName: chainProducerSkillName(options, chain),
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
            skillDirectory: chainStepExecutionDirectory(prep.step, prep.stepSkillPath, chainDirectory),
            inputs: prep.stepInputs,
            caller: options.caller,
            env: options.env,
            receiptDir,
            runxHome: options.runxHome,
            parentReceipt: fanoutParentReceipt,
            contextFrom: prep.contextFromReceiptIds,
            adapters: options.adapters,
            allowedSourceTypes: options.allowedSourceTypes,
            authResolver: options.authResolver,
            receiptMetadata: mergeMetadata(prep.retryContext.receiptMetadata, governanceReceiptMetadata(prep.step, prep.governance)),
            orchestrationRunId: chainId,
            orchestrationStepId: prep.step.id,
            currentContext: prep.context,
            registryStore: options.registryStore,
            skillCacheDir: options.skillCacheDir,
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
          state = transitionSequentialChain(state, {
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
          await reportChainStepWaitingResolution(
            options.caller,
            prep.step,
            prep.stepReference,
            stepResult.requests,
          );
          await appendPendingChainJournalEntry({
            receiptDir,
            runId: chainId,
            topLevelSkillName: chainProducerSkillName(options, chain),
            stepId: prep.step.id,
            kind: "step_waiting_resolution",
            detail: {
              request_ids: stepResult.requests.map((request) => request.id),
              resolution_kinds: Array.from(new Set(stepResult.requests.map((request) => request.kind))),
              runner: chainStepRunner(prep.step) ?? "default",
              step_label: prep.step.label,
            },
            createdAt: new Date().toISOString(),
          });
          continue;
        }

        // In fanout, policy_denied is a branch failure, not a chain halt.
        if (stepResult.status === "policy_denied") {
          await reportChainStepCompleted(
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
            runId: chainId,
            entries: [
              createRunEventEntry({
                runId: chainId,
                stepId: prep.step.id,
                producer: {
                  skill: chainProducerSkillName(options, chain),
                  runner: "chain",
                },
                kind: "step_failed",
                status: "failure",
                detail: {
                  reason: `policy denied: ${stepResult.reasons.join("; ")}`,
                },
              }),
            ],
          });
          state = transitionSequentialChain(state, {
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
          runId: chainId,
          stepId: prep.step.id,
          producer: {
            skill: stepResult.skill.name,
            runner: stepResult.skill.source.type,
          },
          createdAt: stepCompletedAt,
        });
        const stepRun: ChainStepRun = {
          stepId: prep.step.id,
          skill: prep.stepReference,
          skillPath: prep.stepSkillPath,
          runner: chainStepRunner(prep.step),
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
        await appendChainJournalEntries({
          receiptDir,
          runId: chainId,
          topLevelSkillName: chainProducerSkillName(options, chain),
          stepId: prep.step.id,
          skill: stepResult.skill,
          artifactEnvelopes: artifactResult.envelopes,
          receiptId: stepResult.receipt.id,
          status: stepResult.status,
          detail: {
            runner: chainStepRunner(prep.step) ?? "default",
          },
          createdAt: stepCompletedAt,
        });

        state = stepResult.status === "success"
          ? transitionSequentialChain(state, {
              type: "step_succeeded", stepId: prep.step.id,
              at: stepCompletedAt, receiptId: stepResult.receipt.id,
              outputs: artifactResult.fields,
            })
          : transitionSequentialChain(state, {
              type: "step_failed", stepId: prep.step.id,
              at: stepCompletedAt,
              error: stepResult.execution.errorMessage ?? stepResult.execution.stderr,
            });
        await reportChainStepCompleted(
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
          chain,
          stepIds: pendingStepIds,
          stepLabels: pendingStepLabels,
          skillPath: branchPreps.find((prep) => pendingStepIds.includes(prep.step.id))?.stepSkillPath ?? chainDirectory,
          skill: branchPreps.find((prep) => pendingStepIds.includes(prep.step.id))?.stepSkill ?? branchPreps[0]!.stepSkill,
          requests: pendingResolutionRequests,
          state,
          runId: chainId,
        };
      }

      const followUpPlan = planSequentialChainTransition(state, chainSteps, chain.fanoutGroups);
      if (followUpPlan.type === "run_fanout" && followUpPlan.groupId === plan.groupId) {
        continue;
      }
      if ((followUpPlan.type === "failed" || followUpPlan.type === "blocked") && followUpPlan.syncDecision?.groupId === plan.groupId) {
        finalError =
          followUpPlan.type === "failed"
            ? resolveSequentialChainFailureReason(followUpPlan, state, stepRuns)
            : followUpPlan.reason;
        syncPoints.push(toChainReceiptSyncPoint(followUpPlan.syncDecision, latestFanoutReceiptIds(stepRuns, plan.groupId)));
        state = transitionSequentialChain(state, { type: "fail_chain", error: finalError });
        break;
      }

      const policy = chain.fanoutGroups[plan.groupId];
      if (policy) {
        const decision = evaluateFanoutSync(
          policy,
          chainSteps
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
        syncPoints.push(toChainReceiptSyncPoint(decision, latestFanoutReceiptIds(stepRuns, plan.groupId)));
      }

      const groupReceiptIds = latestFanoutReceiptIds(stepRuns, plan.groupId);
      lastReceiptId = groupReceiptIds[groupReceiptIds.length - 1] ?? lastReceiptId;
      continue;
    }

    const step = findChainStep(chain, plan.stepId);
    const context = materializeContext(step, outputs);
    const contextFromReceiptIds = context
      .map((edge) => edge.receiptId)
      .filter((receiptId): receiptId is string => typeof receiptId === "string");
    const resolvedStep = await resolveChainStepExecution({
      step,
      chainDirectory,
      chainStepCache,
      skillEnvironment: options.skillEnvironment,
      registryStore: options.registryStore,
      skillCacheDir: options.skillCacheDir,
    });
    const stepSkillPath = resolvedStep.skillPath;
    const stepSkill = resolvedStep.skill;
    const stepInputs = materializeDeclaredInputs(stepSkill.inputs, {
      ...(options.inputs ?? {}),
      ...step.inputs,
      ...Object.fromEntries(context.map((edge) => [edge.input, edge.value])),
    });
    const governance = buildChainStepGovernance(step, chainGrant);
    const transitionGate = admitChainTransition(chain.policy, step.id, outputs);
    if (transitionGate.status === "deny") {
      const deniedRun = buildDeniedChainStepRun({
        step,
        stepSkillPath,
        attempt: plan.attempt,
        parentReceipt: lastReceiptId,
        governance,
        context,
        stderr: transitionGate.reason,
      });
      const receipt = await writePolicyDeniedChainReceipt({
        receiptDir,
        runxHome: options.runxHome ?? options.env?.RUNX_HOME,
        chain,
        chainId,
        startedAt,
        startedAtMs,
        inputs: options.inputs ?? {},
        stepRuns: [...stepRuns, deniedRun],
        errorMessage: transitionGate.reason,
        executionSemantics,
      });
      return {
        status: "policy_denied",
        chain,
        stepId: step.id,
        skill: stepSkill,
        reasons: [transitionGate.reason],
        state,
        receipt,
      };
    }
    if (governance.scopeAdmission.status === "deny") {
      const deniedRun = buildDeniedChainStepRun({
        step,
        stepSkillPath,
        attempt: plan.attempt,
        parentReceipt: lastReceiptId,
        governance,
        context,
      });
      const receipt = await writePolicyDeniedChainReceipt({
        receiptDir,
        runxHome: options.runxHome ?? options.env?.RUNX_HOME,
        chain,
        chainId,
        startedAt,
        startedAtMs,
        inputs: options.inputs ?? {},
        stepRuns: [...stepRuns, deniedRun],
        errorMessage: governance.scopeAdmission.reasons?.join("; ") ?? "chain step scope denied",
        executionSemantics,
      });
      return {
        status: "policy_denied",
        chain,
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
        chain,
        stepId: step.id,
        skill: stepSkill,
        reasons: retryAdmission.reasons,
        state,
      };
    }

    const stepStartedAt = new Date().toISOString();
    state = transitionSequentialChain(state, {
      type: "start_step",
      stepId: step.id,
      at: stepStartedAt,
    });
    await reportChainStepStarted(options.caller, step, resolvedStep.reference);
    await appendChainStepStartedJournalEntry({
      receiptDir,
      runId: chainId,
      topLevelSkillName: chainProducerSkillName(options, chain),
      step,
      reference: resolvedStep.reference,
      createdAt: stepStartedAt,
    });

    const stepResult = await runResolvedSkill({
      skill: stepSkill,
      skillDirectory: chainStepExecutionDirectory(step, stepSkillPath, chainDirectory),
      inputs: stepInputs,
      caller: options.caller,
      env: options.env,
      receiptDir,
      runxHome: options.runxHome,
      parentReceipt: lastReceiptId,
      contextFrom: contextFromReceiptIds,
      adapters: options.adapters,
      allowedSourceTypes: options.allowedSourceTypes,
      authResolver: options.authResolver,
      receiptMetadata: mergeMetadata(retryContext.receiptMetadata, governanceReceiptMetadata(step, governance)),
      orchestrationRunId: chainId,
      orchestrationStepId: step.id,
      currentContext: context,
      registryStore: options.registryStore,
      skillCacheDir: options.skillCacheDir,
    });

    if (stepResult.status === "needs_resolution") {
      await reportChainStepWaitingResolution(
        options.caller,
        step,
        resolvedStep.reference,
        stepResult.requests,
      );
      await appendPendingChainJournalEntry({
        receiptDir,
        runId: chainId,
        topLevelSkillName: chainProducerSkillName(options, chain),
        stepId: step.id,
        kind: "step_waiting_resolution",
        detail: {
          request_ids: stepResult.requests.map((request) => request.id),
          resolution_kinds: Array.from(new Set(stepResult.requests.map((request) => request.kind))),
          runner: chainStepRunner(step) ?? "default",
          step_label: step.label,
        },
        createdAt: new Date().toISOString(),
      });
      return {
        status: "needs_resolution",
        chain,
        stepIds: [step.id],
        stepLabels: [step.label ?? step.id],
        skillPath: stepSkillPath,
        skill: stepSkill,
        requests: stepResult.requests,
        state,
        runId: chainId,
      };
    }

    if (stepResult.status === "policy_denied") {
      await reportChainStepCompleted(options.caller, step, resolvedStep.reference, "failure", {
        reason: `policy denied: ${stepResult.reasons.join("; ")}`,
      });
      await appendJournalEntries({
        receiptDir,
        runId: chainId,
        entries: [
          createRunEventEntry({
            runId: chainId,
            stepId: step.id,
            producer: {
              skill: chainProducerSkillName(options, chain),
              runner: "chain",
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
        chain,
        stepId: step.id,
        skill: stepResult.skill,
        reasons: stepResult.reasons,
        state: transitionSequentialChain(state, {
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
      runId: chainId,
      stepId: step.id,
      producer: {
        skill: stepResult.skill.name,
        runner: stepResult.skill.source.type,
      },
      createdAt: stepCompletedAt,
    });
    const stepRun: ChainStepRun = {
      stepId: step.id,
      skill: resolvedStep.reference,
      skillPath: stepSkillPath,
      runner: chainStepRunner(step),
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
    await appendChainJournalEntries({
      receiptDir,
      runId: chainId,
      topLevelSkillName: chainProducerSkillName(options, chain),
      stepId: step.id,
      skill: stepResult.skill,
      artifactEnvelopes: artifactResult.envelopes,
      receiptId: stepResult.receipt.id,
      status: stepResult.status,
      detail: {
        runner: chainStepRunner(step) ?? "default",
      },
      createdAt: stepCompletedAt,
    });

    state =
      stepResult.status === "success"
        ? transitionSequentialChain(state, {
            type: "step_succeeded",
            stepId: step.id,
            at: stepCompletedAt,
            receiptId: stepResult.receipt.id,
            outputs: artifactResult.fields,
          })
        : transitionSequentialChain(state, {
            type: "step_failed",
            stepId: step.id,
            at: stepCompletedAt,
            error: stepResult.execution.errorMessage ?? stepResult.execution.stderr,
          });
    await reportChainStepCompleted(options.caller, step, resolvedStep.reference, stepResult.status, {
      receiptId: stepResult.receipt.id,
    });
  }

  const completedAt = new Date().toISOString();
  const receipt = await writeLocalChainReceipt({
    receiptDir,
    runxHome: options.runxHome ?? options.env?.RUNX_HOME,
    chainId,
    chainName: chain.name,
    owner: chain.owner,
    status: state.status === "succeeded" ? "success" : "failure",
    inputs: options.inputs ?? {},
    output: finalOutput,
    steps: stepRuns.map(toChainReceiptStep),
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
  });
  await appendJournalEntries({
    receiptDir,
    runId: chainId,
    entries: [
      createRunEventEntry({
        runId: chainId,
        producer: {
          skill: chainProducerSkillName(options, chain),
          runner: "chain",
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

  return {
    status: receipt.status,
    chain,
    state,
    steps: stepRuns,
    receipt,
    output: finalOutput,
    errorMessage: finalError,
  };
}

function resolveSequentialChainFailureReason(
  plan: Extract<SequentialChainPlan, { type: "failed" }>,
  state: SequentialChainState,
  stepRuns: readonly ChainStepRun[],
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

export async function inspectLocalChain(options: InspectLocalChainOptions): Promise<InspectLocalChainResult> {
  const { receipt, verification } = await readVerifiedLocalReceipt(
    options.receiptDir ?? defaultReceiptDir(options.env),
    options.chainId,
    options.runxHome ?? options.env?.RUNX_HOME,
  );
  if (receipt.kind !== "chain_execution") {
    throw new Error(`Receipt ${options.chainId} is not a chain execution receipt.`);
  }

  return {
    receipt,
    verification,
    summary: {
      id: receipt.id,
      name: receipt.subject.chain_name,
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
  receipt: LocalSkillReceipt,
  receiptDir: string,
  options: {
    readonly memoryDir?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const memoryDir = options.memoryDir ?? options.env?.RUNX_MEMORY_DIR;
  if (!memoryDir) {
    return;
  }
  await createFileMemoryStore(memoryDir).indexReceipt({
    receipt,
    receiptPath: path.join(receiptDir, `${receipt.id}.json`),
    project: options.env?.RUNX_PROJECT ?? options.env?.RUNX_CWD ?? options.env?.INIT_CWD ?? process.cwd(),
  });
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
    name: receipt.subject.chain_name,
    startedAt: receipt.started_at,
    completedAt: receipt.completed_at,
  };
}

interface ChainStepOutput {
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

function findChainStep(chain: ChainDefinition, stepId: string): ChainStep {
  const step = chain.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new Error(`Chain step '${stepId}' is missing.`);
  }
  return step;
}

function chainStepReference(step: ChainStep): string {
  return step.skill ?? step.tool ?? `run:${String(step.run?.type ?? "unknown")}`;
}

function chainStepRunner(step: ChainStep): string | undefined {
  if (step.tool) {
    return "tool";
  }
  return typeof step.run?.type === "string" ? step.run.type : step.runner;
}

function chainProducerSkillName(options: RunLocalChainOptions, chain: ChainDefinition): string {
  return options.skillEnvironment?.name ?? chain.name;
}

function materializeContext(
  step: ChainStep,
  outputs: ReadonlyMap<string, ChainStepOutput>,
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

function resolveOutputArtifact(output: ChainStepOutput, outputPath: string): ArtifactEnvelope | undefined {
  const [field] = outputPath.split(".", 1);
  if (!field) {
    return undefined;
  }
  const candidate = output.fields[field];
  return isArtifactEnvelopeValue(candidate) ? candidate : undefined;
}

function resolveOutputPath(output: ChainStepOutput, outputPath: string): unknown {
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
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
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
    receiptMetadata: projectKeyHash
      ? {
          context_scope: {
            project_key_hash: projectKeyHash,
          },
        }
      : undefined,
  };
}

function defaultLocalChainGrant(): ChainScopeGrant {
  return {
    grant_id: "local-default",
    scopes: ["*"],
  };
}

function buildChainStepGovernance(step: ChainStep, chainGrant: ChainScopeGrant): ChainStepGovernance {
  const decision = admitChainStepScopes({
    stepId: step.id,
    requestedScopes: step.scopes,
    grant: chainGrant,
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
  step: ChainStep,
  governance: ChainStepGovernance,
): Readonly<Record<string, unknown>> {
  return {
    chain_governance: {
      step_id: step.id,
      selected_runner: chainStepRunner(step) ?? "default",
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

function buildDeniedChainStepRun(options: {
  readonly step: ChainStep;
  readonly stepSkillPath: string;
  readonly attempt: number;
  readonly parentReceipt?: string;
  readonly fanoutGroup?: string;
  readonly governance: ChainStepGovernance;
  readonly context: readonly MaterializedContextEdge[];
  readonly stderr?: string;
}): ChainStepRun {
  return {
    stepId: options.step.id,
    skill: chainStepReference(options.step),
    skillPath: options.stepSkillPath,
    runner: chainStepRunner(options.step),
    attempt: options.attempt,
    status: "failure",
    stdout: "",
    stderr: options.stderr ?? options.governance.scopeAdmission.reasons?.join("; ") ?? "chain step scope denied",
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

async function writePolicyDeniedChainReceipt(options: {
  readonly receiptDir: string;
  readonly runxHome?: string;
  readonly chain: ChainDefinition;
  readonly chainId: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly stepRuns: readonly ChainStepRun[];
  readonly errorMessage: string;
  readonly executionSemantics: NormalizedExecutionSemantics;
}): Promise<LocalChainReceipt> {
  return await writeLocalChainReceipt({
    receiptDir: options.receiptDir,
    runxHome: options.runxHome,
    chainId: options.chainId,
    chainName: options.chain.name,
    owner: options.chain.owner,
    status: "failure",
    inputs: options.inputs,
    output: "",
    steps: options.stepRuns.map(toChainReceiptStep),
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
  });
}

function toChainReceiptStep(step: ChainStepRun): ChainReceiptStep {
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

function toReceiptGovernance(governance: ChainStepGovernance): ChainReceiptStep["governance"] {
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

function toChainReceiptSyncPoint(
  decision: FanoutSyncDecision,
  branchReceipts: readonly string[],
): ChainReceiptSyncPoint {
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

function latestFanoutReceiptIds(stepRuns: readonly ChainStepRun[], groupId: string): readonly string[] {
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

async function resolveChainStepSkillPath(
  stepSkill: string,
  chainDirectory: string,
  registryStore: RegistryStore | undefined,
  skillCacheDir: string | undefined,
): Promise<string> {
  if (isRegistryRef(stepSkill)) {
    if (!registryStore) {
      throw new Error(
        `Registry ref '${stepSkill}' used in chain step, but no registry store is configured. Pass registryStore to runLocalChain, or set RUNX_REGISTRY_URL / RUNX_REGISTRY_DIR to a local registry path.`,
      );
    }
    const materialized = await materializeRegistrySkill({
      ref: stepSkill,
      store: registryStore,
      cacheDir: skillCacheDir ?? defaultRegistrySkillCacheDir(),
    });
    return materialized.skillDirectory;
  }
  return path.resolve(chainDirectory, stepSkill);
}

async function loadChainStepExecutables(
  chain: ChainDefinition,
  chainDirectory: string,
  registryStore?: RegistryStore,
  skillCacheDir?: string,
): Promise<ReadonlyMap<string, ValidatedSkill>> {
  const skills = new Map<string, ValidatedSkill>();
  for (const step of chain.steps) {
    if (step.skill) {
      const resolvedPath = await resolveChainStepSkillPath(step.skill, chainDirectory, registryStore, skillCacheDir);
      skills.set(step.id, await loadValidatedSkill(resolvedPath, step.runner));
      continue;
    }
    if (step.tool) {
      skills.set(step.id, await loadValidatedTool(step.tool, chainDirectory));
    }
  }
  return skills;
}

async function resolveChainStepExecution(options: {
  readonly step: ChainStep;
  readonly chainDirectory: string;
  readonly chainStepCache: ReadonlyMap<string, ValidatedSkill>;
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
    const resolvedPath = await resolveChainStepSkillPath(
      options.step.skill,
      options.chainDirectory,
      options.registryStore,
      options.skillCacheDir,
    );
    return {
      skill:
        options.chainStepCache.get(options.step.id)
        ?? (await loadValidatedSkill(resolvedPath, options.step.runner)),
      skillPath: resolvedPath,
      reference: options.step.skill,
    };
  }

  if (options.step.tool) {
    const resolvedTool = await resolveToolReference(options.step.tool, options.chainDirectory);
    return {
      skill: options.chainStepCache.get(options.step.id) ?? (await loadValidatedTool(options.step.tool, options.chainDirectory)),
      skillPath: resolvedTool.toolPath,
      reference: options.step.tool,
    };
  }

  if (!options.step.run) {
    throw new Error(`Chain step '${options.step.id}' is missing skill, tool, or run.`);
  }

  return {
    skill: buildInlineChainStepSkill(options.step, options.skillEnvironment),
    skillPath: `inline:${options.step.id}`,
    reference: `run:${String(options.step.run.type)}`,
  };
}

function composeInlineStepBody(skillBody: string | undefined, step: ChainStep): string {
  const parts = [
    skillBody?.trim(),
    step.instructions?.trim(),
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));
  return parts.join("\n\n");
}

function buildInlineChainStepSkill(
  step: ChainStep,
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
    name: `${skillEnvironment?.name ?? "chain"}.${step.id}`,
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
  step: ChainStep,
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

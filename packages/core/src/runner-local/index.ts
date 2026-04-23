export const runnerLocalPackage = "@runxhq/core/runner-local";

export * from "./official-cache.js";
export * from "./registry-resolver.js";
export * from "./skill-install.js";
export * from "./history.js";
export { createCallerAgentAdapter, createCallerAgentStepAdapter, createCallerApprovalAdapter } from "./caller-adapters.js";
export type { MaterializedContextEdge } from "./graph-context.js";

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  materializeArtifacts,
  readLedgerEntries,
  type ArtifactContract,
  type ArtifactEnvelope,
} from "../artifacts/index.js";
import {
  appendGraphCompletedLedgerEntry,
  appendGraphLedgerEntries,
  appendGraphStepStartedLedgerEntry,
  appendGraphStepFailureLedgerEntry,
  appendPendingGraphLedgerEntry,
  appendPendingSkillLedgerEntries,
  appendSkillLedgerEntries,
} from "./graph-ledger.js";
import {
  graphProducerSkillName,
  graphStepExecutionDirectory,
  graphStepReference,
  graphStepRunner,
  reportGraphStepCompleted,
  reportGraphStepStarted,
  reportGraphStepWaitingResolution,
} from "./graph-reporting.js";
import { runFanout } from "./fanout.js";
import {
  createCallerAgentAdapter,
  createCallerAgentStepAdapter,
  createCallerApprovalAdapter,
} from "./caller-adapters.js";
import {
  type Context,
  type ContextDocument,
  executeSkill,
  type AdapterInvokeResult,
  type AgentWorkRequest,
  type ApprovalGate,
  type CredentialEnvelope,
  type ResolutionRequest,
  type ResolutionResponse,
  type SkillAdapter,
  validateOutputContract,
} from "../executor/index.js";
import {
  findGraphStep,
  materializeContext,
  resolveOutputPath,
  type GraphStepOutput,
  type MaterializedContextEdge,
} from "./graph-context.js";
import { createFileKnowledgeStore } from "../knowledge/index.js";
import {
  loadRunxWorkspacePolicy,
  resolveLocalSkillProfile,
  resolveRunxKnowledgeDir,
  type RunxWorkspacePolicy,
} from "../config/index.js";
import {
  contextReceiptMetadata,
  loadContext,
  loadVoiceProfile,
  prepareAgentContext,
  qualityProfileContext,
  skillQualityProfileReceiptMetadata,
  voiceProfileReceiptMetadata,
  type PreparedAgentContext,
} from "./context.js";
import {
  parseGraphYaml,
  parseRunnerManifestYaml,
  parseSkillMarkdown,
  extractSkillQualityProfile,
  parseToolManifestJson,
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
  type SkillRunnerDefinition,
  type SkillSandbox,
  type ValidatedTool,
  type ValidatedSkill,
} from "../parser/index.js";
import {
  admitLocalSkill,
  admitRetryPolicy,
  sandboxRequiresApproval,
  type GraphScopeGrant,
  type LocalAdmissionGrant,
} from "../policy/index.js";
import {
  hashString,
  hashStable,
  listLocalReceipts,
  uniqueReceiptId,
  writeLocalGraphReceipt,
  writeLocalReceipt,
  type GraphReceiptSyncPoint,
  type ExecutionSemantics,
  type GovernedDisposition,
  type LocalGraphReceipt,
  type LocalReceipt,
  type LocalSkillReceipt,
  type OutcomeState,
  type ReceiptInputContext,
  type ReceiptOutcome,
  type ReceiptSurfaceRef,
} from "../receipts/index.js";
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
} from "../state-machine/index.js";
import type { RegistryStore } from "../registry/index.js";
import {
  defaultRegistrySkillCacheDir,
  isRegistryRef,
  materializeRegistrySkill,
} from "./registry-resolver.js";
import {
  mergeExecutionSemantics,
  normalizeExecutionSemantics,
  type NormalizedExecutionSemantics,
} from "./execution-semantics.js";
import {
  buildDeniedGraphStepRun,
  buildGraphStepGovernance,
  governanceReceiptMetadata,
  latestFanoutReceiptIds,
  toGraphReceiptStep,
  toGraphReceiptSyncPoint,
  writePolicyDeniedGraphReceipt,
  type GraphStepGovernance,
} from "./graph-governance.js";
import { materializeDeclaredInputs, readResumedSelectedRunner, resolveInputs } from "./inputs.js";
import { defaultReceiptDir } from "./receipt-paths.js";
import {
  buildInlineGraphStepSkill,
  loadGraphStepExecutables,
  materializeInlineGraph,
  resolveGraphExecution,
  resolveGraphStepExecution,
  resolveSkillReference,
  resolveSkillRunner,
} from "./execution-targets.js";
import { projectReflectIfEnabled } from "./reflect.js";

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
  readonly knowledgeDir?: string;
  readonly authResolver?: AuthResolver;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
  readonly resumeFromRunId?: string;
  readonly executionSemantics?: ExecutionSemantics;
  readonly registryStore?: RegistryStore;
  readonly skillCacheDir?: string;
  readonly context?: Context;
  readonly voiceProfile?: ContextDocument;
  readonly voiceProfilePath?: string;
  readonly workspacePolicy?: RunxWorkspacePolicy;
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
  readonly knowledgeDir?: string;
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
  readonly context?: Context;
  readonly voiceProfile?: ContextDocument;
  readonly voiceProfilePath?: string;
  readonly selectedRunnerName?: string;
  readonly workspacePolicy?: RunxWorkspacePolicy;
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
  readonly context?: Context;
  readonly voiceProfile?: ContextDocument;
  readonly voiceProfilePath?: string;
  readonly knowledgeDir?: string;
  readonly selectedRunnerName?: string;
  readonly postRunReflectPolicy?: PostRunReflectPolicy;
  readonly workspacePolicy?: RunxWorkspacePolicy;
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

export async function runLocalSkill(options: RunLocalSkillOptions): Promise<RunLocalSkillResult> {
  const runId = options.resumeFromRunId ?? uniqueReceiptId("rx");
  const workspacePolicy = options.workspacePolicy ?? await loadRunxWorkspacePolicy(options.env ?? process.env);
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
    await appendPendingSkillLedgerEntries({
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
    knowledgeDir: options.knowledgeDir,
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
    context: options.context,
    voiceProfile: options.voiceProfile,
    voiceProfilePath: options.voiceProfilePath,
    selectedRunnerName: runnerSelection.selectedRunnerName,
    workspacePolicy,
  });

  if (result.status === "needs_resolution") {
    const pendingResult = {
      ...result,
      inputs: inputResolution.inputs,
    } satisfies Extract<RunLocalSkillResult, { readonly status: "needs_resolution" }>;
    await appendPendingSkillLedgerEntries({
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
  const workspacePolicy = options.workspacePolicy ?? await loadRunxWorkspacePolicy(options.env ?? process.env);
  const contextSnapshot =
    options.context
    ?? (await loadContext({
      inputs: options.inputs,
      env: options.env,
      fallbackStart: options.skillDirectory,
    }));
  const voiceProfile =
    options.voiceProfile
    ?? (await loadVoiceProfile({
      env: options.env,
      voiceProfilePath: options.voiceProfilePath,
    }));
  const inheritedReceiptMetadata = mergeMetadata(
    contextReceiptMetadata(contextSnapshot),
    voiceProfileReceiptMetadata(voiceProfile),
    skillQualityProfileReceiptMetadata(skill),
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
    executionPolicy: workspacePolicy,
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
    executionPolicy: workspacePolicy,
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
      knowledgeDir: options.knowledgeDir,
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
      context: contextSnapshot,
      voiceProfile,
      voiceProfilePath: options.voiceProfilePath,
      workspacePolicy,
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
    context: contextSnapshot,
    voiceProfile,
    voiceProfilePath: options.voiceProfilePath,
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
    ],
    env: options.env,
    credential: credentialResolution?.credential,
    allowedTools: executionSkill.allowedTools,
    runId: contextEnvelopeRunId,
    stepId: options.orchestrationStepId,
    currentContext: preparedAgentContext.currentContext,
    historicalContext: preparedAgentContext.historicalContext,
    contextProvenance: preparedAgentContext.provenance,
    context: preparedAgentContext.context,
    voiceProfile: preparedAgentContext.voiceProfile,
    qualityProfile: qualityProfileContext(skill),
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
  await appendSkillLedgerEntries({
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
      message: "Local knowledge indexing failed after receipt write; continuing with the persisted receipt.",
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
    knowledgeDir: options.knowledgeDir,
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

function hydrateGraphFromLedger(options: {
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
  const workspacePolicy = options.workspacePolicy ?? await loadRunxWorkspacePolicy(options.env ?? process.env);
  const receiptDir = options.receiptDir ?? defaultReceiptDir(options.env);
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const executionSemantics = normalizeExecutionSemantics(options.executionSemantics, options.inputs ?? {});
  const graph = graphResolution.graph;
  const graphDirectory = graphResolution.graphDirectory;
  const contextSnapshot =
    options.context
    ?? (await loadContext({
      inputs: options.inputs ?? {},
      env: options.env,
      fallbackStart: graphDirectory,
    }));
  const voiceProfile =
    options.voiceProfile
    ?? (await loadVoiceProfile({
      env: options.env,
      voiceProfilePath: options.voiceProfilePath,
    }));
  const inheritedReceiptMetadata = mergeMetadata(
    contextReceiptMetadata(contextSnapshot),
    voiceProfileReceiptMetadata(voiceProfile),
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
    hydrateGraphFromLedger({
      entries: await readLedgerEntries(receiptDir, options.resumeFromRunId),
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
        await appendGraphStepStartedLedgerEntry({
          receiptDir,
          runId: graphId,
          topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
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
            knowledgeDir: options.knowledgeDir,
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
            context: contextSnapshot,
            voiceProfile,
            voiceProfilePath: options.voiceProfilePath,
            workspacePolicy,
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
          await appendPendingGraphLedgerEntry({
            receiptDir,
            runId: graphId,
            topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
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
          await appendGraphStepFailureLedgerEntry({
            receiptDir,
            runId: graphId,
            topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
            stepId: prep.step.id,
            reason: `policy denied: ${stepResult.reasons.join("; ")}`,
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
        await appendGraphLedgerEntries({
          receiptDir,
          runId: graphId,
          topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
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
    await appendGraphStepStartedLedgerEntry({
      receiptDir,
      runId: graphId,
      topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
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
      knowledgeDir: options.knowledgeDir,
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
      context: contextSnapshot,
      voiceProfile,
      voiceProfilePath: options.voiceProfilePath,
      workspacePolicy,
    });

    if (stepResult.status === "needs_resolution") {
      await reportGraphStepWaitingResolution(
        options.caller,
        step,
        resolvedStep.reference,
        stepResult.requests,
      );
      await appendPendingGraphLedgerEntry({
        receiptDir,
        runId: graphId,
        topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
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
      await appendGraphStepFailureLedgerEntry({
        receiptDir,
        runId: graphId,
        topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
        stepId: step.id,
        reason: `policy denied: ${stepResult.reasons.join("; ")}`,
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
    await appendGraphLedgerEntries({
      receiptDir,
      runId: graphId,
      topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
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
  await appendGraphCompletedLedgerEntry({
    receiptDir,
    runId: graphId,
    topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
    receiptId: receipt.id,
    stepCount: stepRuns.length,
    status: receipt.status,
    createdAt: completedAt,
  });
  try {
    await indexReceiptIfEnabled(receipt, receiptDir, options);
  } catch (error) {
    await options.caller.report({
      type: "warning",
      message: "Local knowledge indexing failed after receipt write; continuing with the persisted receipt.",
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
    skillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
    knowledgeDir: options.knowledgeDir,
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

async function indexReceiptIfEnabled(
  receipt: LocalReceipt,
  receiptDir: string,
  options: {
    readonly knowledgeDir?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const knowledgeDir = resolveOptionalKnowledgeDir(options);
  if (!knowledgeDir) {
    return;
  }
  await createFileKnowledgeStore(knowledgeDir).indexReceipt({
    receipt,
    receiptPath: path.join(receiptDir, `${receipt.id}.json`),
    project: resolveKnowledgeProject(options.env),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDomainArtifactEnvelope(entry: ArtifactEnvelope): boolean {
  return entry.type !== null && !new Set(["run_event", "receipt_link", "credential_resolution", "retry", "skill_state", "auth_resolution"]).has(entry.type);
}

function isAgentMediatedSource(sourceType: string | undefined): boolean {
  return sourceType === "agent" || sourceType === "agent-step";
}

function resolveOptionalKnowledgeDir(options: {
  readonly knowledgeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (options.knowledgeDir) {
    return options.knowledgeDir;
  }
  if (!options.env?.RUNX_KNOWLEDGE_DIR) {
    return undefined;
  }
  return resolveRunxKnowledgeDir(options.env);
}

function resolveKnowledgeProject(env?: NodeJS.ProcessEnv): string {
  return path.resolve(env?.RUNX_PROJECT ?? env?.RUNX_CWD ?? env?.INIT_CWD ?? process.cwd());
}

function defaultLocalGraphGrant(): GraphScopeGrant {
  return {
    grant_id: "local-default",
    scopes: ["*"],
  };
}

function parseStructuredOutput(stdout: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
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

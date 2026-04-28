export const executorPackage = "@runxhq/core/executor";

import {
  RUNX_CONTROL_SCHEMA_REFS,
  validateAdapterInvokeResultContract,
  validateAgentContextEnvelopeContract,
  validateAgentWorkRequestContract,
  validateApprovalGateContract,
  validateCredentialEnvelopeContract,
  validateOutputContractContract,
  validateQuestionContract,
  validateResolutionRequestContract,
  validateResolutionResponseContract,
  type AdapterInvokeResultContract,
  type AgentContextEnvelopeContract,
  type AgentContextProvenanceContract,
  type AgentWorkRequestContract,
  type ArtifactEnvelopeContract,
  type ApprovalGateContract,
  type ApprovalResolutionRequestContract,
  type CognitiveResolutionRequestContract,
  type ContextContract,
  type ContextDocumentContract,
  type CredentialEnvelopeContract,
  type ExecutionLocationContract,
  type InputResolutionRequestContract,
  type OutputContractContract,
  type OutputContractEntryContract,
  type QualityProfileContextContract,
  type QuestionContract,
  type ResolutionRequestContract,
  type ResolutionResponseContract,
} from "@runxhq/contracts";
import type { SkillInput, ValidatedSkill, ValidatedTool } from "../parser/index.js";
import { asRecord } from "../util/types.js";

export const CONTROL_SCHEMA_REFS = {
  output_contract: RUNX_CONTROL_SCHEMA_REFS.output_contract,
  agent_context_envelope: RUNX_CONTROL_SCHEMA_REFS.agent_context_envelope,
  agent_work_request: RUNX_CONTROL_SCHEMA_REFS.agent_work_request,
  question: RUNX_CONTROL_SCHEMA_REFS.question,
  approval_gate: RUNX_CONTROL_SCHEMA_REFS.approval_gate,
  resolution_request: RUNX_CONTROL_SCHEMA_REFS.resolution_request,
  resolution_response: RUNX_CONTROL_SCHEMA_REFS.resolution_response,
  adapter_invoke_result: RUNX_CONTROL_SCHEMA_REFS.adapter_invoke_result,
  credential_envelope: RUNX_CONTROL_SCHEMA_REFS.credential_envelope,
} as const;

export type OutputContractEntry = OutputContractEntryContract;
export type OutputContract = OutputContractContract;
export type AgentContextProvenance = AgentContextProvenanceContract;
export type ContextDocument = ContextDocumentContract;
export type Context = ContextContract;
export type QualityProfileContext = QualityProfileContextContract;
export type ExecutionLocation = ExecutionLocationContract;
export type AgentContextEnvelope = AgentContextEnvelopeContract;
export type AgentWorkRequest = AgentWorkRequestContract;
export type Question = QuestionContract;
export type ApprovalGate = ApprovalGateContract;
export type InputResolutionRequest = InputResolutionRequestContract;
export type ApprovalResolutionRequest = ApprovalResolutionRequestContract;
export type CognitiveResolutionRequest = CognitiveResolutionRequestContract;
export type ResolutionRequest = ResolutionRequestContract;
export type ResolutionResponse = ResolutionResponseContract;

export interface ToolCatalogSearchResult {
  readonly tool_id: string;
  readonly name: string;
  readonly summary?: string;
  readonly source: string;
  readonly source_label: string;
  readonly source_type: string;
  readonly namespace: string;
  readonly external_name: string;
  readonly required_scopes: readonly string[];
  readonly tags: readonly string[];
  readonly catalog_ref: string;
}

export interface ToolCatalogSearchOptions {
  readonly limit?: number;
}

export interface ToolInspectProvenance {
  readonly origin: "local" | "imported";
  readonly source?: string;
  readonly source_label?: string;
  readonly source_type?: string;
  readonly namespace?: string;
  readonly external_name?: string;
  readonly catalog_ref?: string;
  readonly tool_id?: string;
  readonly tags?: readonly string[];
}

export interface ToolInspectResult {
  readonly ref: string;
  readonly name: string;
  readonly description?: string;
  readonly execution_source_type: string;
  readonly inputs: Readonly<Record<string, SkillInput>>;
  readonly scopes: readonly string[];
  readonly mutating?: boolean;
  readonly runtime?: unknown;
  readonly risk?: unknown;
  readonly runx?: Record<string, unknown>;
  readonly reference_path: string;
  readonly skill_directory: string;
  readonly provenance: ToolInspectProvenance;
}

export interface ToolCatalogInvokeRequest {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly resolvedInputs?: Readonly<Record<string, string>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly skillDirectory: string;
  readonly runId?: string;
  readonly stepId?: string;
}

export type ToolCatalogInvokeResult =
  | {
      readonly status: "success";
      readonly stdout: string;
      readonly stderr?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "failure";
      readonly stdout?: string;
      readonly stderr: string;
      readonly errorMessage?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    };

export interface ToolCatalogResolvedTool {
  readonly tool: ValidatedTool;
  readonly result: ToolCatalogSearchResult;
  readonly skillDirectory: string;
  readonly referencePath: string;
  readonly invoke: (request: ToolCatalogInvokeRequest) => Promise<ToolCatalogInvokeResult>;
}

export interface ToolCatalogAdapter {
  readonly source: string;
  readonly label: string;
  readonly search: (
    query: string,
    options?: ToolCatalogSearchOptions,
  ) => Promise<readonly ToolCatalogSearchResult[]>;
  readonly resolve?: (
    ref: string,
    options?: {
      readonly env?: NodeJS.ProcessEnv;
      readonly searchFromDirectory?: string;
    },
  ) => Promise<ToolCatalogResolvedTool | undefined>;
}

export interface AdapterInvokeRequest {
  readonly skillName?: string;
  readonly skillBody?: string;
  readonly allowedTools?: readonly string[];
  readonly source: ValidatedSkill["source"];
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly resolvedInputs?: Readonly<Record<string, string>>;
  readonly skillDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly credential?: CredentialEnvelope;
  readonly signal?: AbortSignal;
  readonly runId?: string;
  readonly stepId?: string;
  readonly currentContext?: readonly ArtifactEnvelopeContract[];
  readonly historicalContext?: readonly ArtifactEnvelopeContract[];
  readonly contextProvenance?: readonly AgentContextProvenance[];
  readonly context?: Context;
  readonly voiceProfile?: ContextDocument;
  readonly qualityProfile?: QualityProfileContext;
  readonly nestedSkillInvoker?: NestedSkillInvoker;
  readonly toolCatalogAdapters?: readonly ToolCatalogAdapter[];
}

export interface NestedSkillInvocation {
  readonly skill: ValidatedSkill;
  readonly skillDirectory: string;
  readonly requestedSkillPath: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
}

export type NestedSkillInvocationResult =
  | {
      readonly status: "needs_resolution";
      readonly request: ResolutionRequest;
      readonly receiptId?: string;
    }
  | {
      readonly status: "policy_denied";
      readonly reasons: readonly string[];
      readonly receiptId?: string;
      readonly errorMessage?: string;
    }
  | {
      readonly status: "success" | "failure";
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly durationMs: number;
      readonly errorMessage?: string;
      readonly receiptId?: string;
    };

export type NestedSkillInvoker = (
  options: NestedSkillInvocation,
) => Promise<NestedSkillInvocationResult>;

export type AdapterInvokeResult = AdapterInvokeResultContract;

export interface SkillAdapter {
  // Execution adapters do work for one source type. They do not own
  // approvals, receipts, or host interaction; the kernel mediates those
  // boundaries and surfaces resolve them.
  readonly type: string;
  readonly invoke: (request: AdapterInvokeRequest) => Promise<AdapterInvokeResult>;
}

export type CredentialEnvelope = CredentialEnvelopeContract;

export interface ExecuteSkillOptions {
  readonly skill: ValidatedSkill;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly resolvedInputs?: Readonly<Record<string, string>>;
  readonly skillDirectory: string;
  readonly adapters: readonly SkillAdapter[];
  readonly env?: NodeJS.ProcessEnv;
  readonly credential?: CredentialEnvelope;
  readonly signal?: AbortSignal;
  readonly allowedTools?: readonly string[];
  readonly runId?: string;
  readonly stepId?: string;
  readonly currentContext?: readonly ArtifactEnvelopeContract[];
  readonly historicalContext?: readonly ArtifactEnvelopeContract[];
  readonly contextProvenance?: readonly AgentContextProvenance[];
  readonly context?: Context;
  readonly voiceProfile?: ContextDocument;
  readonly qualityProfile?: QualityProfileContext;
  readonly nestedSkillInvoker?: NestedSkillInvoker;
  readonly toolCatalogAdapters?: readonly ToolCatalogAdapter[];
}

export async function executeSkill(options: ExecuteSkillOptions): Promise<AdapterInvokeResult> {
  const adapter = options.adapters.find((candidate) => candidate.type === options.skill.source.type);

  if (!adapter) {
    return {
      status: "failure",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      durationMs: 0,
      errorMessage: `No adapter registered for source type '${options.skill.source.type}'.`,
    };
  }

  return await adapter.invoke({
    skillName: options.skill.name,
    skillBody: options.skill.body,
    allowedTools: options.allowedTools ?? options.skill.allowedTools,
    source: options.skill.source,
    inputs: options.inputs,
    resolvedInputs: options.resolvedInputs,
    skillDirectory: options.skillDirectory,
    env: options.env,
    credential: options.credential ? validateCredentialEnvelope(options.credential, "credential") : undefined,
    signal: options.signal,
    runId: options.runId,
    stepId: options.stepId,
    currentContext: options.currentContext,
    historicalContext: options.historicalContext,
    contextProvenance: options.contextProvenance,
    context: options.context,
    voiceProfile: options.voiceProfile,
    qualityProfile: options.qualityProfile,
    nestedSkillInvoker: options.nestedSkillInvoker,
    toolCatalogAdapters: options.toolCatalogAdapters,
  });
}

export function validateOutputContract(value: unknown, label = "output_contract"): OutputContract | undefined {
  if (value === undefined) {
    return undefined;
  }
  return validateOutputContractContract(value, label);
}

export function validateAgentContextEnvelope(
  value: unknown,
  label = "agent_context_envelope",
): AgentContextEnvelope {
  return validateAgentContextEnvelopeContract(value, label);
}

export function validateAgentWorkRequest(value: unknown, label = "agent_work_request"): AgentWorkRequest {
  return validateAgentWorkRequestContract(value, label);
}

export function validateQuestion(value: unknown, label = "question"): Question {
  return validateQuestionContract(value, label);
}

export function validateApprovalGate(value: unknown, label = "approval_gate"): ApprovalGate {
  return validateApprovalGateContract(value, label);
}

export function validateResolutionRequest(value: unknown, label = "resolution_request"): ResolutionRequest {
  return validateResolutionRequestContract(value, label);
}

export function validateResolutionResponse(
  value: unknown,
  request?: ResolutionRequest,
  label = "resolution_response",
): ResolutionResponse {
  const response = validateResolutionResponseContract(value, label);
  const payload = response.payload;
  if (request?.kind === "approval" && typeof payload !== "boolean") {
    throw new Error(`${label}.payload must be boolean for approval requests.`);
  }
  if (request?.kind === "input") {
    const answers = asRecord(payload);
    if (!answers) {
      throw new Error(`${label}.payload must be an object for input requests.`);
    }
    for (const question of request.questions) {
      if (question.required && answers[question.id] === undefined) {
        throw new Error(`${label}.payload.${question.id} is required for input request '${request.id}'.`);
      }
    }
    return {
      actor: response.actor,
      payload: answers,
    };
  }
  if (request?.kind === "cognitive_work") {
    if (payload === undefined || payload === null || payload === "") {
      throw new Error(`${label}.payload is required for cognitive_work requests.`);
    }
  }

  return response;
}

export function validateAdapterInvokeResult(
  value: unknown,
  label = "adapter_invoke_result",
): AdapterInvokeResult {
  return validateAdapterInvokeResultContract(value, label);
}

export function validateCredentialEnvelope(
  value: unknown,
  label = "credential_envelope",
): CredentialEnvelope {
  return validateCredentialEnvelopeContract(value, label);
}


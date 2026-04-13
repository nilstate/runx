export const executorPackage = "@runx/executor";

import type { ArtifactEnvelope } from "../../artifacts/src/index.js";
import type { ValidatedSkill } from "../../parser/src/index.js";

export interface AgentContextProvenance {
  readonly input: string;
  readonly output: string;
  readonly from_step?: string;
  readonly artifact_id?: string;
  readonly receipt_id?: string;
}

export interface AgentContextEnvelope {
  readonly run_id: string;
  readonly step_id?: string;
  readonly skill: string;
  readonly instructions: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly allowed_tools: readonly string[];
  readonly current_context: readonly ArtifactEnvelope[];
  readonly historical_context: readonly ArtifactEnvelope[];
  readonly provenance: readonly AgentContextProvenance[];
  readonly expected_outputs?: Readonly<Record<string, unknown>>;
  readonly trust_boundary: string;
}

export interface AgentWorkRequest {
  readonly id: string;
  readonly source_type: "agent" | "agent-step";
  readonly agent?: string;
  readonly task?: string;
  readonly envelope: AgentContextEnvelope;
}

export interface Question {
  readonly id: string;
  readonly prompt: string;
  readonly description?: string;
  readonly required: boolean;
  readonly type: string;
}

export interface ApprovalGate {
  readonly id: string;
  readonly reason: string;
  readonly type?: string;
  readonly summary?: Readonly<Record<string, unknown>>;
}

export interface InputResolutionRequest {
  readonly id: string;
  readonly kind: "input";
  readonly questions: readonly Question[];
}

export interface ApprovalResolutionRequest {
  readonly id: string;
  readonly kind: "approval";
  readonly gate: ApprovalGate;
}

export interface CognitiveResolutionRequest {
  readonly id: string;
  readonly kind: "cognitive_work";
  readonly work: AgentWorkRequest;
}

export type ResolutionRequest =
  | InputResolutionRequest
  | ApprovalResolutionRequest
  | CognitiveResolutionRequest;

export interface ResolutionResponse {
  readonly actor: "human" | "agent";
  readonly payload: unknown;
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
  readonly currentContext?: readonly ArtifactEnvelope[];
  readonly historicalContext?: readonly ArtifactEnvelope[];
  readonly contextProvenance?: readonly AgentContextProvenance[];
}

export type AdapterInvokeResult =
  | {
      readonly status: "success" | "failure";
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly durationMs: number;
      readonly errorMessage?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "needs_resolution";
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: null;
      readonly signal: null;
      readonly durationMs: number;
      readonly request: ResolutionRequest;
      readonly errorMessage?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    };

export interface SkillAdapter {
  readonly type: string;
  readonly invoke: (request: AdapterInvokeRequest) => Promise<AdapterInvokeResult>;
}

export interface CredentialEnvelope {
  readonly kind: string;
  readonly grant_id: string;
  readonly provider: string;
  readonly connection_id: string;
  readonly scopes: readonly string[];
  readonly material_ref: string;
}

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
  readonly currentContext?: readonly ArtifactEnvelope[];
  readonly historicalContext?: readonly ArtifactEnvelope[];
  readonly contextProvenance?: readonly AgentContextProvenance[];
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
    credential: options.credential,
    signal: options.signal,
    runId: options.runId,
    stepId: options.stepId,
    currentContext: options.currentContext,
    historicalContext: options.historicalContext,
    contextProvenance: options.contextProvenance,
  });
}

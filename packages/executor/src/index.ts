export const executorPackage = "@runx/executor";

import type { ArtifactEnvelope } from "../../artifacts/src/index.js";
import type { ValidatedSkill } from "../../parser/src/index.js";

export const CONTROL_SCHEMA_REFS = {
  output_contract: "https://runx.ai/spec/output-contract.schema.json",
  agent_context_envelope: "https://runx.ai/spec/agent-context-envelope.schema.json",
  agent_work_request: "https://runx.ai/spec/agent-work-request.schema.json",
  question: "https://runx.ai/spec/question.schema.json",
  approval_gate: "https://runx.ai/spec/approval-gate.schema.json",
  resolution_request: "https://runx.ai/spec/resolution-request.schema.json",
  resolution_response: "https://runx.ai/spec/resolution-response.schema.json",
  adapter_invoke_result: "https://runx.ai/spec/adapter-invoke-result.schema.json",
  credential_envelope: "https://runx.ai/spec/credential-envelope.schema.json",
} as const;

export type OutputContractEntry =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "null"
  | Readonly<Record<string, unknown>>;

export type OutputContract = Readonly<Record<string, OutputContractEntry>>;

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
  readonly expected_outputs?: OutputContract;
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
  readonly kind: "runx.credential-envelope.v1";
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
    credential: options.credential ? validateCredentialEnvelope(options.credential, "credential") : undefined,
    signal: options.signal,
    runId: options.runId,
    stepId: options.stepId,
    currentContext: options.currentContext,
    historicalContext: options.historicalContext,
    contextProvenance: options.contextProvenance,
  });
}

export function validateOutputContract(value: unknown, label = "output_contract"): OutputContract | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${label} must match ${CONTROL_SCHEMA_REFS.output_contract}.`);
  }

  const normalized: Record<string, OutputContractEntry> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (isOutputContractScalar(entry)) {
      normalized[key] = entry;
      continue;
    }
    const outputSpec = asRecord(entry);
    if (!outputSpec) {
      throw new Error(`${label}.${key} must be a scalar output type or object (${CONTROL_SCHEMA_REFS.output_contract}).`);
    }
    const normalizedSpec: Record<string, unknown> = {};
    if (outputSpec.type !== undefined) {
      normalizedSpec.type = requireOutputScalar(outputSpec.type, `${label}.${key}.type`);
    }
    if (outputSpec.description !== undefined) {
      normalizedSpec.description = requireString(outputSpec.description, `${label}.${key}.description`, { allowEmpty: true });
    }
    if (outputSpec.required !== undefined) {
      normalizedSpec.required = requireBoolean(outputSpec.required, `${label}.${key}.required`);
    }
    if (outputSpec.wrap_as !== undefined) {
      normalizedSpec.wrap_as = requireString(outputSpec.wrap_as, `${label}.${key}.wrap_as`);
    }
    if (outputSpec.enum !== undefined) {
      normalizedSpec.enum = requireStringArray(outputSpec.enum, `${label}.${key}.enum`, { allowEmptyValues: true });
    }
    if (Object.keys(normalizedSpec).length === 0) {
      throw new Error(`${label}.${key} must declare at least one recognized output-contract field.`);
    }
    normalized[key] = normalizedSpec;
  }

  return normalized;
}

export function validateAgentContextEnvelope(
  value: unknown,
  label = "agent_context_envelope",
): AgentContextEnvelope {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${label} must match ${CONTROL_SCHEMA_REFS.agent_context_envelope}.`);
  }

  return {
    run_id: requireString(record.run_id, `${label}.run_id`),
    step_id: optionalString(record.step_id, `${label}.step_id`),
    skill: requireString(record.skill, `${label}.skill`),
    instructions: requireString(record.instructions, `${label}.instructions`),
    inputs: requireRecord(record.inputs, `${label}.inputs`),
    allowed_tools: requireStringArray(record.allowed_tools, `${label}.allowed_tools`, { allowEmptyValues: false }),
    current_context: requireArray(record.current_context, `${label}.current_context`) as readonly ArtifactEnvelope[],
    historical_context: requireArray(record.historical_context, `${label}.historical_context`) as readonly ArtifactEnvelope[],
    provenance: requireArray(record.provenance, `${label}.provenance`).map((entry, index) =>
      validateAgentContextProvenance(entry, `${label}.provenance[${index}]`)),
    expected_outputs: validateOutputContract(record.expected_outputs, `${label}.expected_outputs`),
    trust_boundary: requireString(record.trust_boundary, `${label}.trust_boundary`),
  };
}

export function validateAgentWorkRequest(value: unknown, label = "agent_work_request"): AgentWorkRequest {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${label} must match ${CONTROL_SCHEMA_REFS.agent_work_request}.`);
  }

  return {
    id: requireString(record.id, `${label}.id`),
    source_type: requireEnum(record.source_type, `${label}.source_type`, ["agent", "agent-step"]),
    agent: optionalString(record.agent, `${label}.agent`),
    task: optionalString(record.task, `${label}.task`),
    envelope: validateAgentContextEnvelope(record.envelope, `${label}.envelope`),
  };
}

export function validateQuestion(value: unknown, label = "question"): Question {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${label} must match ${CONTROL_SCHEMA_REFS.question}.`);
  }

  return {
    id: requireString(record.id, `${label}.id`),
    prompt: requireString(record.prompt, `${label}.prompt`),
    description: optionalString(record.description, `${label}.description`, { allowEmpty: true }),
    required: requireBoolean(record.required, `${label}.required`),
    type: requireString(record.type, `${label}.type`),
  };
}

export function validateApprovalGate(value: unknown, label = "approval_gate"): ApprovalGate {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${label} must match ${CONTROL_SCHEMA_REFS.approval_gate}.`);
  }

  return {
    id: requireString(record.id, `${label}.id`),
    reason: requireString(record.reason, `${label}.reason`),
    type: optionalString(record.type, `${label}.type`, { allowEmpty: true }),
    summary: record.summary === undefined ? undefined : requireRecord(record.summary, `${label}.summary`),
  };
}

export function validateResolutionRequest(value: unknown, label = "resolution_request"): ResolutionRequest {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${label} must match ${CONTROL_SCHEMA_REFS.resolution_request}.`);
  }

  const kind = requireEnum(record.kind, `${label}.kind`, ["input", "approval", "cognitive_work"]);
  if (kind === "input") {
    return {
      id: requireString(record.id, `${label}.id`),
      kind,
      questions: requireArray(record.questions, `${label}.questions`).map((entry, index) =>
        validateQuestion(entry, `${label}.questions[${index}]`)),
    };
  }
  if (kind === "approval") {
    return {
      id: requireString(record.id, `${label}.id`),
      kind,
      gate: validateApprovalGate(record.gate, `${label}.gate`),
    };
  }
  return {
    id: requireString(record.id, `${label}.id`),
    kind,
    work: validateAgentWorkRequest(record.work, `${label}.work`),
  };
}

export function validateResolutionResponse(
  value: unknown,
  request?: ResolutionRequest,
  label = "resolution_response",
): ResolutionResponse {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${label} must match ${CONTROL_SCHEMA_REFS.resolution_response}.`);
  }

  const actor = requireEnum(record.actor, `${label}.actor`, ["human", "agent"]);
  if (!Object.prototype.hasOwnProperty.call(record, "payload")) {
    throw new Error(`${label}.payload is required (${CONTROL_SCHEMA_REFS.resolution_response}).`);
  }

  const payload = record.payload;
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
      actor,
      payload: answers,
    };
  }
  if (request?.kind === "cognitive_work") {
    if (payload === undefined || payload === null || payload === "") {
      throw new Error(`${label}.payload is required for cognitive_work requests.`);
    }
  }

  return {
    actor,
    payload,
  };
}

export function validateAdapterInvokeResult(
  value: unknown,
  label = "adapter_invoke_result",
): AdapterInvokeResult {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${label} must match ${CONTROL_SCHEMA_REFS.adapter_invoke_result}.`);
  }

  const status = requireEnum(record.status, `${label}.status`, ["success", "failure", "needs_resolution"]);
  const stdout = requireString(record.stdout, `${label}.stdout`, { allowEmpty: true });
  const stderr = requireString(record.stderr, `${label}.stderr`, { allowEmpty: true });
  const durationMs = requireInteger(record.durationMs, `${label}.durationMs`, { minimum: 0 });
  const errorMessage = optionalString(record.errorMessage, `${label}.errorMessage`, { allowEmpty: true });
  const metadata = record.metadata === undefined ? undefined : requireRecord(record.metadata, `${label}.metadata`);

  if (status === "needs_resolution") {
    if (record.exitCode !== null || record.signal !== null) {
      throw new Error(`${label}.exitCode and ${label}.signal must be null when status is needs_resolution.`);
    }
    return {
      status,
      stdout,
      stderr,
      exitCode: null,
      signal: null,
      durationMs,
      request: validateResolutionRequest(record.request, `${label}.request`),
      errorMessage,
      metadata,
    };
  }

  return {
    status,
    stdout,
    stderr,
    exitCode: requireNullableInteger(record.exitCode, `${label}.exitCode`),
    signal: optionalSignal(record.signal, `${label}.signal`),
    durationMs,
    errorMessage,
    metadata,
  };
}

export function validateCredentialEnvelope(
  value: unknown,
  label = "credential_envelope",
): CredentialEnvelope {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${label} must match ${CONTROL_SCHEMA_REFS.credential_envelope}.`);
  }

  const kind = requireString(record.kind, `${label}.kind`);
  if (kind !== "runx.credential-envelope.v1") {
    throw new Error(`${label}.kind must equal 'runx.credential-envelope.v1' (${CONTROL_SCHEMA_REFS.credential_envelope}).`);
  }

  return {
    kind: "runx.credential-envelope.v1",
    grant_id: requireString(record.grant_id, `${label}.grant_id`),
    provider: requireString(record.provider, `${label}.provider`),
    connection_id: requireString(record.connection_id, `${label}.connection_id`),
    scopes: requireStringArray(record.scopes, `${label}.scopes`, { allowEmptyValues: false }),
    material_ref: requireString(record.material_ref, `${label}.material_ref`),
  };
}

function validateAgentContextProvenance(value: unknown, label: string): AgentContextProvenance {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${label} must be an object.`);
  }

  return {
    input: requireString(record.input, `${label}.input`),
    output: requireString(record.output, `${label}.output`),
    from_step: optionalString(record.from_step, `${label}.from_step`, { allowEmpty: true }),
    artifact_id: optionalString(record.artifact_id, `${label}.artifact_id`, { allowEmpty: true }),
    receipt_id: optionalString(record.receipt_id, `${label}.receipt_id`, { allowEmpty: true }),
  };
}

function requireOutputScalar(value: unknown, label: string): Exclude<OutputContractEntry, Readonly<Record<string, unknown>>> {
  if (!isOutputContractScalar(value)) {
    throw new Error(`${label} must be one of string, number, integer, boolean, array, object, or null.`);
  }
  return value;
}

function isOutputContractScalar(value: unknown): value is Exclude<OutputContractEntry, Readonly<Record<string, unknown>>> {
  return value === "string"
    || value === "number"
    || value === "integer"
    || value === "boolean"
    || value === "array"
    || value === "object"
    || value === "null";
}

function requireEnum<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  const normalized = requireString(value, label);
  if (!allowed.includes(normalized as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}.`);
  }
  return normalized as T;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be boolean.`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${label} must be an object.`);
  }
  return record;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function requireStringArray(
  value: unknown,
  label: string,
  options: { readonly allowEmptyValues?: boolean } = {},
): readonly string[] {
  return requireArray(value, label).map((entry, index) =>
    requireString(entry, `${label}[${index}]`, { allowEmpty: options.allowEmptyValues === true }));
}

function requireString(
  value: unknown,
  label: string,
  options: { readonly allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (!options.allowEmpty && value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  return options.allowEmpty ? value : value.trim();
}

function optionalString(
  value: unknown,
  label: string,
  options: { readonly allowEmpty?: boolean } = {},
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, label, options);
}

function requireInteger(
  value: unknown,
  label: string,
  options: { readonly minimum?: number } = {},
): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  if (options.minimum !== undefined && (value as number) < options.minimum) {
    throw new Error(`${label} must be >= ${options.minimum}.`);
  }
  return value as number;
}

function requireNullableInteger(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  return requireInteger(value, label);
}

function optionalSignal(value: unknown, label: string): NodeJS.Signals | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requireString(value, label, { allowEmpty: true }) as NodeJS.Signals;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

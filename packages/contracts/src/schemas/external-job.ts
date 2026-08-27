import {
  type DeepReadonly,
  generatedSchema,
  validateContractSchema,
} from "../internal.js";
import { canonicalJsonStringify } from "../canonical-json.js";
import type {
  PaidSkillExecutorBindingContract,
  PrincipalReferenceContract,
  Sha256DigestContract,
} from "./paid-invocation.js";
import type { ReferenceContract } from "./spine.js";

export type ExternalJobStageContract =
  | "start"
  | "inspect"
  | "materialize"
  | "finalize";

export type ExternalJobStatusContract =
  | "runnable"
  | "waiting_external"
  | "succeeded"
  | "failed"
  | "superseded"
  | "dead_letter";

export type ExternalJobFailureContract = DeepReadonly<{
  code: string;
  message: string;
  retryable: boolean;
}>;

export type ExternalJobCheckpointContract = DeepReadonly<Record<string, unknown>>;

export type ExternalJobContinuationContract = DeepReadonly<{
  continuation_id: string;
  principal_ref: PrincipalReferenceContract;
  vendor_ref: PrincipalReferenceContract;
  invocation_ref: ReferenceContract;
  source_run_ref: ReferenceContract;
  execution_binding: PaidSkillExecutorBindingContract;
  operation_identity: Sha256DigestContract;
  stage: ExternalJobStageContract;
  status: ExternalJobStatusContract;
  attempts: number;
  max_attempts: number;
  next_attempt_at?: string;
  deadline_at: string;
  provider_job_ref?: ReferenceContract;
  result_artifact_ref?: ReferenceContract;
  terminal_evidence_ref?: ReferenceContract;
  terminal_evidence_digest?: Sha256DigestContract;
  failure?: ExternalJobFailureContract;
  created_at: string;
  updated_at: string;
}>;

export type ExternalJobScheduleContract = DeepReadonly<{
  continuation_id: string;
  principal_ref: PrincipalReferenceContract;
  vendor_ref: PrincipalReferenceContract;
  invocation_ref: ReferenceContract;
  source_run_ref: ReferenceContract;
  execution_binding: PaidSkillExecutorBindingContract;
  operation_identity: Sha256DigestContract;
  checkpoint: ExternalJobCheckpointContract;
  max_attempts: number;
  next_attempt_at: string;
  deadline_at: string;
  created_at: string;
}>;

export type ExternalJobScheduleIntentContract = DeepReadonly<{
  schema: "runx.external_job_schedule_intent.v1";
  checkpoint: ExternalJobCheckpointContract;
  max_attempts: number;
  initial_delay_ms: number;
  deadline_ms: number;
}>;

export type ExternalJobStageRequestContract = DeepReadonly<{
  continuation: ExternalJobContinuationContract;
  checkpoint: ExternalJobCheckpointContract;
  operation_key: Sha256DigestContract;
}>;

export type ExternalJobStageResultContract = DeepReadonly<
  | {
      status: "waiting";
      provider_job_ref: ReferenceContract;
      checkpoint: ExternalJobCheckpointContract;
      retry_after_ms: number;
    }
  | {
      status: "materialize";
      provider_job_ref: ReferenceContract;
      checkpoint: ExternalJobCheckpointContract;
      retry_after_ms: number;
    }
  | {
      status: "ready";
      provider_job_ref: ReferenceContract;
      result_artifact_ref: ReferenceContract;
      evidence_ref: ReferenceContract;
      evidence_digest: Sha256DigestContract;
    }
  | {
      status: "provider_failed";
      provider_job_ref: ReferenceContract;
      evidence_ref: ReferenceContract;
      evidence_digest: Sha256DigestContract;
      failure: ExternalJobFailureContract;
    }
>;

export const externalJobContinuationV1Schema =
  generatedSchema<ExternalJobContinuationContract>("external-job-continuation.schema.json");
export const externalJobScheduleV1Schema =
  generatedSchema<ExternalJobScheduleContract>("external-job-schedule.schema.json");
export const externalJobScheduleIntentV1Schema =
  generatedSchema<ExternalJobScheduleIntentContract>("external-job-schedule-intent.schema.json");
export const externalJobStageRequestV1Schema =
  generatedSchema<ExternalJobStageRequestContract>("external-job-stage-request.schema.json");
export const externalJobStageResultV1Schema =
  generatedSchema<ExternalJobStageResultContract>("external-job-stage-result.schema.json");

export function validateExternalJobContinuationContract(
  value: unknown,
  label = "external_job_continuation",
): ExternalJobContinuationContract {
  const continuation = validateContractSchema(externalJobContinuationV1Schema, value, label);
  validateSemantics(continuation, label);
  return continuation;
}

export function validateExternalJobScheduleContract(
  value: unknown,
  label = "external_job_schedule",
): ExternalJobScheduleContract {
  const schedule = validateContractSchema(externalJobScheduleV1Schema, value, label);
  validateIdentityReferences(schedule, label);
  checkpoint(schedule.checkpoint, `${label}.checkpoint`);
  const createdAt = timestamp(schedule.created_at, `${label}.created_at`);
  const nextAttemptAt = timestamp(schedule.next_attempt_at, `${label}.next_attempt_at`);
  const deadlineAt = timestamp(schedule.deadline_at, `${label}.deadline_at`);
  if (nextAttemptAt < createdAt || nextAttemptAt > deadlineAt || deadlineAt <= createdAt) {
    throw new Error(`${label} timestamps are not ordered.`);
  }
  return schedule;
}

export function validateExternalJobScheduleIntentContract(
  value: unknown,
  label = "external_job_schedule_intent",
): ExternalJobScheduleIntentContract {
  const intent = validateContractSchema(externalJobScheduleIntentV1Schema, value, label);
  checkpoint(intent.checkpoint, `${label}.checkpoint`);
  return intent;
}

export function validateExternalJobStageRequestContract(
  value: unknown,
  label = "external_job_stage_request",
): ExternalJobStageRequestContract {
  const request = validateContractSchema(externalJobStageRequestV1Schema, value, label);
  validateExternalJobContinuationContract(request.continuation, `${label}.continuation`);
  checkpoint(request.checkpoint, `${label}.checkpoint`);
  return request;
}

export function validateExternalJobStageResultContract(
  value: unknown,
  label = "external_job_stage_result",
): ExternalJobStageResultContract {
  const result = validateContractSchema(externalJobStageResultV1Schema, value, label);
  referenceType(result.provider_job_ref, "target", `${label}.provider_job_ref`);
  if (result.status === "waiting" || result.status === "materialize") {
    checkpoint(result.checkpoint, `${label}.checkpoint`);
  } else {
    referenceType(result.evidence_ref, "verification", `${label}.evidence_ref`);
    if (result.status === "ready") {
      referenceType(result.result_artifact_ref, "artifact", `${label}.result_artifact_ref`);
    } else if (result.failure.retryable) {
      throw new Error(`${label}.provider_failed must be terminal.`);
    }
  }
  return result;
}

function validateSemantics(
  continuation: ExternalJobContinuationContract,
  label: string,
): void {
  validateIdentityReferences(continuation, label);
  if (
    !Number.isSafeInteger(continuation.attempts)
    || continuation.attempts < 0
    || continuation.attempts > continuation.max_attempts
  ) {
    throw new Error(`${label}.attempts must be a safe integer between zero and max_attempts.`);
  }
  const createdAt = timestamp(continuation.created_at, `${label}.created_at`);
  const updatedAt = timestamp(continuation.updated_at, `${label}.updated_at`);
  const deadlineAt = timestamp(continuation.deadline_at, `${label}.deadline_at`);
  if (updatedAt < createdAt || deadlineAt <= createdAt) {
    throw new Error(`${label} timestamps are not ordered.`);
  }
  if (continuation.next_attempt_at) {
    const nextAttemptAt = timestamp(continuation.next_attempt_at, `${label}.next_attempt_at`);
    if (nextAttemptAt < createdAt || nextAttemptAt > deadlineAt) {
      throw new Error(`${label}.next_attempt_at must fall within the continuation deadline.`);
    }
  }

  const terminal = ["succeeded", "failed", "superseded", "dead_letter"]
    .includes(continuation.status);
  if (terminal === Boolean(continuation.next_attempt_at)) {
    throw new Error(`${label} must schedule exactly non-terminal state.`);
  }
  if (continuation.status === "waiting_external") {
    if (continuation.stage !== "inspect" || !continuation.provider_job_ref) {
      throw new Error(`${label} waiting_external state requires inspect and a provider job reference.`);
    }
  } else if (continuation.status === "runnable") {
    if (continuation.stage === "inspect") {
      throw new Error(`${label} inspect state must be waiting_external.`);
    }
    if (continuation.stage !== "start" && !continuation.provider_job_ref) {
      throw new Error(`${label} post-start state requires a provider job reference.`);
    }
  }

  if (!terminal) {
    if (
      continuation.result_artifact_ref
      || continuation.terminal_evidence_ref
      || continuation.terminal_evidence_digest
      || continuation.failure
    ) {
      throw new Error(`${label} active state cannot expose terminal fields.`);
    }
    return;
  }
  if (continuation.status === "succeeded") {
    if (
      continuation.stage !== "finalize"
      || !continuation.result_artifact_ref
      || !continuation.terminal_evidence_ref
      || !continuation.terminal_evidence_digest
      || continuation.failure
    ) {
      throw new Error(`${label} succeeded state requires finalized artifact and evidence.`);
    }
    return;
  }
  if (continuation.result_artifact_ref) {
    throw new Error(`${label} non-success terminal state cannot expose a result artifact.`);
  }
  if (continuation.status === "dead_letter") {
    if (!continuation.failure || continuation.failure.retryable) {
      throw new Error(`${label} dead_letter state requires a non-retryable bounded failure.`);
    }
    return;
  }
  if (!continuation.terminal_evidence_ref || !continuation.terminal_evidence_digest) {
    throw new Error(`${label} terminal provider outcome requires exact evidence.`);
  }
  if (continuation.status === "failed" && (!continuation.failure || continuation.failure.retryable)) {
    throw new Error(`${label} failed state requires a terminal failure.`);
  }
  if (continuation.status === "superseded" && continuation.failure) {
    throw new Error(`${label} superseded state cannot claim provider failure.`);
  }
}

function validateIdentityReferences(
  value: Pick<
    ExternalJobContinuationContract,
    "invocation_ref" | "source_run_ref"
  >,
  label: string,
): void {
  referenceType(value.invocation_ref, "target", `${label}.invocation_ref`);
  if (!value.invocation_ref.uri.startsWith("runx:paid-invocation:")) {
    throw new Error(`${label}.invocation_ref must identify a paid invocation.`);
  }
  referenceType(value.source_run_ref, "act", `${label}.source_run_ref`);
  if (!value.source_run_ref.uri.startsWith("runx:run:")) {
    throw new Error(`${label}.source_run_ref must identify a hosted run.`);
  }
}

function referenceType(
  reference: ReferenceContract,
  type: ReferenceContract["type"],
  label: string,
): void {
  if (reference.type !== type) throw new Error(`${label}.type must be ${type}.`);
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp.`);
  return parsed;
}

function checkpoint(value: ExternalJobCheckpointContract, label: string): void {
  const bytes = new TextEncoder().encode(canonicalJsonStringify(value)).byteLength;
  if (bytes > 64 * 1024) throw new Error(`${label} exceeds 65536 bytes.`);
}

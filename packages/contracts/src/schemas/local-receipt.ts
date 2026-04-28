import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  type DeepReadonly,
  stringEnum,
  unknownRecordSchema,
  validateContractSchema,
} from "../internal.js";

export const localReceiptSchemaVersion = "runx.receipt.v1" as const;

export const localReceiptDispositions = [
  "completed",
  "needs_resolution",
  "policy_denied",
  "approval_required",
  "observing",
  "escalated",
] as const;

export const localOutcomeStates = ["pending", "complete", "expired"] as const;

const localIssuerSchema = Type.Object(
  {
    type: Type.Literal("local"),
    kid: Type.String(),
    public_key_sha256: Type.String(),
  },
  { additionalProperties: false },
);

const localSignatureSchema = Type.Object(
  {
    alg: Type.Literal("Ed25519"),
    value: Type.String(),
  },
  { additionalProperties: false },
);

const receiptSurfaceRefSchema = Type.Object(
  {
    type: Type.String(),
    uri: Type.String(),
    label: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const receiptInputContextSchema = Type.Object(
  {
    source: Type.Optional(Type.String()),
    snapshot: Type.Optional(Type.Unknown()),
    preview: Type.Optional(Type.String()),
    bytes: Type.Number(),
    max_bytes: Type.Number(),
    truncated: Type.Boolean(),
    value_hash: Type.String(),
  },
  { additionalProperties: false },
);

const receiptOutcomeSchema = Type.Object(
  {
    code: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    observed_at: Type.Optional(Type.String()),
    data: Type.Optional(unknownRecordSchema()),
  },
  { additionalProperties: false },
);

const dispositionSchema = stringEnum(localReceiptDispositions);
const outcomeStateSchema = stringEnum(localOutcomeStates);
const statusSchema = stringEnum(["success", "failure"] as const);

const skillExecutionSchema = Type.Object(
  {
    exit_code: Type.Union([Type.Number(), Type.Null()]),
    signal: Type.Union([Type.String(), Type.Null()]),
    error_hash: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const graphReceiptStepRetrySchema = Type.Object(
  {
    attempt: Type.Number(),
    max_attempts: Type.Number(),
    rule_fired: Type.String(),
    idempotency_key_hash: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const graphReceiptContextEntrySchema = Type.Object(
  {
    input: Type.String(),
    from_step: Type.String(),
    output: Type.String(),
    receipt_id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const graphReceiptGovernanceSchema = Type.Object(
  {
    scope_admission: Type.Optional(unknownRecordSchema()),
  },
  { additionalProperties: false },
);

const graphReceiptStepSchema = Type.Object(
  {
    step_id: Type.String(),
    attempt: Type.Number(),
    skill: Type.String(),
    runner: Type.Optional(Type.String()),
    status: statusSchema,
    receipt_id: Type.Optional(Type.String()),
    parent_receipt: Type.Optional(Type.String()),
    fanout_group: Type.Optional(Type.String()),
    retry: Type.Optional(graphReceiptStepRetrySchema),
    context_from: Type.Array(graphReceiptContextEntrySchema),
    governance: Type.Optional(graphReceiptGovernanceSchema),
    artifact_ids: Type.Optional(Type.Array(Type.String())),
    disposition: Type.Optional(dispositionSchema),
    input_context: Type.Optional(receiptInputContextSchema),
    outcome_state: Type.Optional(outcomeStateSchema),
    outcome: Type.Optional(receiptOutcomeSchema),
    surface_refs: Type.Optional(Type.Array(receiptSurfaceRefSchema)),
    evidence_refs: Type.Optional(Type.Array(receiptSurfaceRefSchema)),
  },
  { additionalProperties: false },
);

const graphReceiptSyncPointSchema = Type.Object(
  {
    group_id: Type.String(),
    strategy: stringEnum(["all", "any", "quorum"] as const),
    decision: stringEnum(["proceed", "halt", "pause", "escalate"] as const),
    rule_fired: Type.String(),
    reason: Type.String(),
    branch_count: Type.Number(),
    success_count: Type.Number(),
    failure_count: Type.Number(),
    required_successes: Type.Number(),
    branch_receipts: Type.Array(Type.String()),
    gate: Type.Optional(unknownRecordSchema()),
  },
  { additionalProperties: false },
);

export const localSkillReceiptSchema = Type.Object(
  {
    schema_version: Type.Literal(localReceiptSchemaVersion),
    id: Type.String(),
    kind: Type.Literal("skill_execution"),
    issuer: localIssuerSchema,
    skill_name: Type.String(),
    source_type: Type.String(),
    status: statusSchema,
    started_at: Type.Optional(Type.String()),
    completed_at: Type.Optional(Type.String()),
    duration_ms: Type.Number(),
    input_hash: Type.String(),
    output_hash: Type.String(),
    stderr_hash: Type.Optional(Type.String()),
    context_from: Type.Array(Type.String()),
    parent_receipt: Type.Optional(Type.String()),
    artifact_ids: Type.Optional(Type.Array(Type.String())),
    disposition: Type.Optional(dispositionSchema),
    input_context: Type.Optional(receiptInputContextSchema),
    outcome_state: Type.Optional(outcomeStateSchema),
    outcome: Type.Optional(receiptOutcomeSchema),
    surface_refs: Type.Optional(Type.Array(receiptSurfaceRefSchema)),
    evidence_refs: Type.Optional(Type.Array(receiptSurfaceRefSchema)),
    execution: skillExecutionSchema,
    metadata: Type.Optional(unknownRecordSchema()),
    signature: localSignatureSchema,
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: "https://schemas.runx.dev/runx/local-skill-receipt/v1.json",
    "x-runx-schema": "runx.local_skill_receipt.v1",
    additionalProperties: false,
  },
);

export const localGraphReceiptSchema = Type.Object(
  {
    schema_version: Type.Literal(localReceiptSchemaVersion),
    id: Type.String(),
    kind: Type.Literal("graph_execution"),
    issuer: localIssuerSchema,
    graph_name: Type.String(),
    owner: Type.Optional(Type.String()),
    status: statusSchema,
    started_at: Type.Optional(Type.String()),
    completed_at: Type.Optional(Type.String()),
    duration_ms: Type.Number(),
    input_hash: Type.String(),
    output_hash: Type.String(),
    error_hash: Type.Optional(Type.String()),
    disposition: Type.Optional(dispositionSchema),
    input_context: Type.Optional(receiptInputContextSchema),
    outcome_state: Type.Optional(outcomeStateSchema),
    outcome: Type.Optional(receiptOutcomeSchema),
    surface_refs: Type.Optional(Type.Array(receiptSurfaceRefSchema)),
    evidence_refs: Type.Optional(Type.Array(receiptSurfaceRefSchema)),
    metadata: Type.Optional(unknownRecordSchema()),
    steps: Type.Array(graphReceiptStepSchema),
    sync_points: Type.Optional(Type.Array(graphReceiptSyncPointSchema)),
    signature: localSignatureSchema,
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: "https://schemas.runx.dev/runx/local-graph-receipt/v1.json",
    "x-runx-schema": "runx.local_graph_receipt.v1",
    additionalProperties: false,
  },
);

export const localReceiptSchema = Type.Union([
  localSkillReceiptSchema,
  localGraphReceiptSchema,
]);

export type LocalSkillReceiptContract = DeepReadonly<Static<typeof localSkillReceiptSchema>>;
export type LocalGraphReceiptContract = DeepReadonly<Static<typeof localGraphReceiptSchema>>;
export type LocalReceiptContract = DeepReadonly<Static<typeof localReceiptSchema>>;

export function validateLocalReceiptContract(
  value: unknown,
  label = "local_receipt",
): LocalReceiptContract {
  return validateContractSchema(localReceiptSchema, value, label);
}

export function validateLocalSkillReceiptContract(
  value: unknown,
  label = "local_skill_receipt",
): LocalSkillReceiptContract {
  return validateContractSchema(localSkillReceiptSchema, value, label);
}

export function validateLocalGraphReceiptContract(
  value: unknown,
  label = "local_graph_receipt",
): LocalGraphReceiptContract {
  return validateContractSchema(localGraphReceiptSchema, value, label);
}

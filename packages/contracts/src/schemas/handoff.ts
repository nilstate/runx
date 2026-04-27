import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  RUNX_CONTRACT_IDS,
  RUNX_LOGICAL_SCHEMAS,
  type DeepReadonly,
  dateTimeStringSchema,
  stringEnum,
  unknownRecordSchema,
  validateContractSchema,
} from "../internal.js";

const handoffSignalSources = [
  "pull_request_comment",
  "pull_request_review",
  "pull_request_state",
  "issue_comment",
  "discussion_reply",
  "email_reply",
  "direct_message_reply",
  "manual_note",
  "system_event",
] as const;
const handoffSignalDispositions = [
  "acknowledged",
  "interested",
  "requested_changes",
  "accepted",
  "approved_to_send",
  "merged",
  "declined",
  "requested_no_contact",
  "rerouted",
] as const;
const handoffStatuses = [
  "awaiting_response",
  "engaged",
  "needs_revision",
  "accepted",
  "approved_to_send",
  "completed",
  "declined",
  "rerouted",
  "suppressed",
] as const;
const suppressionScopes = ["handoff", "target", "repo", "contact"] as const;
const suppressionReasons = [
  "requested_no_contact",
  "remove_request",
  "operator_block",
  "legal_request",
] as const;

const handoffActorSchema = Type.Object(
  {
    actor_id: Type.Optional(Type.String({ minLength: 1 })),
    display_name: Type.Optional(Type.String()),
    role: Type.Optional(Type.String({ minLength: 1 })),
    provider_identity: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const handoffEvidenceRefSchema = Type.Object(
  {
    type: Type.String({ minLength: 1 }),
    uri: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String()),
    recorded_at: Type.Optional(dateTimeStringSchema()),
  },
  { additionalProperties: false },
);

export const handoffSignalV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.handoffSignal),
    signal_id: Type.String({ minLength: 1 }),
    handoff_id: Type.String({ minLength: 1 }),
    boundary_kind: Type.Optional(Type.String({ minLength: 1 })),
    target_repo: Type.Optional(Type.String({ minLength: 1 })),
    target_locator: Type.Optional(Type.String({ minLength: 1 })),
    contact_locator: Type.Optional(Type.String({ minLength: 1 })),
    thread_locator: Type.Optional(Type.String({ minLength: 1 })),
    outbox_entry_id: Type.Optional(Type.String({ minLength: 1 })),
    source: stringEnum(handoffSignalSources),
    disposition: stringEnum(handoffSignalDispositions),
    recorded_at: dateTimeStringSchema(),
    actor: Type.Optional(handoffActorSchema),
    notes: Type.Optional(Type.String()),
    labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    source_ref: Type.Optional(handoffEvidenceRefSchema),
    metadata: Type.Optional(unknownRecordSchema()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.handoffSignal,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.handoffSignal,
    additionalProperties: false,
  },
);

export type HandoffSignalContract = DeepReadonly<Static<typeof handoffSignalV1Schema>>;

export const handoffStateV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.handoffState),
    handoff_id: Type.String({ minLength: 1 }),
    boundary_kind: Type.Optional(Type.String({ minLength: 1 })),
    target_repo: Type.Optional(Type.String({ minLength: 1 })),
    target_locator: Type.Optional(Type.String({ minLength: 1 })),
    contact_locator: Type.Optional(Type.String({ minLength: 1 })),
    status: stringEnum(handoffStatuses),
    signal_count: Type.Integer({ minimum: 0 }),
    last_signal_id: Type.Optional(Type.String({ minLength: 1 })),
    last_signal_at: Type.Optional(dateTimeStringSchema()),
    last_signal_disposition: Type.Optional(stringEnum(handoffSignalDispositions)),
    suppression_record_id: Type.Optional(Type.String({ minLength: 1 })),
    suppression_reason: Type.Optional(stringEnum(suppressionReasons)),
    summary: Type.Optional(Type.String()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.handoffState,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.handoffState,
    additionalProperties: false,
  },
);

export type HandoffStateContract = DeepReadonly<Static<typeof handoffStateV1Schema>>;

export const suppressionRecordV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.suppressionRecord),
    record_id: Type.String({ minLength: 1 }),
    scope: stringEnum(suppressionScopes),
    key: Type.String({ minLength: 1 }),
    reason: stringEnum(suppressionReasons),
    recorded_at: dateTimeStringSchema(),
    expires_at: Type.Optional(dateTimeStringSchema()),
    source_signal_id: Type.Optional(Type.String({ minLength: 1 })),
    notes: Type.Optional(Type.String()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.suppressionRecord,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.suppressionRecord,
    additionalProperties: false,
  },
);

export type SuppressionRecordContract = DeepReadonly<Static<typeof suppressionRecordV1Schema>>;

export function validateHandoffSignalContract(value: unknown, label = "handoff_signal"): HandoffSignalContract {
  return validateContractSchema(handoffSignalV1Schema, value, label);
}

export function validateHandoffStateContract(value: unknown, label = "handoff_state"): HandoffStateContract {
  return validateContractSchema(handoffStateV1Schema, value, label);
}

export function validateSuppressionRecordContract(
  value: unknown,
  label = "suppression_record",
): SuppressionRecordContract {
  return validateContractSchema(suppressionRecordV1Schema, value, label);
}

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

const capabilityExecutionTransportKinds = ["cli", "api", "github_issue_comment", "system"] as const;

export const capabilityExecutionActorSchema = Type.Object(
  {
    actor_id: Type.Optional(Type.String({ minLength: 1 })),
    display_name: Type.Optional(Type.String({ minLength: 1 })),
    role: Type.Optional(Type.String({ minLength: 1 })),
    provider_identity: Type.Optional(Type.String({ minLength: 1 })),
  },
  {
    additionalProperties: false,
  },
);

export type CapabilityExecutionActorContract = DeepReadonly<Static<typeof capabilityExecutionActorSchema>>;

export const capabilityExecutionTransportSchema = Type.Object(
  {
    kind: stringEnum(capabilityExecutionTransportKinds),
    trigger_ref: Type.Optional(Type.String({ minLength: 1 })),
    scope_set: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    actor: Type.Optional(capabilityExecutionActorSchema),
  },
  {
    additionalProperties: false,
  },
);

export type CapabilityExecutionTransportContract = DeepReadonly<Static<typeof capabilityExecutionTransportSchema>>;

export const capabilityExecutionIdempotencySchema = Type.Object(
  {
    algorithm: Type.Literal("sha256"),
    intent_key: Type.String({ minLength: 1 }),
    trigger_key: Type.Optional(Type.String({ minLength: 1 })),
    content_hash: Type.String({ minLength: 1 }),
  },
  {
    additionalProperties: false,
  },
);

export type CapabilityExecutionIdempotencyContract = DeepReadonly<Static<typeof capabilityExecutionIdempotencySchema>>;

export const capabilityExecutionV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.capabilityExecution),
    capability_ref: Type.String({ minLength: 1 }),
    runner: Type.String({ minLength: 1 }),
    thread_ref: Type.Optional(Type.String({ minLength: 1 })),
    requested_at: dateTimeStringSchema(),
    transport: capabilityExecutionTransportSchema,
    input_overrides: Type.Optional(unknownRecordSchema()),
    idempotency: capabilityExecutionIdempotencySchema,
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.capabilityExecution,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.capabilityExecution,
    additionalProperties: false,
  },
);

export type CapabilityExecutionContract = DeepReadonly<Static<typeof capabilityExecutionV1Schema>>;

export function validateCapabilityExecutionContract(
  value: unknown,
  label = "capability_execution",
): CapabilityExecutionContract {
  return validateContractSchema(capabilityExecutionV1Schema, value, label);
}

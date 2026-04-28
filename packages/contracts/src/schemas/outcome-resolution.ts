import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  type DeepReadonly,
  stringEnum,
  unknownRecordSchema,
  validateContractSchema,
} from "../internal.js";
import { localOutcomeStates } from "./local-receipt.js";

export const outcomeResolutionSchemaVersion = "runx.receipt.outcome-resolution.v1" as const;

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

const receiptOutcomeSchema = Type.Object(
  {
    code: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    observed_at: Type.Optional(Type.String()),
    data: Type.Optional(unknownRecordSchema()),
  },
  { additionalProperties: false },
);

export const outcomeResolutionSchema = Type.Object(
  {
    schema_version: Type.Literal(outcomeResolutionSchemaVersion),
    id: Type.String(),
    receipt_id: Type.String(),
    outcome_state: stringEnum(localOutcomeStates),
    outcome: Type.Optional(receiptOutcomeSchema),
    source: Type.Optional(Type.String()),
    created_at: Type.String(),
    issuer: localIssuerSchema,
    signature: localSignatureSchema,
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: "https://schemas.runx.dev/runx/outcome-resolution/v1.json",
    "x-runx-schema": "runx.outcome_resolution.v1",
    additionalProperties: false,
  },
);

export type OutcomeResolutionContract = DeepReadonly<Static<typeof outcomeResolutionSchema>>;

export function validateOutcomeResolutionContract(
  value: unknown,
  label = "outcome_resolution",
): OutcomeResolutionContract {
  return validateContractSchema(outcomeResolutionSchema, value, label);
}

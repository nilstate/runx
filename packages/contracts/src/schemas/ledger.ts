import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  type DeepReadonly,
  validateContractSchema,
} from "../internal.js";
import { artifactEnvelopeSchema } from "./artifact.js";

export const ledgerRecordSchemaVersion = "runx.ledger.entry.v1" as const;
export const ledgerChainSchemaVersion = "runx.ledger.chain.v1" as const;
export const ledgerHashAlgorithm = "sha256" as const;
export const ledgerCanonicalization = "runx.stable-json.v1" as const;

const sha256HexSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const ledgerChainSchema = Type.Object(
  {
    version: Type.Literal(ledgerChainSchemaVersion),
    algorithm: Type.Literal(ledgerHashAlgorithm),
    canonicalization: Type.Literal(ledgerCanonicalization),
    index: Type.Integer({ minimum: 0 }),
    previous_hash: Type.Union([sha256HexSchema, Type.Null()]),
    entry_hash: sha256HexSchema,
  },
  { additionalProperties: false },
);

export type LedgerChainContract = DeepReadonly<Static<typeof ledgerChainSchema>>;

export const ledgerRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(ledgerRecordSchemaVersion),
    chain: ledgerChainSchema,
    entry: artifactEnvelopeSchema,
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: "https://schemas.runx.dev/runx/ledger-entry/v1.json",
    "x-runx-schema": ledgerRecordSchemaVersion,
    additionalProperties: false,
  },
);

export type LedgerRecordContract = DeepReadonly<Static<typeof ledgerRecordSchema>>;

export function validateLedgerRecordContract(
  value: unknown,
  label = "ledger_record",
): LedgerRecordContract {
  return validateContractSchema(ledgerRecordSchema, value, label);
}

import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  RUNX_CONTRACT_IDS,
  RUNX_LOGICAL_SCHEMAS,
  type DeepReadonly,
  stringEnum,
  unknownRecordSchema,
} from "../internal.js";
import { devStatuses } from "./dev.js";

const receiptStepSchema = unknownRecordSchema();

export const receiptV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.receipt),
    run_id: Type.String(),
    command: Type.String(),
    status: stringEnum(devStatuses),
    started_at: Type.String(),
    finished_at: Type.Optional(Type.String()),
    root: Type.String(),
    unit: Type.Optional(unknownRecordSchema()),
    steps: Type.Array(receiptStepSchema),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.receipt,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.receipt,
    additionalProperties: false,
  },
);

export type ReceiptContract = DeepReadonly<Static<typeof receiptV1Schema>>;

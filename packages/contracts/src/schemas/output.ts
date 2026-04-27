import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  RUNX_CONTROL_SCHEMA_REFS,
  type DeepReadonly,
  stringEnum,
  validateContractSchema,
} from "../internal.js";

const outputContractScalarKinds = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
] as const;

export const outputContractScalarSchema = stringEnum(outputContractScalarKinds);

export type OutputContractScalarContract = DeepReadonly<Static<typeof outputContractScalarSchema>>;

export const outputContractObjectEntrySchema = Type.Object(
  {
    type: Type.Optional(outputContractScalarSchema),
    description: Type.Optional(Type.String()),
    required: Type.Optional(Type.Boolean()),
    wrap_as: Type.Optional(Type.String({ minLength: 1 })),
    enum: Type.Optional(Type.Array(Type.String())),
  },
  {
    additionalProperties: false,
    minProperties: 1,
  },
);

export type OutputContractObjectEntryContract = DeepReadonly<Static<typeof outputContractObjectEntrySchema>>;

export const outputContractEntrySchema = Type.Union([
  outputContractScalarSchema,
  outputContractObjectEntrySchema,
]);

export type OutputContractEntryContract = DeepReadonly<Static<typeof outputContractEntrySchema>>;

export const outputContractSchema = Type.Record(
  Type.String(),
  outputContractEntrySchema,
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTROL_SCHEMA_REFS.output_contract,
  },
);

export type OutputContractContract = DeepReadonly<Static<typeof outputContractSchema>>;

export function validateOutputContractContract(
  value: unknown,
  label = "output_contract",
): OutputContractContract {
  return validateContractSchema(outputContractSchema, value, label);
}

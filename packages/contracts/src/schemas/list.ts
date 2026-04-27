import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  RUNX_CONTRACT_IDS,
  RUNX_LOGICAL_SCHEMAS,
  type DeepReadonly,
  stringEnum,
  validateContractSchema,
} from "../internal.js";

const runxListRequestedKinds = ["all", "tools", "skills", "graphs", "packets", "overlays"] as const;
const runxListItemKinds = ["tool", "skill", "graph", "packet", "overlay"] as const;
const runxListSources = ["local", "workspace", "dependencies", "built-in"] as const;
const runxListStatuses = ["ok", "invalid"] as const;

const runxListEmitSchema = Type.Object(
  {
    name: Type.String(),
    packet: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const runxListRequestedKindSchema = stringEnum(runxListRequestedKinds);
export const runxListItemKindSchema = stringEnum(runxListItemKinds);
export const runxListSourceSchema = stringEnum(runxListSources);

export type RunxListRequestedKindContract = DeepReadonly<Static<typeof runxListRequestedKindSchema>>;
export type RunxListItemKindContract = DeepReadonly<Static<typeof runxListItemKindSchema>>;
export type RunxListSourceContract = DeepReadonly<Static<typeof runxListSourceSchema>>;
export type RunxListEmitContract = DeepReadonly<Static<typeof runxListEmitSchema>>;

export const runxListItemSchema = Type.Object(
  {
    kind: runxListItemKindSchema,
    name: Type.String(),
    source: runxListSourceSchema,
    path: Type.String(),
    status: stringEnum(runxListStatuses),
    diagnostics: Type.Optional(Type.Array(Type.String())),
    scopes: Type.Optional(Type.Array(Type.String())),
    emits: Type.Optional(Type.Array(runxListEmitSchema)),
    fixtures: Type.Optional(Type.Integer({ minimum: 0 })),
    harness_cases: Type.Optional(Type.Integer({ minimum: 0 })),
    steps: Type.Optional(Type.Integer({ minimum: 0 })),
    wraps: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type RunxListItemContract = DeepReadonly<Static<typeof runxListItemSchema>>;

export const listV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.list),
    root: Type.String(),
    requested_kind: runxListRequestedKindSchema,
    items: Type.Array(runxListItemSchema),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.list,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.list,
    additionalProperties: false,
  },
);

export type RunxListReportContract = DeepReadonly<Static<typeof listV1Schema>>;

export function validateRunxListReportContract(value: unknown, label = "list_report"): RunxListReportContract {
  return validateContractSchema(listV1Schema, value, label);
}

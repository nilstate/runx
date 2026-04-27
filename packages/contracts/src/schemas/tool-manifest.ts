import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  RUNX_CONTRACT_IDS,
  RUNX_LOGICAL_SCHEMAS,
  type DeepReadonly,
  unknownRecordSchema,
} from "../internal.js";

export const toolManifestV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.toolManifest),
    name: Type.String(),
    version: Type.String(),
    description: Type.Optional(Type.String()),
    source_hash: Type.String(),
    schema_hash: Type.String(),
    runtime: unknownRecordSchema(),
    inputs: Type.Optional(unknownRecordSchema()),
    output: unknownRecordSchema(),
    scopes: Type.Optional(Type.Array(Type.String())),
    toolkit_version: Type.Optional(Type.String()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.toolManifest,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.toolManifest,
    additionalProperties: false,
  },
);

export type ToolManifestContract = DeepReadonly<Static<typeof toolManifestV1Schema>>;

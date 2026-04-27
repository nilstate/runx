import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  RUNX_CONTRACT_IDS,
  RUNX_LOGICAL_SCHEMAS,
  type DeepReadonly,
  stringEnum,
  unknownRecordSchema,
  validateContractSchema,
} from "../internal.js";
import { doctorV1Schema } from "./doctor.js";

export const devStatuses = ["success", "failure", "skipped", "needs_approval"] as const;
const fixtureAssertionKinds = [
  "subset_miss",
  "exact_mismatch",
  "packet_invalid",
  "status_mismatch",
  "type_mismatch",
] as const;

const devFixtureAssertionSchema = Type.Object(
  {
    path: Type.String(),
    expected: Type.Optional(Type.Unknown()),
    actual: Type.Optional(Type.Unknown()),
    kind: stringEnum(fixtureAssertionKinds),
    message: Type.String(),
  },
  { additionalProperties: false },
);

const devFixtureResultSchema = Type.Object(
  {
    name: Type.String(),
    lane: Type.String(),
    target: unknownRecordSchema(),
    status: stringEnum(["success", "failure", "skipped"] as const),
    duration_ms: Type.Integer({ minimum: 0 }),
    assertions: Type.Array(devFixtureAssertionSchema),
    skip_reason: Type.Optional(Type.String()),
    output: Type.Optional(Type.Unknown()),
    replay_path: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type DevFixtureAssertionContract = DeepReadonly<Static<typeof devFixtureAssertionSchema>>;
export type DevFixtureResultContract = DeepReadonly<Static<typeof devFixtureResultSchema>>;

export const devV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.dev),
    status: stringEnum(devStatuses),
    doctor: Type.Ref(doctorV1Schema),
    fixtures: Type.Array(devFixtureResultSchema),
    receipt_id: Type.Optional(Type.String()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.dev,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.dev,
    additionalProperties: false,
  },
);

const devContractReferences = [doctorV1Schema] as const;

export type DevReportContract = DeepReadonly<Static<typeof devV1Schema>>;

export function validateDevReportContract(value: unknown, label = "dev_report"): DevReportContract {
  return validateContractSchema(devV1Schema, value, label, devContractReferences);
}

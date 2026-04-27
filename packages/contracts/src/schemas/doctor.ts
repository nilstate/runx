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

const doctorDiagnosticSeverities = ["error", "warning", "info"] as const;
const doctorRepairKinds = [
  "create_file",
  "replace_file",
  "edit_yaml",
  "edit_json",
  "add_fixture",
  "run_command",
  "manual",
] as const;
const doctorRepairConfidences = ["low", "medium", "high"] as const;
const doctorRepairRisks = ["low", "medium", "high", "sensitive"] as const;
const doctorStatuses = ["success", "failure"] as const;

const doctorTargetSchema = unknownRecordSchema();
const doctorEvidenceSchema = unknownRecordSchema();

export const doctorRepairSchema = Type.Object(
  {
    id: Type.String(),
    kind: stringEnum(doctorRepairKinds),
    confidence: stringEnum(doctorRepairConfidences),
    risk: stringEnum(doctorRepairRisks),
    path: Type.Optional(Type.String()),
    json_pointer: Type.Optional(Type.String()),
    contents: Type.Optional(Type.String()),
    patch: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    requires_human_review: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const doctorLocationSchema = Type.Object(
  {
    path: Type.String(),
    json_pointer: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const doctorDiagnosticSchema = Type.Object(
  {
    id: Type.String(),
    instance_id: Type.String(),
    severity: stringEnum(doctorDiagnosticSeverities),
    title: Type.String(),
    message: Type.String(),
    target: doctorTargetSchema,
    location: doctorLocationSchema,
    evidence: Type.Optional(doctorEvidenceSchema),
    repairs: Type.Array(doctorRepairSchema),
  },
  { additionalProperties: false },
);

export const doctorSummarySchema = Type.Object(
  {
    errors: Type.Integer({ minimum: 0 }),
    warnings: Type.Integer({ minimum: 0 }),
    infos: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type DoctorRepairContract = DeepReadonly<Static<typeof doctorRepairSchema>>;
export type DoctorLocationContract = DeepReadonly<Static<typeof doctorLocationSchema>>;
export type DoctorDiagnosticContract = DeepReadonly<Static<typeof doctorDiagnosticSchema>>;
export type DoctorSummaryContract = DeepReadonly<Static<typeof doctorSummarySchema>>;

export const doctorV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.doctor),
    status: stringEnum(doctorStatuses),
    summary: doctorSummarySchema,
    diagnostics: Type.Array(doctorDiagnosticSchema),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.doctor,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.doctor,
    additionalProperties: false,
  },
);

export type DoctorReportContract = DeepReadonly<Static<typeof doctorV1Schema>>;

export function validateDoctorReportContract(value: unknown, label = "doctor_report"): DoctorReportContract {
  return validateContractSchema(doctorV1Schema, value, label);
}

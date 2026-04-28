import { Type, type Static } from "@sinclair/typebox";
import { type DeepReadonly, unknownRecordSchema, validateContractSchema } from "../internal.js";

export const artifactProducerSchema = Type.Object(
  {
    skill: Type.String({ minLength: 1 }),
    runner: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type ArtifactProducerContract = DeepReadonly<Static<typeof artifactProducerSchema>>;

export const artifactMetaSchema = Type.Object(
  {
    artifact_id: Type.String({ minLength: 1 }),
    run_id: Type.String({ minLength: 1 }),
    step_id: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    producer: artifactProducerSchema,
    created_at: Type.String({ minLength: 1 }),
    hash: Type.String({ minLength: 1 }),
    size_bytes: Type.Integer({ minimum: 0 }),
    parent_artifact_id: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    receipt_id: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    redacted: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type ArtifactMetaContract = DeepReadonly<Static<typeof artifactMetaSchema>>;

export const artifactEnvelopeSchema = Type.Object(
  {
    type: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    version: Type.Literal("1"),
    data: unknownRecordSchema(),
    meta: artifactMetaSchema,
  },
  { additionalProperties: false },
);

export type ArtifactEnvelopeContract = DeepReadonly<Static<typeof artifactEnvelopeSchema>>;

export function validateArtifactEnvelopeContract(
  value: unknown,
  label = "artifact_envelope",
): ArtifactEnvelopeContract {
  return validateContractSchema(artifactEnvelopeSchema, value, label);
}

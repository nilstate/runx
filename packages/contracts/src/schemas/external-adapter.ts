import { Type, type Static } from "../internal.js";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  RUNX_CONTRACT_IDS,
  RUNX_LOGICAL_SCHEMAS,
  type DeepReadonly,
  dateTimeStringSchema,
  generatedSchema,
  stringEnum,
  unknownRecordSchema,
  validateContractSchema,
} from "../internal.js";
import { resolutionRequestSchema } from "./resolution.js";
import { referenceSchema } from "./spine.js";

export const externalAdapterProtocolVersion = "runx.external_adapter.v1" as const;

// Process transport v1 is deliberately small: the Rust supervisor writes one
// invocation JSON document to stdin, accepts exactly one response JSON document
// on stdout, and treats stderr as diagnostic text only.
const externalAdapterTransports = ["process", "http"] as const;
const externalAdapterStatuses = [
  "completed",
  "failed",
  "host_resolution_requested",
  "cancelled",
] as const;
const externalAdapterCredentialPurposes = [
  "provider_api",
  "registry",
  "artifact_store",
  "webhook_verification",
] as const;

const nonEmptyStringArraySchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });

export const externalAdapterTransportSchema = Type.Object(
  {
    kind: stringEnum(externalAdapterTransports),
    command: Type.Optional(Type.String({ minLength: 1 })),
    args: Type.Optional(Type.Array(Type.String())),
    endpoint: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type ExternalAdapterTransportContract = DeepReadonly<Static<typeof externalAdapterTransportSchema>>;

export const externalAdapterCredentialNeedSchema = Type.Object(
  {
    purpose: stringEnum(externalAdapterCredentialPurposes),
    provider: Type.String({ minLength: 1 }),
    scope_refs: Type.Optional(Type.Array(referenceSchema)),
    required: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type ExternalAdapterCredentialNeedContract =
  DeepReadonly<Static<typeof externalAdapterCredentialNeedSchema>>;

export const externalAdapterTimeoutsSchema = Type.Object(
  {
    startup_ms: Type.Integer({ minimum: 1 }),
    invocation_ms: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export type ExternalAdapterTimeoutsContract = DeepReadonly<Static<typeof externalAdapterTimeoutsSchema>>;

const externalAdapterManifestV1TypeSchema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.externalAdapterManifest),
    protocol_version: Type.Literal(externalAdapterProtocolVersion),
    adapter_id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    supported_source_types: nonEmptyStringArraySchema,
    transport: externalAdapterTransportSchema,
    timeouts: externalAdapterTimeoutsSchema,
    credential_needs: Type.Optional(Type.Array(externalAdapterCredentialNeedSchema)),
    metadata: Type.Optional(unknownRecordSchema()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.externalAdapterManifest,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.externalAdapterManifest,
    additionalProperties: false,
  },
);

export type ExternalAdapterManifestContract =
  DeepReadonly<Static<typeof externalAdapterManifestV1TypeSchema>>;

export const externalAdapterManifestV1Schema =
  generatedSchema<ExternalAdapterManifestContract>(
    "external-adapter-manifest.schema.json",
  );

export const externalAdapterCredentialReferenceSchema = Type.Object(
  {
    credential_ref: referenceSchema,
    provider: Type.String({ minLength: 1 }),
    purpose: stringEnum(externalAdapterCredentialPurposes),
  },
  { additionalProperties: false },
);

export type ExternalAdapterCredentialReferenceContract =
  DeepReadonly<Static<typeof externalAdapterCredentialReferenceSchema>>;

const externalAdapterCredentialRequestV1TypeSchema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.externalAdapterCredentialRequest),
    protocol_version: Type.Literal(externalAdapterProtocolVersion),
    request_id: Type.String({ minLength: 1 }),
    adapter_id: Type.String({ minLength: 1 }),
    invocation_id: Type.String({ minLength: 1 }),
    credential_refs: Type.Array(externalAdapterCredentialReferenceSchema, { minItems: 1 }),
    requested_at: dateTimeStringSchema(),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.externalAdapterCredentialRequest,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.externalAdapterCredentialRequest,
    additionalProperties: false,
  },
);

export type ExternalAdapterCredentialRequestContract =
  DeepReadonly<Static<typeof externalAdapterCredentialRequestV1TypeSchema>>;

export const externalAdapterCredentialRequestV1Schema =
  generatedSchema<ExternalAdapterCredentialRequestContract>(
    "external-adapter-credential-request.schema.json",
  );

const externalAdapterInvocationV1TypeSchema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.externalAdapterInvocation),
    protocol_version: Type.Literal(externalAdapterProtocolVersion),
    invocation_id: Type.String({ minLength: 1 }),
    adapter_id: Type.String({ minLength: 1 }),
    run_id: Type.String({ minLength: 1 }),
    step_id: Type.String({ minLength: 1 }),
    source_type: Type.String({ minLength: 1 }),
    skill_ref: Type.String({ minLength: 1 }),
    harness_ref: referenceSchema,
    host_ref: referenceSchema,
    inputs: unknownRecordSchema(),
    resolved_inputs: Type.Optional(unknownRecordSchema()),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    receipt_dir: Type.Optional(Type.String({ minLength: 1 })),
    env: Type.Optional(unknownRecordSchema()),
    credential_refs: Type.Optional(Type.Array(externalAdapterCredentialReferenceSchema)),
    metadata: Type.Optional(unknownRecordSchema()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.externalAdapterInvocation,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.externalAdapterInvocation,
    additionalProperties: false,
  },
);

export type ExternalAdapterInvocationContract =
  DeepReadonly<Static<typeof externalAdapterInvocationV1TypeSchema>>;

export const externalAdapterInvocationV1Schema =
  generatedSchema<ExternalAdapterInvocationContract>(
    "external-adapter-invocation.schema.json",
  );

export const externalAdapterArtifactObservationSchema = Type.Object(
  {
    artifact_ref: referenceSchema,
    summary: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type ExternalAdapterArtifactObservationContract =
  DeepReadonly<Static<typeof externalAdapterArtifactObservationSchema>>;

export const externalAdapterErrorObservationSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type ExternalAdapterErrorObservationContract =
  DeepReadonly<Static<typeof externalAdapterErrorObservationSchema>>;

export const externalAdapterTelemetryObservationSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    value: Type.Union([Type.Number(), Type.String(), Type.Boolean()]),
    unit: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type ExternalAdapterTelemetryObservationContract =
  DeepReadonly<Static<typeof externalAdapterTelemetryObservationSchema>>;

const externalAdapterResponseV1TypeSchema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.externalAdapterResponse),
    protocol_version: Type.Literal(externalAdapterProtocolVersion),
    invocation_id: Type.String({ minLength: 1 }),
    adapter_id: Type.String({ minLength: 1 }),
    status: stringEnum(externalAdapterStatuses),
    stdout: Type.Optional(Type.String()),
    stderr: Type.Optional(Type.String()),
    exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    output: Type.Optional(unknownRecordSchema()),
    artifacts: Type.Optional(Type.Array(externalAdapterArtifactObservationSchema)),
    errors: Type.Optional(Type.Array(externalAdapterErrorObservationSchema)),
    telemetry: Type.Optional(Type.Array(externalAdapterTelemetryObservationSchema)),
    metadata: Type.Optional(unknownRecordSchema()),
    observed_at: dateTimeStringSchema(),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.externalAdapterResponse,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.externalAdapterResponse,
    additionalProperties: false,
  },
);

export type ExternalAdapterResponseContract =
  DeepReadonly<Static<typeof externalAdapterResponseV1TypeSchema>>;

export const externalAdapterResponseV1Schema =
  generatedSchema<ExternalAdapterResponseContract>(
    "external-adapter-response.schema.json",
  );

const externalAdapterHostResolutionFrameV1TypeSchema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.externalAdapterHostResolution),
    protocol_version: Type.Literal(externalAdapterProtocolVersion),
    frame_id: Type.String({ minLength: 1 }),
    invocation_id: Type.String({ minLength: 1 }),
    adapter_id: Type.String({ minLength: 1 }),
    request: resolutionRequestSchema,
    requested_at: dateTimeStringSchema(),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.externalAdapterHostResolution,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.externalAdapterHostResolution,
    additionalProperties: false,
  },
);

export type ExternalAdapterHostResolutionFrameContract =
  DeepReadonly<Static<typeof externalAdapterHostResolutionFrameV1TypeSchema>>;

export const externalAdapterHostResolutionFrameV1Schema =
  generatedSchema<ExternalAdapterHostResolutionFrameContract>(
    "external-adapter-host-resolution.schema.json",
  );

const externalAdapterCancellationFrameV1TypeSchema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.externalAdapterCancellation),
    protocol_version: Type.Literal(externalAdapterProtocolVersion),
    frame_id: Type.String({ minLength: 1 }),
    invocation_id: Type.String({ minLength: 1 }),
    adapter_id: Type.String({ minLength: 1 }),
    reason: Type.String({ minLength: 1 }),
    requested_at: dateTimeStringSchema(),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.externalAdapterCancellation,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.externalAdapterCancellation,
    additionalProperties: false,
  },
);

export type ExternalAdapterCancellationFrameContract =
  DeepReadonly<Static<typeof externalAdapterCancellationFrameV1TypeSchema>>;

export const externalAdapterCancellationFrameV1Schema =
  generatedSchema<ExternalAdapterCancellationFrameContract>(
    "external-adapter-cancellation.schema.json",
  );

export function validateExternalAdapterManifestContract(
  value: unknown,
  label = "external_adapter_manifest",
): ExternalAdapterManifestContract {
  return validateContractSchema(externalAdapterManifestV1Schema, value, label);
}

export function validateExternalAdapterInvocationContract(
  value: unknown,
  label = "external_adapter_invocation",
): ExternalAdapterInvocationContract {
  return validateContractSchema(externalAdapterInvocationV1Schema, value, label);
}

export function validateExternalAdapterResponseContract(
  value: unknown,
  label = "external_adapter_response",
): ExternalAdapterResponseContract {
  return validateContractSchema(externalAdapterResponseV1Schema, value, label);
}

export function validateExternalAdapterHostResolutionFrameContract(
  value: unknown,
  label = "external_adapter_host_resolution",
): ExternalAdapterHostResolutionFrameContract {
  return validateContractSchema(externalAdapterHostResolutionFrameV1Schema, value, label);
}

export function validateExternalAdapterCancellationFrameContract(
  value: unknown,
  label = "external_adapter_cancellation",
): ExternalAdapterCancellationFrameContract {
  return validateContractSchema(externalAdapterCancellationFrameV1Schema, value, label);
}

export function validateExternalAdapterCredentialRequestContract(
  value: unknown,
  label = "external_adapter_credential_request",
): ExternalAdapterCredentialRequestContract {
  return validateContractSchema(externalAdapterCredentialRequestV1Schema, value, label);
}

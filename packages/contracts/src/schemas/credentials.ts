import { Type, type Static } from "../internal.js";
import {
  RUNX_CONTROL_SCHEMA_REFS,
  type DeepReadonly,
  generatedSchema,
  stringEnum,
  validateContractSchema,
} from "../internal.js";
import { executionBoundaryObservationSchema } from "./execution-boundary.js";

const authorityKinds = ["read_only", "constructive", "destructive"] as const;
const scopeAdmissionStatuses = ["allow", "deny"] as const;
const credentialMaterialStatuses = ["not_requested", "not_resolved", "resolved", "denied"] as const;

export const authorityProofSchemaVersion = "runx.authority-proof.v1" as const;

export const credentialGrantReferenceSchema = Type.Object(
  {
    grant_id: Type.String({ minLength: 1 }),
    scope_family: Type.String({ minLength: 1 }),
    authority_kind: stringEnum(authorityKinds),
    target_repo: Type.Optional(Type.String({ minLength: 1 })),
    target_locator: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type CredentialGrantReferenceContract = DeepReadonly<Static<typeof credentialGrantReferenceSchema>>;

const credentialEnvelopeTypeSchema = Type.Object(
  {
    kind: Type.Literal("runx.credential-envelope.v1"),
    grant_id: Type.String({ minLength: 1 }),
    provider: Type.String({ minLength: 1 }),
    auth_mode: Type.String({ minLength: 1 }),
    material_kind: Type.String({ minLength: 1 }),
    provider_reference: Type.String({ minLength: 1 }),
    scopes: Type.Array(Type.String({ minLength: 1 })),
    grant_reference: Type.Optional(credentialGrantReferenceSchema),
    material_ref: Type.String({ minLength: 1 }),
  },
  {
    $id: RUNX_CONTROL_SCHEMA_REFS.credential_envelope,
    additionalProperties: false,
  },
);

export type CredentialEnvelopeContract = DeepReadonly<Static<typeof credentialEnvelopeTypeSchema>>;

export const credentialEnvelopeSchema = generatedSchema<CredentialEnvelopeContract>(
  "credential-envelope.schema.json",
);

const scopeAdmissionTypeSchema = Type.Object(
  {
    status: stringEnum(scopeAdmissionStatuses),
    requested_scopes: Type.Array(Type.String({ minLength: 1 })),
    granted_scopes: Type.Array(Type.String({ minLength: 1 })),
    grant_id: Type.Optional(Type.String({ minLength: 1 })),
    reasons: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    decision_summary: Type.Optional(Type.String()),
  },
  {
    $id: RUNX_CONTROL_SCHEMA_REFS.scope_admission,
    additionalProperties: false,
  },
);

export type ScopeAdmissionContract = DeepReadonly<Static<typeof scopeAdmissionTypeSchema>>;

export const scopeAdmissionSchema = generatedSchema<ScopeAdmissionContract>("scope-admission.schema.json");

const authorityProofRequestedSchema = Type.Object(
  {
    connected_auth: Type.Boolean(),
    scopes: Type.Array(Type.String({ minLength: 1 })),
    scope_family: Type.Optional(Type.String({ minLength: 1 })),
    authority_kind: Type.Optional(stringEnum(authorityKinds)),
    target_repo: Type.Optional(Type.String({ minLength: 1 })),
    target_locator: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const authorityProofCredentialMaterialSchema = Type.Object(
  {
    status: stringEnum(credentialMaterialStatuses),
    grant_id: Type.Optional(Type.String({ minLength: 1 })),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    provider_reference: Type.Optional(Type.String({ minLength: 1 })),
    scopes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    grant_reference: Type.Optional(credentialGrantReferenceSchema),
    material_ref_hash: Type.Optional(Type.String({ minLength: 1 })),
    scope_family: Type.Optional(Type.String({ minLength: 1 })),
    authority_kind: Type.Optional(stringEnum(authorityKinds)),
    target_repo: Type.Optional(Type.String({ minLength: 1 })),
    target_locator: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const authorityProofApprovalGateSchema = Type.Object(
  {
    gate_id: Type.String({ minLength: 1 }),
    gate_type: Type.String({ minLength: 1 }),
    decision: stringEnum(["approved", "denied"] as const),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const authorityProofRedactionSchema = Type.Object(
  {
    status: Type.Literal("applied"),
    secret_material: Type.Literal("omitted"),
    stdout: Type.Literal("hashed"),
    stderr: Type.Literal("hashed"),
    metadata_secret_keys: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const authorityProofTypeSchema = Type.Object(
  {
    schema_version: Type.Literal(authorityProofSchemaVersion),
    run_id: Type.Optional(Type.String({ minLength: 1 })),
    skill_name: Type.String({ minLength: 1 }),
    source_type: Type.String({ minLength: 1 }),
    requested: authorityProofRequestedSchema,
    scope_admission: scopeAdmissionSchema,
    credential_material: authorityProofCredentialMaterialSchema,
    execution_boundary: executionBoundaryObservationSchema,
    approval_gate: Type.Optional(authorityProofApprovalGateSchema),
    redaction: authorityProofRedactionSchema,
  },
  {
    $id: RUNX_CONTROL_SCHEMA_REFS.authority_proof,
    additionalProperties: false,
  },
);

export type AuthorityProofContract = DeepReadonly<Static<typeof authorityProofTypeSchema>>;

export const authorityProofSchema = generatedSchema<AuthorityProofContract>("authority-proof.schema.json");

export function validateCredentialEnvelopeContract(
  value: unknown,
  label = "credential_envelope",
): CredentialEnvelopeContract {
  return validateContractSchema(credentialEnvelopeSchema, value, label);
}

export function validateScopeAdmissionContract(value: unknown, label = "scope_admission"): ScopeAdmissionContract {
  return validateContractSchema(scopeAdmissionSchema, value, label);
}

export function validateAuthorityProofContract(value: unknown, label = "authority_proof"): AuthorityProofContract {
  return validateContractSchema(authorityProofSchema, value, label);
}

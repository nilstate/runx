import { Type, type Static } from "@sinclair/typebox";
import {
  RUNX_CONTROL_SCHEMA_REFS,
  type DeepReadonly,
  stringEnum,
  validateContractSchema,
} from "../internal.js";

const authorityKinds = ["read_only", "constructive", "destructive"] as const;
const scopeAdmissionStatuses = ["allow", "deny"] as const;

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

export const credentialEnvelopeSchema = Type.Object(
  {
    kind: Type.Literal("runx.credential-envelope.v1"),
    grant_id: Type.String({ minLength: 1 }),
    provider: Type.String({ minLength: 1 }),
    connection_id: Type.String({ minLength: 1 }),
    scopes: Type.Array(Type.String({ minLength: 1 })),
    grant_reference: Type.Optional(credentialGrantReferenceSchema),
    material_ref: Type.String({ minLength: 1 }),
  },
  {
    $id: RUNX_CONTROL_SCHEMA_REFS.credential_envelope,
    additionalProperties: false,
  },
);

export type CredentialEnvelopeContract = DeepReadonly<Static<typeof credentialEnvelopeSchema>>;

export const scopeAdmissionSchema = Type.Object(
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

export type ScopeAdmissionContract = DeepReadonly<Static<typeof scopeAdmissionSchema>>;

export function validateCredentialEnvelopeContract(
  value: unknown,
  label = "credential_envelope",
): CredentialEnvelopeContract {
  return validateContractSchema(credentialEnvelopeSchema, value, label);
}

export function validateScopeAdmissionContract(value: unknown, label = "scope_admission"): ScopeAdmissionContract {
  return validateContractSchema(scopeAdmissionSchema, value, label);
}

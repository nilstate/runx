//! Policy-proof contracts: the authority-proof receipt envelope and its two
//! standalone companions (`credential-envelope`, `scope-admission`).
//!
//! These carry the legacy bare `runx.ai/spec` `$id` (no `x-runx-schema`). They
//! are produced by the local policy engine and guarded as wire contracts; their
//! authoritative Rust shape lives here so the schema wire-conformance gate can cover
//! them.
use serde::{Deserialize, Serialize};

use crate::ExecutionBoundaryObservation;
use crate::schema::{NonEmptyString, RunxSchema};

/// The kind of authority a grant or request carries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityKind {
    ReadOnly,
    Constructive,
    Destructive,
}

/// Whether a scope-admission decision allowed or denied the request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScopeAdmissionStatus {
    Allow,
    Deny,
}

/// Fixed wire identity for credential envelopes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum CredentialEnvelopeKind {
    #[serde(rename = "runx.credential-envelope.v1")]
    V1,
}

/// Fixed wire identity for authority proofs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum AuthorityProofSchemaVersion {
    #[serde(rename = "runx.authority-proof.v1")]
    V1,
}

/// Credential-material state recorded in an authority proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityProofCredentialMaterialStatus {
    NotRequested,
    NotResolved,
    Resolved,
    Denied,
}

/// Approval-gate outcome recorded in an authority proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityProofApprovalDecisionValue {
    Approved,
    Denied,
}

/// Fixed redaction status recorded in authority proofs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum AuthorityProofRedactionStatus {
    #[serde(rename = "applied")]
    Applied,
}

/// Fixed secret-material posture recorded in authority proofs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum AuthorityProofRedactionSecretMaterial {
    #[serde(rename = "omitted")]
    Omitted,
}

/// Fixed stream posture recorded in authority proofs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum AuthorityProofRedactionStream {
    #[serde(rename = "hashed")]
    Hashed,
}

/// A scope-admission decision (`runx.ai/spec/scope-admission`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[runx_schema(spec_id = "https://runx.ai/spec/scope-admission.schema.json")]
pub struct ScopeAdmission {
    pub status: ScopeAdmissionStatus,
    pub requested_scopes: Vec<NonEmptyString>,
    pub granted_scopes: Vec<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_id: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasons: Option<Vec<NonEmptyString>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_summary: Option<String>,
}

/// The grant a credential or request descends from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CredentialGrantReference {
    pub grant_id: NonEmptyString,
    pub scope_family: NonEmptyString,
    pub authority_kind: AuthorityKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_repo: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_locator: Option<NonEmptyString>,
}

/// A resolved credential envelope (`runx.ai/spec/credential-envelope`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[runx_schema(spec_id = "https://runx.ai/spec/credential-envelope.schema.json")]
pub struct CredentialEnvelope {
    pub kind: CredentialEnvelopeKind,
    pub grant_id: NonEmptyString,
    pub provider: NonEmptyString,
    pub auth_mode: NonEmptyString,
    pub material_kind: NonEmptyString,
    pub provider_reference: NonEmptyString,
    pub scopes: Vec<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_reference: Option<CredentialGrantReference>,
    pub material_ref: NonEmptyString,
}

/// The scopes/posture a skill requested before admission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AuthorityProofRequested {
    pub connected_auth: bool,
    pub scopes: Vec<NonEmptyString>,
    pub mutating: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_family: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_kind: Option<AuthorityKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_repo: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_locator: Option<NonEmptyString>,
}

/// The credential-material posture recorded in an authority proof.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AuthorityProofCredentialMaterial {
    pub status: AuthorityProofCredentialMaterialStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_id: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_reference: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<NonEmptyString>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_family: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_kind: Option<AuthorityKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_repo: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_locator: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_reference: Option<CredentialGrantReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_ref_hash: Option<NonEmptyString>,
}

/// The decision an approval gate reached, recorded in an authority proof.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AuthorityProofApprovalDecision {
    pub gate_id: NonEmptyString,
    pub gate_type: NonEmptyString,
    pub decision: AuthorityProofApprovalDecisionValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<NonEmptyString>,
}

/// The redaction attestation recorded in an authority proof.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AuthorityProofRedaction {
    pub status: AuthorityProofRedactionStatus,
    pub secret_material: AuthorityProofRedactionSecretMaterial,
    pub stdout: AuthorityProofRedactionStream,
    pub stderr: AuthorityProofRedactionStream,
    pub metadata_secret_keys: Vec<NonEmptyString>,
}

/// The authority proof emitted alongside a skill run
/// (`runx.ai/spec/authority-proof`): the requested posture, the scope-admission
/// decision, the credential-material posture, and the redaction attestation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[runx_schema(spec_id = "https://runx.ai/spec/authority-proof.schema.json")]
pub struct AuthorityProof {
    pub schema_version: AuthorityProofSchemaVersion,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<NonEmptyString>,
    pub skill_name: NonEmptyString,
    pub source_type: NonEmptyString,
    pub requested: AuthorityProofRequested,
    pub scope_admission: ScopeAdmission,
    pub credential_material: AuthorityProofCredentialMaterial,
    pub execution_boundary: ExecutionBoundaryObservation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_gate: Option<AuthorityProofApprovalDecision>,
    pub redaction: AuthorityProofRedaction,
}

// rust-style-allow: large-file - policy parity wire types stay colocated so serde surface changes are reviewed together.
use runx_contracts::JsonValue;
use serde::{Deserialize, Serialize};

// These wire contracts now have their authoritative Rust type in
// `runx-contracts` (covered by the schema wire-conformance gate). Re-export them so
// every existing policy/runtime importer keeps compiling unchanged.
pub use runx_contracts::policy_proof::{
    AuthorityKind, AuthorityProof, AuthorityProofApprovalDecision,
    AuthorityProofApprovalDecisionValue, AuthorityProofCredentialMaterial,
    AuthorityProofCredentialMaterialStatus, AuthorityProofRedaction,
    AuthorityProofRedactionSecretMaterial, AuthorityProofRedactionStatus,
    AuthorityProofRedactionStream, AuthorityProofRequested, AuthorityProofSandbox,
    AuthorityProofSandboxFilesystem, AuthorityProofSandboxNetwork, AuthorityProofSandboxRuntime,
    AuthorityProofSchemaVersion, CredentialEnvelope, CredentialEnvelopeKind,
    CredentialGrantReference, ScopeAdmission, ScopeAdmissionStatus,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAdmissionSkill {
    pub name: String,
    pub source: LocalAdmissionSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<JsonValue>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAdmissionSource {
    #[serde(rename = "type")]
    pub source_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxDeclaration>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAdmissionOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_source_types: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_timeout_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_grants: Option<Vec<LocalAdmissionGrant>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_auth_checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_connected_auth: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved_sandbox_escalation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_sandbox_escalation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_policy: Option<LocalExecutionPolicy>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalExecutionPolicy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strict_cli_tool_inline_code: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct LocalAdmissionGrant {
    pub grant_id: String,
    pub provider: String,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<LocalAdmissionGrantStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_kind: Option<AuthorityKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_locator: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalAdmissionGrantStatus {
    Active,
    Revoked,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalScopeAdmissionOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denied_before_grant_resolution: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_auth_checked_at: Option<String>,
    /// Honor a universal `*` grant scope. Defaults to `false` (fail closed):
    /// only a trusted caller resolving first-party grants may set this true.
    #[serde(default)]
    pub wildcard_scopes_trusted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    rename_all = "kebab-case",
    tag = "status",
    rename_all_fields = "camelCase"
)]
pub enum CredentialBindingDecision {
    Allow { reasons: Vec<String> },
    Deny { reasons: Vec<String> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityProofSandboxDeclaration {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(alias = "cwd_policy", skip_serializing_if = "Option::is_none")]
    pub cwd_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<bool>,
    #[serde(alias = "require_enforcement", skip_serializing_if = "Option::is_none")]
    pub require_enforcement: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityProofApprovalGate {
    pub id: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub gate_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityProofApproval {
    pub gate: AuthorityProofApprovalGate,
    pub approved: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildAuthorityProofOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_auth_checked_at: Option<String>,
    pub skill_name: String,
    pub source_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grants: Vec<LocalAdmissionGrant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_admission: Option<ScopeAdmission>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<CredentialEnvelope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_declaration: Option<AuthorityProofSandboxDeclaration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_metadata: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<AuthorityProofApproval>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mutating: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialBindingRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grants: Vec<LocalAdmissionGrant>,
    pub scope_admission: ScopeAdmission,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<CredentialEnvelope>,
}

// AuthorityProof is intentionally policy-owned. It is emitted by
// policy.buildAuthorityProofMetadata, depends on policy admission decisions, and
// is guarded as a contract by schema validation in runx-contracts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AuthorityProofMetadata {
    pub authority_proof: AuthorityProof,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PublicWorkPolicy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_author_patterns: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_head_ref_prefixes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_exact_labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_label_prefixes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust_recovery_statuses: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub require_welcome_signal_for_pull_request_comments: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RequiredPublicWorkPolicy {
    pub blocked_author_patterns: Vec<String>,
    pub blocked_head_ref_prefixes: Vec<String>,
    pub blocked_exact_labels: Vec<String>,
    pub blocked_label_prefixes: Vec<String>,
    pub trust_recovery_statuses: Vec<String>,
    pub require_welcome_signal_for_pull_request_comments: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicPullRequestCandidateRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_login: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_ref_name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicCommentOpportunityRequest {
    #[serde(flatten)]
    pub pull_request: PublicPullRequestCandidateRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_association: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comments_count: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_comments_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recent_outcomes: Vec<PublicRecentOutcome>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicRecentOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PublicPolicyDecision {
    pub blocked: bool,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PublicCommentPolicyDecision {
    pub blocked: bool,
    pub reasons: Vec<String>,
    pub welcome_signal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryAdmissionRequest {
    pub step_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mutating: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max_attempts: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GraphScopeGrant {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_id: Option<String>,
    pub scopes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphScopeAdmissionRequest {
    pub step_id: String,
    pub requested_scopes: Vec<String>,
    pub grant: GraphScopeGrant,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AdmissionDecision {
    Allow {
        reasons: Vec<String>,
    },
    AllowMarked {
        reasons: Vec<String>,
        norm_refs: Vec<String>,
    },
    Deny {
        reasons: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum GraphScopeAdmissionDecision {
    Allow {
        reasons: Vec<String>,
        step_id: String,
        requested_scopes: Vec<String>,
        granted_scopes: Vec<String>,
        #[serde(rename = "grantId", skip_serializing_if = "Option::is_none")]
        grant_id: Option<String>,
    },
    Deny {
        reasons: Vec<String>,
        step_id: String,
        requested_scopes: Vec<String>,
        granted_scopes: Vec<String>,
        #[serde(rename = "grantId", skip_serializing_if = "Option::is_none")]
        grant_id: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxProfile {
    Readonly,
    WorkspaceWrite,
    Network,
    UnrestrictedLocalDev,
}

impl SandboxProfile {
    pub fn as_str(&self) -> &'static str {
        match self {
            SandboxProfile::Readonly => "readonly",
            SandboxProfile::WorkspaceWrite => "workspace-write",
            SandboxProfile::Network => "network",
            SandboxProfile::UnrestrictedLocalDev => "unrestricted-local-dev",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CwdPolicy {
    SkillDirectory,
    Workspace,
    Custom,
}

impl CwdPolicy {
    pub fn as_str(&self) -> &'static str {
        match self {
            CwdPolicy::SkillDirectory => "skill-directory",
            CwdPolicy::Workspace => "workspace",
            CwdPolicy::Custom => "custom",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDeclaration {
    pub profile: SandboxProfile,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd_policy: Option<CwdPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_allowlist: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub writable_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub require_enforcement: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredSandboxDeclaration {
    pub profile: SandboxProfile,
    pub cwd_policy: CwdPolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_allowlist: Option<Vec<String>>,
    pub network: bool,
    pub writable_paths: Vec<String>,
    pub require_enforcement: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxAdmissionOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved_escalation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_escalation: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SandboxAdmissionDecision {
    Allow {
        reasons: Vec<String>,
    },
    #[serde(rename = "approval_required")]
    ApprovalRequired {
        reasons: Vec<String>,
    },
    Deny {
        reasons: Vec<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::{
        AdmissionDecision, AuthorityKind, GraphScopeAdmissionDecision, LocalAdmissionGrant,
        LocalAdmissionGrantStatus, SandboxAdmissionDecision,
    };

    // Allow and Deny wire shapes are pinned end-to-end by the kernel policy
    // fixtures (fixtures/kernel/policy/retry-admission-*.json) walked in
    // tests/policy_fixtures.rs and tests/kernel_eval.rs; AllowMarked has no
    // fixture producing it, so its wire shape is pinned here.
    #[test]
    fn admission_decision_round_trips_allow_marked() -> Result<(), serde_json::Error> {
        let decision = AdmissionDecision::AllowMarked {
            reasons: vec!["allowed with visible norm mark".to_owned()],
            norm_refs: vec!["frantic:norm:reply-before-escalation".to_owned()],
        };

        let json = serde_json::to_string(&decision)?;
        let decoded: AdmissionDecision = serde_json::from_str(&json)?;

        assert_eq!(
            json,
            r#"{"status":"allow-marked","reasons":["allowed with visible norm mark"],"normRefs":["frantic:norm:reply-before-escalation"]}"#,
        );
        assert_eq!(decoded, decision);
        Ok(())
    }

    #[test]
    fn grant_deserializes_snake_case_targeting_fields() -> Result<(), serde_json::Error> {
        let json = r#"{"grant_id":"grant_1","provider":"github","scopes":["issues:write"],"status":"active","scope_family":"github","authority_kind":"constructive","target_repo":"runxhq/runx","target_locator":"issue/1"}"#;

        let grant: LocalAdmissionGrant = serde_json::from_str(json)?;

        assert_eq!(grant.grant_id, "grant_1");
        assert_eq!(grant.scopes, vec!["issues:write"]);
        assert_eq!(grant.status, Some(LocalAdmissionGrantStatus::Active));
        assert_eq!(grant.authority_kind, Some(AuthorityKind::Constructive));
        Ok(())
    }

    #[test]
    fn graph_scope_decision_serializes_camel_case_and_empty_arrays() -> Result<(), serde_json::Error>
    {
        let decision = GraphScopeAdmissionDecision::Allow {
            reasons: vec!["graph step requested no scopes".to_owned()],
            step_id: "deploy".to_owned(),
            requested_scopes: Vec::new(),
            granted_scopes: Vec::new(),
            grant_id: Some("grant_1".to_owned()),
        };

        let json = serde_json::to_string(&decision)?;

        assert_eq!(
            json,
            r#"{"status":"allow","reasons":["graph step requested no scopes"],"stepId":"deploy","requestedScopes":[],"grantedScopes":[],"grantId":"grant_1"}"#,
        );
        Ok(())
    }

    #[test]
    fn sandbox_approval_required_uses_snake_case_status() -> Result<(), serde_json::Error> {
        let decision = SandboxAdmissionDecision::ApprovalRequired {
            reasons: vec![
                "unrestricted-local-dev sandbox requires explicit caller approval".to_owned(),
            ],
        };

        let json = serde_json::to_string(&decision)?;

        assert_eq!(
            json,
            r#"{"status":"approval_required","reasons":["unrestricted-local-dev sandbox requires explicit caller approval"]}"#,
        );
        Ok(())
    }
}

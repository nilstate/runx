use runx_contracts::JsonValue;
use runx_core::policy::{
    BuildAuthorityProofOptions, CredentialBindingRequest, GraphScopeAdmissionRequest,
    LocalAdmissionGrant, LocalAdmissionOptions, LocalAdmissionSkill, LocalScopeAdmissionOptions,
    PublicCommentOpportunityRequest, PublicPullRequestCandidateRequest, PublicWorkPolicy,
    ScopeGrantPolicy, admit_graph_step_scopes, admit_local_skill, build_authority_proof_metadata,
    build_local_scope_admission, evaluate_public_comment_opportunity,
    evaluate_public_pull_request_candidate, normalize_public_work_policy, scope_grant_allows,
    validate_credential_binding,
};
use serde::Deserialize;

const FIXTURES: &[(&str, &str)] = &[
    (
        "authority-credential-binding-allows-matching",
        include_str!(
            "../../../fixtures/kernel/policy/authority-credential-binding-allows-matching.json"
        ),
    ),
    (
        "authority-credential-binding-denies-grant-reference",
        include_str!(
            "../../../fixtures/kernel/policy/authority-credential-binding-denies-grant-reference.json"
        ),
    ),
    (
        "authority-proof-metadata-full",
        include_str!("../../../fixtures/kernel/policy/authority-proof-metadata-full.json"),
    ),
    (
        "authority-scope-admission-active-grant",
        include_str!("../../../fixtures/kernel/policy/authority-scope-admission-active-grant.json"),
    ),
    (
        "authority-scope-admission-denied-before-grant",
        include_str!(
            "../../../fixtures/kernel/policy/authority-scope-admission-denied-before-grant.json"
        ),
    ),
    (
        "authority-scope-admission-no-connected-auth",
        include_str!(
            "../../../fixtures/kernel/policy/authority-scope-admission-no-connected-auth.json"
        ),
    ),
    (
        "authority-scope-admission-no-matching-grant",
        include_str!(
            "../../../fixtures/kernel/policy/authority-scope-admission-no-matching-grant.json"
        ),
    ),
    (
        "graph-scope-allows-empty-request",
        include_str!("../../../fixtures/kernel/policy/graph-scope-allows-empty-request.json"),
    ),
    (
        "graph-scope-allows-exact-match",
        include_str!("../../../fixtures/kernel/policy/graph-scope-allows-exact-match.json"),
    ),
    (
        "graph-scope-allows-wildcard-narrowing",
        include_str!("../../../fixtures/kernel/policy/graph-scope-allows-wildcard-narrowing.json"),
    ),
    (
        "graph-scope-deduplicates-requests",
        include_str!("../../../fixtures/kernel/policy/graph-scope-deduplicates-requests.json"),
    ),
    (
        "graph-scope-denies-empty-grant",
        include_str!("../../../fixtures/kernel/policy/graph-scope-denies-empty-grant.json"),
    ),
    (
        "graph-scope-denies-partial-widening",
        include_str!("../../../fixtures/kernel/policy/graph-scope-denies-partial-widening.json"),
    ),
    (
        "graph-scope-denies-prefix-wildcard-request",
        include_str!(
            "../../../fixtures/kernel/policy/graph-scope-denies-prefix-wildcard-request.json"
        ),
    ),
    (
        "graph-scope-denies-prefix-substring",
        include_str!("../../../fixtures/kernel/policy/graph-scope-denies-prefix-substring.json"),
    ),
    (
        "graph-scope-denies-prefix-nested-segment",
        include_str!(
            "../../../fixtures/kernel/policy/graph-scope-denies-prefix-nested-segment.json"
        ),
    ),
    (
        "graph-scope-denies-widening",
        include_str!("../../../fixtures/kernel/policy/graph-scope-denies-widening.json"),
    ),
    (
        "graph-scope-omits-grant-id-when-absent",
        include_str!("../../../fixtures/kernel/policy/graph-scope-omits-grant-id-when-absent.json"),
    ),
    (
        "local-admission-allows-cli-tool",
        include_str!("../../../fixtures/kernel/policy/local-admission-allows-cli-tool.json"),
    ),
    (
        "local-admission-allows-connected-wildcard-grant",
        include_str!(
            "../../../fixtures/kernel/policy/local-admission-allows-connected-wildcard-grant.json"
        ),
    ),
    (
        "local-admission-denies-connected-prefix-substring",
        include_str!(
            "../../../fixtures/kernel/policy/local-admission-denies-connected-prefix-substring.json"
        ),
    ),
    (
        "local-admission-denies-connected-universal-wildcard",
        include_str!(
            "../../../fixtures/kernel/policy/local-admission-denies-connected-universal-wildcard.json"
        ),
    ),
    (
        "local-admission-denies-inline-python-through-env",
        include_str!(
            "../../../fixtures/kernel/policy/local-admission-denies-inline-python-through-env.json"
        ),
    ),
    (
        "local-admission-denies-inline-windows-path-interpreter",
        include_str!(
            "../../../fixtures/kernel/policy/local-admission-denies-inline-windows-path-interpreter.json"
        ),
    ),
    (
        "local-admission-denies-unsupported-source",
        include_str!(
            "../../../fixtures/kernel/policy/local-admission-denies-unsupported-source.json"
        ),
    ),
    (
        "public-work-blocks-dependency-bot-pr",
        include_str!("../../../fixtures/kernel/policy/public-work-blocks-dependency-bot-pr.json"),
    ),
    (
        "public-work-blocks-hyphen-version-title",
        include_str!(
            "../../../fixtures/kernel/policy/public-work-blocks-hyphen-version-title.json"
        ),
    ),
    (
        "public-work-denies-cold-comment",
        include_str!("../../../fixtures/kernel/policy/public-work-denies-cold-comment.json"),
    ),
    (
        "public-work-denies-trust-recovery",
        include_str!("../../../fixtures/kernel/policy/public-work-denies-trust-recovery.json"),
    ),
    (
        "public-work-normalizes-policy",
        include_str!("../../../fixtures/kernel/policy/public-work-normalizes-policy.json"),
    ),
    (
        "public-work-normalizes-empty-arrays",
        include_str!("../../../fixtures/kernel/policy/public-work-normalizes-empty-arrays.json"),
    ),
    (
        "scope-grant-delegated-allows-one-segment",
        include_str!(
            "../../../fixtures/kernel/policy/scope-grant-delegated-allows-one-segment.json"
        ),
    ),
    (
        "scope-grant-delegated-denies-nested-segment",
        include_str!(
            "../../../fixtures/kernel/policy/scope-grant-delegated-denies-nested-segment.json"
        ),
    ),
    (
        "scope-grant-delegated-denies-universal",
        include_str!("../../../fixtures/kernel/policy/scope-grant-delegated-denies-universal.json"),
    ),
    (
        "scope-grant-exact-only-allows-exact",
        include_str!("../../../fixtures/kernel/policy/scope-grant-exact-only-allows-exact.json"),
    ),
    (
        "scope-grant-exact-only-denies-wildcard-expansion",
        include_str!(
            "../../../fixtures/kernel/policy/scope-grant-exact-only-denies-wildcard-expansion.json"
        ),
    ),
    (
        "scope-grant-trusted-allows-universal",
        include_str!("../../../fixtures/kernel/policy/scope-grant-trusted-allows-universal.json"),
    ),
];

#[derive(Debug, Deserialize)]
struct Fixture {
    input: PolicyInput,
    expected: ExpectedOutput,
}

#[derive(Debug, Deserialize)]
struct ExpectedOutput {
    value: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
enum PolicyInput {
    #[serde(rename = "policy.admitLocalSkill")]
    AdmitLocalSkill {
        skill: Box<LocalAdmissionSkill>,
        #[serde(default)]
        options: LocalAdmissionOptions,
    },
    #[serde(rename = "policy.admitGraphStepScopes")]
    AdmitGraphStepScopes { request: GraphScopeAdmissionRequest },
    #[serde(rename = "policy.buildLocalScopeAdmission")]
    BuildLocalScopeAdmission {
        auth: Option<JsonValue>,
        #[serde(default)]
        grants: Vec<LocalAdmissionGrant>,
        #[serde(default)]
        options: LocalScopeAdmissionOptions,
    },
    #[serde(rename = "policy.buildAuthorityProofMetadata")]
    BuildAuthorityProofMetadata {
        options: Box<BuildAuthorityProofOptions>,
    },
    #[serde(rename = "policy.validateCredentialBinding")]
    ValidateCredentialBinding {
        request: Box<CredentialBindingRequest>,
    },
    #[serde(rename = "policy.evaluatePublicPullRequestCandidate")]
    EvaluatePublicPullRequestCandidate {
        request: PublicPullRequestCandidateRequest,
        #[serde(default)]
        policy: PublicWorkPolicy,
    },
    #[serde(rename = "policy.evaluatePublicCommentOpportunity")]
    EvaluatePublicCommentOpportunity {
        request: PublicCommentOpportunityRequest,
        #[serde(default)]
        policy: PublicWorkPolicy,
    },
    #[serde(rename = "policy.normalizePublicWorkPolicy")]
    NormalizePublicWorkPolicy {
        #[serde(default)]
        policy: PublicWorkPolicy,
    },
    #[serde(rename = "policy.scopeGrantAllows")]
    ScopeGrantAllows {
        #[serde(rename = "grantedScope")]
        granted_scope: String,
        #[serde(rename = "requestedScope")]
        requested_scope: String,
        policy: ScopeGrantPolicy,
    },
}

#[test]
fn policy_fixtures_match_rust_policy() -> Result<(), serde_json::Error> {
    for (name, source) in FIXTURES {
        let fixture: Fixture = serde_json::from_str(source)?;
        let actual = evaluate_policy_input(fixture.input)?;
        assert_eq!(actual, fixture.expected.value, "{name}");
    }
    Ok(())
}

fn evaluate_policy_input(input: PolicyInput) -> Result<serde_json::Value, serde_json::Error> {
    match input {
        PolicyInput::AdmitLocalSkill { skill, options } => {
            serde_json::to_value(admit_local_skill(&skill, &options))
        }
        PolicyInput::AdmitGraphStepScopes { request } => {
            serde_json::to_value(admit_graph_step_scopes(&request))
        }
        PolicyInput::BuildLocalScopeAdmission {
            auth,
            grants,
            options,
        } => serde_json::to_value(build_local_scope_admission(
            auth.as_ref(),
            &grants,
            &options,
        )),
        PolicyInput::BuildAuthorityProofMetadata { options } => {
            serde_json::to_value(build_authority_proof_metadata(&options))
        }
        PolicyInput::ValidateCredentialBinding { request } => {
            serde_json::to_value(validate_credential_binding(&request))
        }
        PolicyInput::EvaluatePublicPullRequestCandidate { request, policy } => {
            serde_json::to_value(evaluate_public_pull_request_candidate(&request, &policy))
        }
        PolicyInput::EvaluatePublicCommentOpportunity { request, policy } => {
            serde_json::to_value(evaluate_public_comment_opportunity(&request, &policy))
        }
        PolicyInput::NormalizePublicWorkPolicy { policy } => {
            serde_json::to_value(normalize_public_work_policy(&policy))
        }
        PolicyInput::ScopeGrantAllows {
            granted_scope,
            requested_scope,
            policy,
        } => serde_json::to_value(scope_grant_allows(&granted_scope, &requested_scope, policy)),
    }
}

use std::collections::BTreeMap;

use runx_contracts::{JsonValue, json_string_field};
use serde::Deserialize;

use crate::policy::{
    BuildAuthorityProofOptions, CredentialBindingRequest, GraphScopeAdmissionRequest,
    LocalAdmissionGrant, LocalAdmissionOptions, LocalAdmissionSkill, LocalScopeAdmissionOptions,
    PublicCommentOpportunityRequest, PublicPullRequestCandidateRequest, PublicWorkPolicy,
    RetryAdmissionRequest, SandboxAdmissionOptions, SandboxDeclaration,
};
use crate::state_machine::{
    FanoutBranchResult, FanoutGroupPolicy, SequentialGraphEvent, SequentialGraphState,
    SequentialGraphStepDefinition, SingleStepEvent, SingleStepState,
};

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(super) enum KernelDocument {
    Envelope { input: KernelInput },
    Input(KernelInput),
}

impl From<KernelDocument> for KernelInput {
    fn from(document: KernelDocument) -> Self {
        match document {
            KernelDocument::Envelope { input } | KernelDocument::Input(input) => input,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub(super) enum KernelInput {
    #[serde(rename = "policy.admitLocalSkill")]
    AdmitLocalSkill {
        skill: Box<LocalAdmissionSkill>,
        #[serde(default)]
        options: LocalAdmissionOptions,
    },
    #[serde(rename = "policy.admitRetryPolicy")]
    AdmitRetryPolicy { request: RetryAdmissionRequest },
    #[serde(rename = "policy.admitGraphStepScopes")]
    AdmitGraphStepScopes { request: GraphScopeAdmissionRequest },
    #[serde(rename = "policy.normalizeSandboxDeclaration")]
    NormalizeSandboxDeclaration { sandbox: Option<SandboxDeclaration> },
    #[serde(rename = "policy.sandboxRequiresApproval")]
    SandboxRequiresApproval { sandbox: Option<SandboxDeclaration> },
    #[serde(rename = "policy.admitSandbox")]
    AdmitSandbox {
        sandbox: Option<SandboxDeclaration>,
        #[serde(default)]
        options: SandboxAdmissionOptions,
    },
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
    #[serde(rename = "state-machine.createSingleStepState")]
    CreateSingleStepState { step_id: String },
    #[serde(rename = "state-machine.transitionSingleStep")]
    TransitionSingleStep {
        state: SingleStepState,
        event: SingleStepEvent,
    },
    #[serde(rename = "state-machine.createSequentialGraphState")]
    CreateSequentialGraphState {
        graph_id: String,
        steps: Vec<SequentialGraphStepDefinition>,
    },
    #[serde(rename = "state-machine.planSequentialGraphTransition")]
    PlanSequentialGraphTransition {
        state: SequentialGraphState,
        steps: Vec<SequentialGraphStepDefinition>,
        #[serde(default)]
        fanout_policies: BTreeMap<String, FanoutGroupPolicy>,
        resolved_fanout_gate_keys: Option<Vec<String>>,
    },
    #[serde(rename = "state-machine.transitionSequentialGraph")]
    TransitionSequentialGraph {
        state: SequentialGraphState,
        event: SequentialGraphEvent,
    },
    #[serde(rename = "state-machine.evaluateFanoutSync")]
    EvaluateFanoutSync {
        policy: FanoutGroupPolicy,
        results: Vec<FanoutBranchResult>,
        resolved_gate_keys: Option<Vec<String>>,
    },
    #[serde(rename = "state-machine.fanoutSyncDecisionKey")]
    FanoutSyncDecisionKey { decision: DecisionKeyInput },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DecisionKeyInput {
    pub(super) group_id: String,
    pub(super) rule_fired: String,
}

pub(super) fn kernel_document_kind(document: &JsonValue) -> Option<&str> {
    let JsonValue::Object(fields) = document else {
        return None;
    };
    match fields.get("input") {
        Some(JsonValue::Object(input)) => json_string_field(input, "kind"),
        _ => json_string_field(fields, "kind"),
    }
}

pub(super) fn is_supported_kernel_kind(kind: &str) -> bool {
    matches!(
        kind,
        "policy.admitLocalSkill"
            | "policy.admitRetryPolicy"
            | "policy.admitGraphStepScopes"
            | "policy.normalizeSandboxDeclaration"
            | "policy.sandboxRequiresApproval"
            | "policy.admitSandbox"
            | "policy.buildLocalScopeAdmission"
            | "policy.buildAuthorityProofMetadata"
            | "policy.validateCredentialBinding"
            | "policy.evaluatePublicPullRequestCandidate"
            | "policy.evaluatePublicCommentOpportunity"
            | "policy.normalizePublicWorkPolicy"
            | "state-machine.createSingleStepState"
            | "state-machine.transitionSingleStep"
            | "state-machine.createSequentialGraphState"
            | "state-machine.planSequentialGraphTransition"
            | "state-machine.transitionSequentialGraph"
            | "state-machine.evaluateFanoutSync"
            | "state-machine.fanoutSyncDecisionKey"
    )
}

// rust-style-allow: large-file - state-machine parity wire types stay colocated so single-step and
// sequential-graph serde surfaces are reviewed against the TS oracle together.
use std::collections::BTreeMap;

use runx_contracts::{AuthorityVerb, JsonNumber, JsonObject, JsonValue, Reference};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Admitted,
    Running,
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Paused,
    Escalated,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphStepStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    /// A `when` condition the runtime resolved to false selected this step out;
    /// it never runs and counts as terminal for graph-completion purposes.
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FanoutSyncStrategy {
    All,
    Any,
    Quorum,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FanoutBranchFailurePolicy {
    Halt,
    Continue,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FanoutGateAction {
    Pause,
    Escalate,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FanoutSyncOutcome {
    Proceed,
    Halt,
    Pause,
    Escalate,
}

impl From<FanoutGateAction> for FanoutSyncOutcome {
    fn from(action: FanoutGateAction) -> Self {
        match action {
            FanoutGateAction::Pause => Self::Pause,
            FanoutGateAction::Escalate => Self::Escalate,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SingleStepState {
    pub step_id: String,
    pub status: StepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityAdmissionWitness {
    pub verb: AuthorityVerb,
    pub parent_term_id: String,
    pub child_term_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability_ref: Option<Reference>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepAdmissionWitness {
    pub step_id: String,
    pub receipt_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority: Option<AuthorityAdmissionWitness>,
}

impl StepAdmissionWitness {
    #[must_use]
    pub fn local_runtime(step_id: impl Into<String>, receipt_id: impl Into<String>) -> Self {
        Self {
            step_id: step_id.into(),
            receipt_id: receipt_id.into(),
            authority: None,
        }
    }

    #[must_use]
    pub fn with_authority(
        step_id: impl Into<String>,
        receipt_id: impl Into<String>,
        authority: AuthorityAdmissionWitness,
    ) -> Self {
        Self {
            step_id: step_id.into(),
            receipt_id: receipt_id.into(),
            authority: Some(authority),
        }
    }

    #[must_use]
    pub fn matches_step_receipt(&self, step_id: &str, receipt_id: &str) -> bool {
        !self.step_id.is_empty()
            && !self.receipt_id.is_empty()
            && self.step_id == step_id
            && self.receipt_id == receipt_id
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SingleStepEvent {
    Admit,
    Start {
        at: String,
    },
    Succeed {
        at: String,
        admission_witness: Box<StepAdmissionWitness>,
    },
    Fail {
        at: String,
        error: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max_attempts: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequentialGraphStepDefinition {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_from: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fanout_group: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FanoutThresholdGate {
    pub step: String,
    pub field: String,
    pub above: JsonNumber,
    pub action: FanoutGateAction,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FanoutConflictGate {
    pub field: String,
    pub steps: Vec<String>,
    pub action: FanoutGateAction,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FanoutGroupPolicy {
    pub group_id: String,
    pub strategy: FanoutSyncStrategy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_success: Option<u32>,
    pub on_branch_failure: FanoutBranchFailurePolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold_gates: Option<Vec<FanoutThresholdGate>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_gates: Option<Vec<FanoutConflictGate>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FanoutBranchResult {
    pub step_id: String,
    pub status: GraphStepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outputs: Option<JsonObject>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FanoutSyncDecision {
    pub group_id: String,
    pub decision: FanoutSyncOutcome,
    pub strategy: FanoutSyncStrategy,
    pub rule_fired: String,
    pub reason: String,
    pub branch_count: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub required_successes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate: Option<FanoutGate>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum FanoutGate {
    Threshold {
        #[serde(rename = "stepId", skip_serializing_if = "Option::is_none")]
        step_id: Option<String>,
        field: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<JsonValue>,
        #[serde(rename = "comparedTo", skip_serializing_if = "Option::is_none")]
        compared_to: Option<JsonNumber>,
        action: FanoutGateAction,
    },
    Conflict {
        field: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        values: Option<BTreeMap<String, JsonValue>>,
        action: FanoutGateAction,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequentialGraphStepState {
    pub step_id: String,
    pub status: GraphStepStatus,
    pub attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outputs: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequentialGraphState {
    pub graph_id: String,
    pub status: GraphStatus,
    pub steps: Vec<SequentialGraphStepState>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SequentialGraphEvent {
    StartStep {
        step_id: String,
        at: String,
    },
    StepSucceeded {
        step_id: String,
        at: String,
        receipt_id: String,
        admission_witness: Box<StepAdmissionWitness>,
        #[serde(skip_serializing_if = "Option::is_none")]
        outputs: Option<JsonObject>,
    },
    StepFailed {
        step_id: String,
        at: String,
        error: String,
    },
    StepSkipped {
        step_id: String,
        at: String,
    },
    Complete,
    PauseGraph {
        reason: String,
    },
    EscalateGraph {
        reason: String,
    },
    FailGraph {
        error: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SequentialGraphPlan {
    RunStep {
        step_id: String,
        attempt: u32,
        context_from: Vec<String>,
    },
    RunFanout {
        group_id: String,
        step_ids: Vec<String>,
        attempts: BTreeMap<String, u32>,
        context_from: BTreeMap<String, Vec<String>>,
    },
    Complete,
    Failed {
        step_id: String,
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        sync_decision: Option<FanoutSyncDecision>,
    },
    Blocked {
        step_id: String,
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        sync_decision: Option<FanoutSyncDecision>,
    },
    Paused {
        step_id: String,
        reason: String,
        sync_decision: FanoutSyncDecision,
    },
    Escalated {
        step_id: String,
        reason: String,
        sync_decision: FanoutSyncDecision,
    },
}

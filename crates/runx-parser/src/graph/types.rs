use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use runx_contracts::{JsonObject, JsonValue};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawGraphIr {
    pub document: JsonObject,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphContextEdge {
    pub input: String,
    pub from_step: String,
    pub output: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphRetryPolicy {
    pub max_attempts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backoff_ms: Option<u64>,
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
pub enum FanoutThresholdAction {
    Pause,
    Escalate,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FanoutThresholdGate {
    pub step: String,
    pub field: String,
    pub above: f64,
    pub action: FanoutThresholdAction,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FanoutConflictAction {
    Pause,
    Escalate,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FanoutConflictGate {
    pub field: String,
    pub steps: Vec<String>,
    pub action: FanoutConflictAction,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FanoutGroupPolicy {
    pub group_id: String,
    pub strategy: FanoutSyncStrategy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_success: Option<u64>,
    pub on_branch_failure: FanoutBranchFailurePolicy,
    pub threshold_gates: Vec<FanoutThresholdGate>,
    pub conflict_gates: Vec<FanoutConflictGate>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphTransitionGate {
    pub to: String,
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equals: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_equals: Option<JsonValue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphPolicy {
    pub transitions: Vec<GraphTransitionGate>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphStep {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner: Option<String>,
    pub inputs: JsonObject,
    pub context: BTreeMap<String, String>,
    pub context_edges: Vec<GraphContextEdge>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context_skills: Vec<String>,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<GraphRetryPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fanout_group: Option<String>,
    pub mutating: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionGraph {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    pub steps: Vec<GraphStep>,
    pub fanout_groups: BTreeMap<String, FanoutGroupPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<GraphPolicy>,
    pub raw: RawGraphIr,
}

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
pub struct GraphGuard {
    pub step: String,
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equals: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_equals: Option<JsonValue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphPolicy {
    pub guards: Vec<GraphGuard>,
}

/// Per-step conditional selection. When present and the condition does not hold
/// (or the field is unresolved), the step is skipped and the graph continues;
/// sibling steps with complementary conditions form a branch. Unlike a guard,
/// a `when` never blocks the run, it selects.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphWhen {
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equals: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_equals: Option<JsonValue>,
}

/// Where [`MintAuthorityDirective`] draws the requested child scope from when the
/// runtime computes the attenuation off the model path. The two cases are
/// mutually exclusive by construction, so a step can never feed the mint from two
/// sources at once.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MintScopeSource {
    /// Derive the child from the step's static `scopes:` list (the common
    /// in-graph case). The declared ceiling and the minted term share one source,
    /// so they cannot drift.
    StaticScopes,
    /// Derive the child from a runtime input named by `requested_scope_from` (the
    /// dynamic case, e.g. an ops-desk-chosen scope). The mint fail-closes if the
    /// requested scope exceeds the charter.
    RequestedScope,
}

/// Declarative request to MINT (compute) the step's child authority term from the
/// graph charter, off the model path, rather than receive a pre-built term. This
/// is the compute path; the act-declaration `authority_term_from` /
/// `authority_parent_from` / `authority_subset_proof_from` keys remain the
/// explicit pre-built path. A directive is only coherent when the graph (or
/// runner) declares `charter_from`, since the mint narrows that parent charter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MintAuthorityDirective {
    pub source: MintScopeSource,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<GraphWhen>,
    pub mutating: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// Compute path: when present, the runtime mints this step's child authority
    /// term from the graph charter (named by `ExecutionGraph::charter_from`) off
    /// the model path, instead of receiving a pre-built term via the act
    /// declaration's `authority_*_from` keys.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mint_authority: Option<MintAuthorityDirective>,
    /// The input key carrying the requested child scope, used only when
    /// `mint_authority.source` is [`MintScopeSource::RequestedScope`]. The static
    /// `scopes:` list is the source for [`MintScopeSource::StaticScopes`]; the two
    /// are mutually exclusive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_scope_from: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionGraph {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// The input key carrying the parent charter authority term that steps with a
    /// `mint_authority` directive attenuate from. Declared once at the graph (or
    /// runner) level, replacing per-skill re-threading of the parent authority. A
    /// step's `mint_authority` is only coherent when this is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charter_from: Option<String>,
    pub steps: Vec<GraphStep>,
    pub fanout_groups: BTreeMap<String, FanoutGroupPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<GraphPolicy>,
    pub raw: RawGraphIr,
}

// rust-style-allow: large-file - skill schema vocabulary is intentionally
// centralized so parser fixtures, contract mirrors, and runtime front validation
// share one typed source of truth.
use std::collections::BTreeMap;

use runx_contracts::{ExecutionSemantics, JsonObject, JsonValue};
use runx_core::policy::{CwdPolicy, SandboxProfile};
use serde::{Deserialize, Serialize};

use crate::graph::MintAuthorityDirective;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSkillIr {
    pub frontmatter: JsonObject,
    pub raw_frontmatter: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInput {
    #[serde(rename = "type")]
    pub input_type: String,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<JsonValue>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRetryPolicy {
    pub max_attempts: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillIdempotencyPolicy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// Closed set of built-in skill source kinds. The extension lane is the
/// `ExternalAdapter` variant; custom adapters are identified by the
/// external-adapter manifest, not by an open `source.type` string. First-party
/// governed fronts that carry their own protocol, such as thread outbox
/// publication, get explicit variants.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    CliTool,
    Mcp,
    Catalog,
    A2a,
    Agent,
    #[serde(rename = "agent-task")]
    AgentStep,
    HarnessHook,
    Graph,
    Http,
    ExternalAdapter,
    ThreadOutboxProvider,
}

impl SourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SourceKind::CliTool => "cli-tool",
            SourceKind::Mcp => "mcp",
            SourceKind::Catalog => "catalog",
            SourceKind::A2a => "a2a",
            SourceKind::Agent => "agent",
            SourceKind::AgentStep => "agent-task",
            SourceKind::HarnessHook => "harness-hook",
            SourceKind::Graph => "graph",
            SourceKind::Http => "http",
            SourceKind::ExternalAdapter => "external-adapter",
            SourceKind::ThreadOutboxProvider => "thread-outbox-provider",
        }
    }
}

impl std::fmt::Display for SourceKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputMode {
    Args,
    Stdin,
    None,
}

impl InputMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            InputMode::Args => "args",
            InputMode::Stdin => "stdin",
            InputMode::None => "none",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    #[serde(rename = "type")]
    pub source_type: SourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_mode: Option<InputMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SkillSandbox>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<SkillMcpServer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_card_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outputs: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph: Option<crate::ExecutionGraph>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<SkillHttpSource>,
    /// The declared act this source performs, validated at load. `None` when no
    /// `act:` block is declared (the run then seals a generic observation act).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub act: Option<ActDeclaration>,
    pub raw: JsonObject,
}

/// A skill's declared act: how a run describes the act it performs. The form and
/// purpose, and how the target, decision, effect, actor, authority, and previous
/// receipt are read, where `<field>_from` names a trusted input key and the bare
/// field is a static literal (the driver-pinned input wins). The runtime fills
/// the act's structure from these and the trusted inputs; the model authors only
/// the reason prose. Absent an `act:` block, a run seals a generic observation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActDeclaration {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub form: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub form_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legitimacy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legitimacy_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_field_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_from_input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_prefix_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_from: Option<String>,
    /// Charter attenuation: the input key carrying the member's own authority term
    /// (the child grant minted from the charter).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_term_from: Option<String>,
    /// The input key carrying the parent (charter) authority reference the child
    /// term attenuates from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_parent_from: Option<String>,
    /// The input key carrying the subset proof that the child term is no broader
    /// than the parent charter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_subset_proof_from: Option<String>,
    /// Compute path (mutually exclusive with the explicit `authority_*_from` keys
    /// above): when present, the runtime mints the child authority term from the
    /// charter (resolved from config) off the model path instead of receiving a
    /// pre-built term. With `MintScopeSource::RequestedScope`, the requested child
    /// scope is read from the input key named by `requested_scope_from`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mint_authority: Option<MintAuthorityDirective>,
    /// The input key carrying the requested child scope, used only when
    /// `mint_authority.source` is `MintScopeSource::RequestedScope`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_scope_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_from: Option<String>,
    /// Graph turns only: the step whose output supplies the reason prose.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_step: Option<String>,
    /// Graph turns only: the step whose real result supplies the governed effect.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_step: Option<String>,
}

/// Config for an `http` source: the endpoint, the method, static request headers
/// (whose values may carry `${secret:NAME}` references resolved at invocation),
/// and an explicit, default-off opt-in to reach private or loopback networks
/// (the governed transport blocks them otherwise, mirroring the sandbox network
/// opt-in).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillHttpSource {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_private_network: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMcpServer {
    pub command: String,
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSandbox {
    pub profile: SandboxProfile,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd_policy: Option<CwdPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_allowlist: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<bool>,
    pub writable_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub require_enforcement: Option<bool>,
    #[serde(skip)]
    pub approved_escalation: Option<bool>,
    pub raw: JsonObject,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillArtifactContract {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emits: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub named_emits: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packets: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap_as: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValidateSkillMode {
    Strict,
    Lenient,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ValidateSkillOptions {
    pub mode: ValidateSkillMode,
}

impl Default for ValidateSkillOptions {
    fn default() -> Self {
        Self {
            mode: ValidateSkillMode::Strict,
        }
    }
}

impl ValidateSkillOptions {
    #[must_use]
    pub const fn strict() -> Self {
        Self {
            mode: ValidateSkillMode::Strict,
        }
    }

    #[must_use]
    pub const fn lenient() -> Self {
        Self {
            mode: ValidateSkillMode::Lenient,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedSkill {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runx_category: Option<String>,
    pub body: String,
    pub source: SkillSource,
    pub inputs: BTreeMap<String, SkillInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<SkillRetryPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency: Option<SkillIdempotencyPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mutating: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<SkillArtifactContract>,
    pub allowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionSemantics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runx: Option<JsonObject>,
    pub raw: RawSkillIr,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRunnerDefinition {
    pub name: String,
    pub default: bool,
    pub source: SkillSource,
    pub inputs: BTreeMap<String, SkillInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<SkillRetryPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency: Option<SkillIdempotencyPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mutating: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<SkillArtifactContract>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionSemantics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runx: Option<JsonObject>,
    pub raw: JsonObject,
}

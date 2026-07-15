//! Agent-context envelope (`runx.ai/spec/agent-context-envelope`): the bulky
//! per-act execution context referenced from a receipt act's `context_ref`
//! (instructions, inputs, current/historical artifact context, provenance, and
//! the resolved skill profiles).
//!
//! Identity is the legacy bare `runx.ai/spec` `$id` (no `x-runx-schema`).
use serde::{Deserialize, Serialize};

use crate::JsonObject;
use crate::output::OutputField;
use crate::schema::{NonEmptyString, RunxSchema};
use std::collections::BTreeMap;

/// The artifact context entry version. Committed as `const: "1"`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum ContextEntryVersion {
    #[serde(rename = "1")]
    V1,
}

/// The producer of a context artifact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ContextArtifactProducer {
    pub skill: NonEmptyString,
    pub runner: NonEmptyString,
}

/// Metadata for a context artifact. `step_id`, `parent_artifact_id`, and
/// `receipt_id` are required-but-nullable (present on the wire, possibly null).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ContextArtifactMeta {
    pub artifact_id: NonEmptyString,
    pub run_id: NonEmptyString,
    pub step_id: Option<NonEmptyString>,
    pub producer: ContextArtifactProducer,
    pub created_at: NonEmptyString,
    pub hash: NonEmptyString,
    pub size_bytes: u64,
    pub parent_artifact_id: Option<NonEmptyString>,
    pub receipt_id: Option<NonEmptyString>,
    pub redacted: bool,
}

/// A single artifact context entry. `type` is required-but-nullable.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ContextEntry {
    #[serde(rename = "type")]
    pub entry_type: Option<NonEmptyString>,
    pub version: ContextEntryVersion,
    pub data: JsonObject,
    pub meta: ContextArtifactMeta,
}

/// One input/output provenance edge.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ProvenanceEntry {
    pub input: NonEmptyString,
    pub output: NonEmptyString,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt_id: Option<String>,
}

/// A resolved profile sourced from a workspace file (memory, conventions,
/// voice).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ProfileFile {
    pub root_path: NonEmptyString,
    pub path: NonEmptyString,
    pub sha256: NonEmptyString,
    pub content: String,
}

/// The optional memory/conventions context block.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct AgentContextProfiles {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<ProfileFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conventions: Option<ProfileFile>,
}

/// Where the skill executes from on disk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ExecutionLocation {
    pub skill_directory: NonEmptyString,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_roots: Option<Vec<NonEmptyString>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(spec_id = "https://runx.ai/spec/agent-context-envelope.schema.json")]
pub struct AgentContextEnvelope {
    pub run_id: NonEmptyString,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<NonEmptyString>,
    pub skill: NonEmptyString,
    pub instructions: NonEmptyString,
    pub inputs: JsonObject,
    pub allowed_tools: Vec<NonEmptyString>,
    pub current_context: Vec<ContextEntry>,
    pub historical_context: Vec<ContextEntry>,
    pub provenance: Vec<ProvenanceEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<AgentContextProfiles>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_profile: Option<ProfileFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_location: Option<ExecutionLocation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<BTreeMap<String, OutputField>>,
    pub trust_boundary: NonEmptyString,
}

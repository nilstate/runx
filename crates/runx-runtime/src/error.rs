use std::path::PathBuf;

use runx_contracts::AuthorityVerb;
use runx_core::state_machine::FanoutSyncDecision;
use thiserror::Error;

use crate::credentials::CredentialDeliveryError;

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("runtime I/O failed while {context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("graph parse failed: {0}")]
    ParseGraph(#[from] runx_parser::ParseError),
    #[error("graph validation failed: {0}")]
    ValidateGraph(#[from] runx_parser::ValidationError),
    #[error("JSON serialization failed while {context}: {source}")]
    Json {
        context: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("graph step '{step_id}' is missing")]
    StepMissing { step_id: String },
    #[error("graph step '{step_id}' has no skill target")]
    StepMissingSkill { step_id: String },
    #[error("graph step '{step_id}' has invalid run configuration: {reason}")]
    InvalidRunStep { step_id: String, reason: String },
    #[error("graph step '{step_id}' uses unsupported run type '{run_type}'")]
    UnsupportedRunStep { step_id: String, run_type: String },
    #[error("graph step '{step_id}' is blocked: {reason}")]
    GraphBlocked { step_id: String, reason: String },
    #[error(
        "context edge from step '{from_step}' could not resolve path '{output_path}': segment '{missing_segment}' is absent; available keys there: [{}]",
        .available_keys.join(", ")
    )]
    ContextEdgeUnresolved {
        from_step: String,
        output_path: String,
        missing_segment: String,
        available_keys: Vec<String>,
    },
    #[error(
        "context edge from step '{from_step}' binds base/diagnostic field '{base_field}' (path '{output_path}'); base fields (raw/skill_claim/stdout/stderr/status) are not addressable, bind the step contract (a declared output or artifact packet) instead"
    )]
    ContextEdgeBaseKey {
        from_step: String,
        output_path: String,
        base_field: String,
    },
    #[error("authority {verb:?} denied graph step '{step_id}': {reason}")]
    AuthorityDenied {
        verb: AuthorityVerb,
        step_id: String,
        reason: String,
    },
    #[error("graph step '{step_id}' failed planning: {reason}")]
    GraphPlanningFailed { step_id: String, reason: String },
    #[error("graph step '{step_id}' paused: {reason}")]
    GraphPaused {
        step_id: String,
        reason: String,
        sync_decision: Box<FanoutSyncDecision>,
    },
    #[error("graph step '{step_id}' escalated: {reason}")]
    GraphEscalated {
        step_id: String,
        reason: String,
        sync_decision: Box<FanoutSyncDecision>,
    },
    #[error("checkpoint graph '{checkpoint_graph}' cannot resume graph '{graph}'")]
    CheckpointGraphMismatch {
        checkpoint_graph: String,
        graph: String,
    },
    #[error("unsupported adapter '{adapter_type}'")]
    UnsupportedAdapter { adapter_type: String },
    #[error("unsupported source kind '{source_kind}'")]
    UnsupportedSource { source_kind: String },
    #[error("runner selection '{runner}' is not supported by the native runtime yet")]
    UnsupportedRunnerSelection { runner: String },
    #[error("cli-tool source is missing command")]
    MissingCommand,
    #[error("sandbox violation: {message}")]
    SandboxViolation { message: String },
    #[error("credential delivery failed: {0}")]
    CredentialDelivery(#[from] CredentialDeliveryError),
    #[error("effect state failed while {context}: {message}")]
    EffectState { context: String, message: String },
    #[error("skill file is missing at {path}")]
    SkillFileMissing { path: PathBuf },
    #[error("skill '{skill_name}' failed: {message}")]
    SkillFailed { skill_name: String, message: String },
    #[error("receipt validation failed: {message}")]
    ReceiptInvalid { message: String },
}

impl RuntimeError {
    pub(crate) fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }

    pub(crate) fn json(context: impl Into<String>, source: serde_json::Error) -> Self {
        Self::Json {
            context: context.into(),
            source,
        }
    }

    pub(crate) fn effect_state(context: impl Into<String>, source: impl std::fmt::Display) -> Self {
        Self::EffectState {
            context: context.into(),
            message: source.to_string(),
        }
    }
}

// Module rationale: the canonical entrypoint keeps request/result
// types and prepared/unprepared execution dispatch in one reviewable boundary.
//! Canonical local orchestration entrypoint.
//!
//! CLI commands and TypeScript wrappers should enter local skill, graph, and
//! harness execution through this module instead of calling narrower execution
//! helpers directly.

use std::collections::BTreeMap;
use std::path::PathBuf;

use runx_contracts::{ClosureDisposition, JsonValue, Receipt};
use thiserror::Error;

use super::harness::{HarnessReplayError, HarnessReplayOutput};
use super::prepared_skill::{
    PreparedEntryProvenance, PreparedSkillRun, prepare_skill_run_with_effects,
};
#[cfg(feature = "cli-tool")]
use super::runner::GraphRun;
#[cfg(feature = "cli-tool")]
use super::skill_front::PackageHarnessReport;
use super::skill_front::SkillRunError;
use crate::effects::RuntimeEffectRegistry;

pub const DEFAULT_MANAGED_AGENT_MAX_ROUNDS: u32 = 4;
pub const MANAGED_AGENT_MAX_ROUNDS_LIMIT: u32 = 32;

/// Per-run consent for in-process model execution.
///
/// Model credentials configure availability; they never grant consent. The
/// default remains caller-mediated `needs_agent` resolution.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ManagedAgentPolicy {
    #[default]
    HostDriven,
    Inline {
        max_rounds: u32,
    },
}

impl ManagedAgentPolicy {
    pub fn inline(max_rounds: u32) -> Result<Self, String> {
        if !(1..=MANAGED_AGENT_MAX_ROUNDS_LIMIT).contains(&max_rounds) {
            return Err(format!(
                "managed-agent rounds must be between 1 and {MANAGED_AGENT_MAX_ROUNDS_LIMIT}"
            ));
        }
        Ok(Self::Inline { max_rounds })
    }

    #[must_use]
    pub const fn max_rounds(&self) -> Option<u32> {
        match self {
            Self::HostDriven => None,
            Self::Inline { max_rounds } => Some(*max_rounds),
        }
    }

    #[must_use]
    pub const fn is_inline(&self) -> bool {
        matches!(self, Self::Inline { .. })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SkillRunRequest {
    pub skill_path: PathBuf,
    pub receipt_dir: Option<PathBuf>,
    pub run_id: Option<String>,
    pub answers_path: Option<PathBuf>,
    pub inputs: BTreeMap<String, JsonValue>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
    /// Explicit consent for an in-process managed-agent loop. The default is
    /// host-driven resolution even when model credentials are configured.
    pub managed_agent: ManagedAgentPolicy,
    /// Optional resolved local credential supplied for this run.
    ///
    /// When present, the runtime derives a `CredentialDelivery` from it for this
    /// single run. The secret value is never persisted and is redacted from
    /// captured output, receipts, and metadata through the existing delivery
    /// channel. `None` keeps the current no-credential behavior.
    pub local_credential: Option<LocalCredentialDescriptor>,
}

/// Structured per-run credential delivery descriptor.
///
/// This is the local, no-network establishment surface for the OSS CLI: the
/// resolver supplies the non-secret binding fields plus the raw secret value, and
/// the runtime turns it into a `CredentialDelivery` through the existing opaque
/// `MaterialResolver`. No secret state is persisted; the descriptor lives only
/// for the duration of a single run.
#[derive(Clone, PartialEq, Eq)]
pub struct LocalCredentialDescriptor {
    /// Stored profile selector. This is non-secret and may be checkpointed so a
    /// resumed run re-resolves current material instead of persisting a secret.
    pub profile: Option<String>,
    /// Provider the credential authenticates against (for example `github`).
    pub provider: String,
    /// HTTPS audience declared by the resolved credential requirement. Native
    /// authenticated HTTP may only attenuate this destination binding.
    pub audience: Option<String>,
    /// Authentication mode label carried on the delivery profile/envelope.
    pub auth_mode: String,
    /// Environment variable the secret is delivered into for the skill process.
    pub env_var: String,
    /// Opaque reference identifying the in-memory material for this run.
    pub material_ref: String,
    /// Scopes recorded on the credential envelope.
    pub scopes: Vec<String>,
    /// The raw secret value supplied for this run only.
    pub secret: String,
}

// Manual Debug so the raw secret never reaches logs, panics, or any Debug of an
// enclosing type (e.g. SkillRunRequest).
impl std::fmt::Debug for LocalCredentialDescriptor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LocalCredentialDescriptor")
            .field("profile", &self.profile)
            .field("provider", &self.provider)
            .field("audience", &self.audience)
            .field("auth_mode", &self.auth_mode)
            .field("env_var", &self.env_var)
            .field("material_ref", &self.material_ref)
            .field("scopes", &self.scopes)
            .field("secret", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphRunRequest {
    pub graph_path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HarnessRunRequest {
    pub fixture_path: PathBuf,
    pub receipt_dir: Option<PathBuf>,
}

/// Request to run every harness case owned by a skill package. `skill_path` is
/// a package directory or its `SKILL.md`; inline cases and conventional fixture
/// files share the supplied environment and receipt directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageHarnessRequest {
    pub skill_path: PathBuf,
    pub receipt_dir: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunContinuation {
    pub run_id: Option<String>,
    pub answers_path: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RunRequest {
    Skill(Box<SkillRunRequest>),
    Graph(GraphRunRequest),
    Harness(HarnessRunRequest),
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunResult {
    pub status: RunStatus,
    pub output: JsonValue,
    pub receipt_refs: Vec<String>,
    pub child_receipt_refs: Vec<String>,
    pub pending_requests: Vec<JsonValue>,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunStatus {
    NeedsAgent,
    Sealed,
    Succeeded,
    Failed,
}

#[derive(Debug, Error)]
pub enum OrchestratorError {
    #[error(transparent)]
    SkillRun(#[from] SkillRunError),
    #[error(transparent)]
    Runtime(#[from] crate::RuntimeError),
    #[error(transparent)]
    Harness(#[from] HarnessReplayError),
    #[error(transparent)]
    ReceiptStore(#[from] crate::receipts::store::ReceiptStoreError),
    #[error(
        "native graph orchestration is unavailable because runx-runtime was built without the cli-tool feature"
    )]
    CliToolFeatureDisabled,
}

#[derive(Clone, Debug, Default)]
pub struct LocalOrchestrator {
    effects: RuntimeEffectRegistry,
    environment: BTreeMap<String, String>,
}

impl LocalOrchestrator {
    #[must_use]
    pub fn with_effects(effects: RuntimeEffectRegistry) -> Self {
        Self {
            effects,
            environment: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn with_effects_and_environment(
        effects: RuntimeEffectRegistry,
        environment: BTreeMap<String, String>,
    ) -> Self {
        Self {
            effects,
            environment,
        }
    }

    #[must_use]
    pub fn with_environment(&self, environment: BTreeMap<String, String>) -> Self {
        Self {
            effects: self.effects.clone(),
            environment,
        }
    }

    pub fn run(&self, request: RunRequest) -> Result<RunResult, OrchestratorError> {
        match request {
            RunRequest::Skill(request) => self.run_skill(&request),
            RunRequest::Graph(request) => self.run_graph(&request),
            RunRequest::Harness(request) => self.run_harness(&request),
        }
    }

    pub fn run_skill(&self, request: &SkillRunRequest) -> Result<RunResult, OrchestratorError> {
        let output = super::skill_front::execute_skill_run_with_effects(request, &self.effects)?;
        Ok(skill_result(output))
    }

    pub fn run_skill_with_runner(
        &self,
        request: &SkillRunRequest,
        runner: &str,
    ) -> Result<RunResult, OrchestratorError> {
        let overrides = super::skill_front::SkillRunOverrides {
            runner: Some(runner.to_owned()),
            seeded_answers: None,
        };
        let output = super::skill_front::execute_skill_run_with_overrides(
            request,
            &overrides,
            &self.effects,
        )?;
        Ok(skill_result(output))
    }

    pub fn run_skill_with_binding(
        &self,
        request: &SkillRunRequest,
        runner: Option<&str>,
        expected_package_digest: Option<&str>,
        expected_execution_closure_digest: Option<&str>,
    ) -> Result<RunResult, OrchestratorError> {
        let overrides = super::skill_front::SkillRunOverrides {
            runner: runner.map(str::to_owned),
            seeded_answers: None,
        };
        let output = super::skill_front::execute_bound_skill_run_with_overrides(
            request,
            &overrides,
            &self.effects,
            expected_package_digest,
            expected_execution_closure_digest,
        )?;
        Ok(skill_result(output))
    }

    pub fn prepare_skill(
        &self,
        request: SkillRunRequest,
        runner: Option<&str>,
        entry: PreparedEntryProvenance,
    ) -> Result<PreparedSkillRun, OrchestratorError> {
        Ok(prepare_skill_run_with_effects(
            request,
            runner,
            entry,
            &self.effects,
        )?)
    }

    pub fn run_prepared_skill(
        &self,
        prepared: &PreparedSkillRun,
    ) -> Result<RunResult, OrchestratorError> {
        if !prepared.is_ready() {
            return Err(SkillRunError::Invalid(
                prepared
                    .report()
                    .blocked_reason
                    .clone()
                    .unwrap_or_else(|| "prepared skill run is blocked".to_owned()),
            )
            .into());
        }
        if !prepared.is_context_bound() {
            return Err(SkillRunError::Invalid(
                "prepared skill run requires its context to be bound".to_owned(),
            )
            .into());
        }
        prepared.verify_artifacts()?;
        let overrides = super::skill_front::SkillRunOverrides {
            runner: Some(prepared.selected_runner().to_owned()),
            seeded_answers: None,
        };
        let output = super::skill_front::execute_prepared_skill_run_with_resolved(
            super::skill_front::ResolvedSkillRun {
                request: prepared.request(),
                overrides: &overrides,
                effects: &self.effects,
                skill_dir: &prepared.report().request.skill_path,
                manifest: prepared.manifest(),
                runner: prepared.runner(),
                package_digest: prepared.package_digest(),
                execution_closure_digest: prepared.execution_closure_digest(),
            },
        )?;
        Ok(skill_result(output))
    }

    pub fn run_graph(&self, request: &GraphRunRequest) -> Result<RunResult, OrchestratorError> {
        #[cfg(feature = "cli-tool")]
        {
            let mut options = super::runner::RuntimeOptions::from_env(self.environment.clone())?;
            options.effects = self.effects.clone();
            let runtime =
                super::runner::Runtime::new(crate::adapters::cli_tool::CliToolAdapter, options);
            graph_result(runtime.run_graph_file(&request.graph_path)?)
        }
        #[cfg(not(feature = "cli-tool"))]
        {
            let _ = (&self.environment, request);
            Err(OrchestratorError::CliToolFeatureDisabled)
        }
    }

    pub fn run_harness(&self, request: &HarnessRunRequest) -> Result<RunResult, OrchestratorError> {
        harness_result(self.run_harness_fixture(request)?)
    }

    #[cfg(feature = "cli-tool")]
    pub fn run_package_harness(
        &self,
        request: &PackageHarnessRequest,
    ) -> Result<PackageHarnessReport, OrchestratorError> {
        Ok(super::skill_front::run_package_harness_with_effects(
            &request.skill_path,
            request.receipt_dir.as_deref(),
            &self.environment,
            &self.effects,
        )?)
    }

    #[cfg(feature = "cli-tool")]
    pub fn run_harness_fixture(
        &self,
        request: &HarnessRunRequest,
    ) -> Result<HarnessReplayOutput, OrchestratorError> {
        let (mut options, receipt_dir) = standalone_harness_options(request, &self.environment)?;
        options.created_at = crate::time::DEFAULT_CREATED_AT.to_owned();
        options.effects = self.effects.clone();
        let output = super::harness::run_harness_fixture_with_adapter(
            &request.fixture_path,
            super::skill_front::SkillSourceAdapter::default(),
            options.clone(),
        )?;
        persist_harness_receipts(&output, &options, &receipt_dir)?;
        Ok(output)
    }

    #[cfg(not(feature = "cli-tool"))]
    pub fn run_harness_fixture(
        &self,
        request: &HarnessRunRequest,
    ) -> Result<HarnessReplayOutput, OrchestratorError> {
        let _ = self;
        let _ = request;
        Err(OrchestratorError::CliToolFeatureDisabled)
    }
}

#[cfg(feature = "cli-tool")]
fn standalone_harness_options(
    request: &HarnessRunRequest,
    environment: &BTreeMap<String, String>,
) -> Result<(super::runner::RuntimeOptions, PathBuf), OrchestratorError> {
    use crate::receipts::paths::RUNX_RECEIPT_DIR_ENV;

    let workspace = crate::WorkspaceEnv::from_admitted(environment.clone())
        .map_err(crate::RuntimeError::from)?;
    let mut env = workspace.env().clone();
    let configured = request
        .receipt_dir
        .clone()
        .or_else(|| env.get(RUNX_RECEIPT_DIR_ENV).map(PathBuf::from))
        .unwrap_or_else(|| workspace.cwd().join(".runx").join("receipts"));
    let receipt_dir = if configured.is_absolute() {
        configured
    } else {
        workspace.cwd().join(configured)
    };
    env.insert(
        RUNX_RECEIPT_DIR_ENV.to_owned(),
        receipt_dir.to_string_lossy().into_owned(),
    );
    let options = super::runner::RuntimeOptions::from_env_or_local_development(env)?;
    Ok((options, receipt_dir))
}

#[cfg(feature = "cli-tool")]
fn persist_harness_receipts(
    output: &HarnessReplayOutput,
    options: &super::runner::RuntimeOptions,
    receipt_dir: &std::path::Path,
) -> Result<(), OrchestratorError> {
    options.receipt_services().write_local_receipts(
        output
            .steps
            .iter()
            .flat_map(|step| {
                step.nested_receipts
                    .iter()
                    .chain(std::iter::once(&step.receipt))
            })
            .chain(std::iter::once(&output.receipt)),
        receipt_dir,
    )?;
    Ok(())
}

fn skill_result(output: JsonValue) -> RunResult {
    let status = match object_string(&output, "status") {
        Some("needs_agent") => RunStatus::NeedsAgent,
        Some("sealed") => RunStatus::Sealed,
        _ => RunStatus::Succeeded,
    };
    let receipt_refs = object_string(&output, "receipt_id")
        .map(|receipt_id| vec![receipt_id.to_owned()])
        .unwrap_or_default();
    let pending_requests = object_array(&output, "requests")
        .map(|requests| requests.to_vec())
        .unwrap_or_default();
    RunResult {
        status,
        output,
        receipt_refs,
        child_receipt_refs: Vec::new(),
        pending_requests,
        diagnostics: Vec::new(),
    }
}

#[cfg(feature = "cli-tool")]
fn graph_result(run: GraphRun) -> Result<RunResult, OrchestratorError> {
    let status = status_from_receipt(&run.receipt);
    let output = receipt_json(&run.receipt)?;
    Ok(RunResult {
        status,
        output,
        receipt_refs: vec![run.receipt.id.to_string()],
        child_receipt_refs: child_receipt_refs(&run.receipt),
        pending_requests: Vec::new(),
        diagnostics: Vec::new(),
    })
}

fn harness_result(output: HarnessReplayOutput) -> Result<RunResult, OrchestratorError> {
    let status = status_from_receipt(&output.receipt);
    let value = receipt_json(&output.receipt)?;
    Ok(RunResult {
        status,
        output: value,
        receipt_refs: vec![output.receipt.id.to_string()],
        child_receipt_refs: child_receipt_refs(&output.receipt),
        pending_requests: Vec::new(),
        diagnostics: Vec::new(),
    })
}

fn status_from_receipt(receipt: &Receipt) -> RunStatus {
    match receipt.seal.disposition {
        ClosureDisposition::Closed => RunStatus::Sealed,
        _ => RunStatus::Failed,
    }
}

fn receipt_json(receipt: &Receipt) -> Result<JsonValue, OrchestratorError> {
    let value = serde_json::to_value(receipt)
        .map_err(|source| crate::RuntimeError::json("serializing orchestrated receipt", source))?;
    serde_json::from_value(value)
        .map_err(|source| crate::RuntimeError::json("normalizing orchestrated receipt", source))
        .map_err(Into::into)
}

fn child_receipt_refs(receipt: &Receipt) -> Vec<String> {
    receipt
        .lineage
        .as_ref()
        .map(|lineage| {
            lineage
                .children
                .iter()
                .map(|reference| reference.uri.clone().into_string())
                .collect()
        })
        .unwrap_or_default()
}

fn object_string<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    let JsonValue::Object(object) = value else {
        return None;
    };
    let JsonValue::String(value) = object.get(key)? else {
        return None;
    };
    Some(value)
}

fn object_array<'a>(value: &'a JsonValue, key: &str) -> Option<&'a Vec<JsonValue>> {
    let JsonValue::Object(object) = value else {
        return None;
    };
    let JsonValue::Array(value) = object.get(key)? else {
        return None;
    };
    Some(value)
}

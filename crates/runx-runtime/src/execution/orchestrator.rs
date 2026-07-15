// rust-style-allow: large-file - the canonical entrypoint keeps request/result
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
use super::prepared_skill::{PreparedEntryProvenance, PreparedSkillRun, prepare_skill_run};
#[cfg(feature = "cli-tool")]
use super::runner::GraphRun;
use super::skill_front::{PackageHarnessReport, SkillRunError};
use crate::effects::RuntimeEffectRegistry;

#[derive(Clone, Debug, PartialEq)]
pub struct SkillRunRequest {
    pub skill_path: PathBuf,
    pub receipt_dir: Option<PathBuf>,
    pub run_id: Option<String>,
    pub answers_path: Option<PathBuf>,
    pub inputs: BTreeMap<String, JsonValue>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
    /// Optional one-shot, per-run local credential supplied at invocation.
    ///
    /// When present, the runtime derives a `CredentialDelivery` from it for this
    /// single run. The secret value is never persisted and is redacted from
    /// captured output, receipts, and metadata through the existing delivery
    /// channel. `None` keeps the current no-credential behavior.
    pub local_credential: Option<LocalCredentialDescriptor>,
}

/// Structured per-run credential provision request.
///
/// This is the local, no-network establishment surface for the OSS CLI: the
/// caller supplies the non-secret binding fields plus the raw secret value, and
/// the runtime turns it into a `CredentialDelivery` through the existing opaque
/// `MaterialResolver`. No secret state is persisted; the descriptor lives only
/// for the duration of a single run.
#[derive(Clone, PartialEq, Eq)]
pub struct LocalCredentialDescriptor {
    /// Provider the credential authenticates against (for example `github`).
    pub provider: String,
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
            .field("provider", &self.provider)
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
}

/// Request to run every harness case owned by a skill package. `skill_path` is
/// a package directory or its `SKILL.md`; inline cases and conventional fixture
/// files share the supplied environment and receipt directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageHarnessRequest {
    pub skill_path: PathBuf,
    pub receipt_dir: Option<PathBuf>,
    pub env: Option<BTreeMap<String, String>>,
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
    #[error(
        "native graph orchestration is unavailable because runx-runtime was built without the cli-tool feature"
    )]
    CliToolFeatureDisabled,
}

#[derive(Clone, Debug, Default)]
pub struct LocalOrchestrator {
    effects: RuntimeEffectRegistry,
}

impl LocalOrchestrator {
    #[must_use]
    pub fn with_effects(effects: RuntimeEffectRegistry) -> Self {
        Self { effects }
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

    pub fn prepare_skill(
        &self,
        request: SkillRunRequest,
        runner: Option<&str>,
        entry: PreparedEntryProvenance,
    ) -> Result<PreparedSkillRun, OrchestratorError> {
        Ok(prepare_skill_run(request, runner, entry)?)
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
        if prepared.approval().is_none() {
            return Err(SkillRunError::Invalid(
                "prepared skill run requires digest-bound operator approval".to_owned(),
            )
            .into());
        }
        prepared.verify_artifacts()?;
        let overrides = super::skill_front::SkillRunOverrides {
            runner: Some(prepared.selected_runner().to_owned()),
            seeded_answers: None,
        };
        let output = super::skill_front::execute_prepared_skill_run_with_resolved(
            prepared.request(),
            &overrides,
            &self.effects,
            &prepared.report().request.skill_path,
            prepared.manifest(),
            prepared.runner(),
        )?;
        Ok(skill_result(output))
    }

    pub fn run_graph(&self, request: &GraphRunRequest) -> Result<RunResult, OrchestratorError> {
        #[cfg(feature = "cli-tool")]
        {
            let mut options = super::runner::RuntimeOptions::from_process_env()?;
            options.effects = self.effects.clone();
            let runtime =
                super::runner::Runtime::new(crate::adapters::cli_tool::CliToolAdapter, options);
            graph_result(runtime.run_graph_file(&request.graph_path)?)
        }
        #[cfg(not(feature = "cli-tool"))]
        {
            let _ = request;
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
            request.env.as_ref(),
            &self.effects,
        )?)
    }

    #[cfg(feature = "cli-tool")]
    pub fn run_harness_fixture(
        &self,
        request: &HarnessRunRequest,
    ) -> Result<HarnessReplayOutput, OrchestratorError> {
        let mut options = super::runner::RuntimeOptions::from_process_env()?;
        options.created_at = crate::time::DEFAULT_CREATED_AT.to_owned();
        options.effects = self.effects.clone();
        Ok(super::harness::run_harness_fixture_with_adapter(
            &request.fixture_path,
            super::skill_front::SkillRunGraphAdapter::default(),
            options,
        )?)
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

// rust-style-allow: large-file because RuntimeOptions, checkpoint resume, and
// the public graph runner surface are still audited as one Rust cutover unit.
//! The act engine for runx: the single admit -> execute -> seal path every run
//! takes. A standalone skill is a one-act plan and a graph a multi-act plan;
//! both run through this one engine.
//!
//! The public surface lives here: [`Runtime`], [`RuntimeOptions`], [`StepRun`],
//! [`GraphRun`], [`GraphCheckpoint`], and the feature-gated [`run_graph_file`]
//! helper. The internal state machine and the per-step execution helpers live
//! in private submodules.

use std::collections::BTreeMap;
use std::path::Path;

use runx_contracts::{ClosureDisposition, FanoutReceiptSyncPoint, JsonObject, Receipt};
use runx_core::state_machine::{GraphStatus, SequentialGraphState, StepAdmissionWitness};
use runx_parser::ExecutionGraph;
use serde::{Deserialize, Serialize};

use super::graph::load_graph;
use crate::RuntimeError;
use crate::adapter::{SkillAdapter, SkillOutput};
use crate::effects::RuntimeEffectRegistry;
use crate::host::{Host, NoopHost};
use crate::journal::ExecutionJournal;
use crate::lifecycle::LifecycleEvent;
use crate::receipts::paths::{RUNX_CWD_ENV, RUNX_PROJECT_DIR_ENV, RUNX_RECEIPT_DIR_ENV};
use crate::receipts::signing::strip_receipt_signing_env;
use crate::receipts::{
    RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV, RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV,
    RUNX_RECEIPT_SIGN_KID_ENV, RuntimeReceiptSignatureConfig, RuntimeReceiptSignaturePolicy,
    graph_receipt_with_disposition_and_policy, graph_receipt_with_effects_and_signature_policy,
};
use crate::services::ReceiptServices;
use crate::{PROVIDER_PERMISSION_GRANT_ID_ENV, PROVIDER_PERMISSION_GRANTED_SCOPES_ENV};

mod authority;
mod execution;
mod host_resolution;
mod inputs;
mod scheduler;
mod step_execution;
mod steps;
mod sync;

use execution::GraphExecution;

pub const RUNX_MAX_FANOUT_CONCURRENCY_ENV: &str = "RUNX_MAX_FANOUT_CONCURRENCY";
pub const RUNX_RUN_ID_ENV: &str = "RUNX_RUN_ID";

#[derive(Clone, Debug)]
pub struct RuntimeOptions {
    pub created_at: String,
    pub env: BTreeMap<String, String>,
    pub receipt_signature: RuntimeReceiptSignatureConfig,
    pub effects: RuntimeEffectRegistry,
    /// Credentials delivered to graph step invocations. Defaults to none; a
    /// top-level skill run threads its own delivery here so credential-needing
    /// graph-step tools (e.g. http tools with `${secret:NAME}` headers) resolve.
    pub credential_delivery: crate::credentials::CredentialDelivery,
}

impl RuntimeOptions {
    #[must_use]
    pub fn local_development() -> Self {
        let env = safe_default_env();
        Self {
            created_at: crate::time::now_iso8601(),
            env,
            receipt_signature: RuntimeReceiptSignatureConfig::local_development(),
            effects: RuntimeEffectRegistry::default(),
            credential_delivery: crate::credentials::CredentialDelivery::none(),
        }
    }

    pub fn from_process_env() -> Result<Self, RuntimeError> {
        Self::from_env(safe_default_env())
    }

    pub fn from_env(mut env: BTreeMap<String, String>) -> Result<Self, RuntimeError> {
        let receipt_services =
            ReceiptServices::from_env(&env).map_err(|error| RuntimeError::ReceiptInvalid {
                message: error.to_string(),
            })?;
        strip_receipt_signing_env(&mut env);
        Ok(Self {
            created_at: crate::time::now_iso8601(),
            env,
            receipt_signature: receipt_services.signature_config().clone(),
            effects: RuntimeEffectRegistry::default(),
            credential_delivery: crate::credentials::CredentialDelivery::none(),
        })
    }

    #[must_use]
    pub fn signature_policy(&self) -> RuntimeReceiptSignaturePolicy<'_> {
        self.receipt_signature.signature_policy()
    }
}

fn safe_default_env() -> BTreeMap<String, String> {
    safe_default_env_from(crate::services::process_env_value)
}

fn safe_default_env_from(
    mut value_for_key: impl FnMut(&str) -> Option<String>,
) -> BTreeMap<String, String> {
    let allowed = [
        "PATH",
        "SystemRoot",
        "PATHEXT",
        RUNX_RECEIPT_DIR_ENV,
        RUNX_RECEIPT_SIGN_KID_ENV,
        RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV,
        RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV,
        crate::sandbox::RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV,
        RUNX_MAX_FANOUT_CONCURRENCY_ENV,
        RUNX_RUN_ID_ENV,
        RUNX_PROJECT_DIR_ENV,
        RUNX_CWD_ENV,
        PROVIDER_PERMISSION_GRANT_ID_ENV,
        PROVIDER_PERMISSION_GRANTED_SCOPES_ENV,
        "RUNX_HTTP_ALLOW_PRIVATE_NETWORK",
        "RUNX_REGISTRY_DIR",
        "RUNX_REGISTRY_URL",
    ];
    allowed
        .into_iter()
        .filter_map(|key| value_for_key(key).map(|value| (key.to_owned(), value)))
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StepRun {
    pub step_id: String,
    pub attempt: u32,
    pub skill: String,
    pub runner: Option<String>,
    pub fanout_group: Option<String>,
    pub output: SkillOutput,
    pub outputs: JsonObject,
    pub receipt: Receipt,
    pub admission_witness: StepAdmissionWitness,
}

#[derive(Clone, Debug)]
pub struct GraphRun {
    pub graph: ExecutionGraph,
    pub state: SequentialGraphState,
    pub steps: Vec<StepRun>,
    pub sync_points: Vec<FanoutReceiptSyncPoint>,
    pub receipt: Receipt,
    pub journal: ExecutionJournal,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GraphCheckpoint {
    pub graph_name: String,
    pub state: SequentialGraphState,
    pub steps: Vec<StepRun>,
    pub sync_points: Vec<FanoutReceiptSyncPoint>,
    pub journal: ExecutionJournal,
}

pub struct Runtime<A> {
    adapter: A,
    options: RuntimeOptions,
    step_types: steps::StepTypeRegistry<A>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BlockedGraphOutcome {
    Error,
    Receipt,
}

impl<A> Runtime<A>
where
    A: SkillAdapter,
{
    pub fn new(adapter: A, options: RuntimeOptions) -> Self {
        Self {
            adapter,
            options,
            step_types: steps::StepTypeRegistry::builtins(),
        }
    }

    pub(crate) fn options(&self) -> &RuntimeOptions {
        &self.options
    }

    pub fn run_graph_file(&self, graph_path: &Path) -> Result<GraphRun, RuntimeError> {
        let mut host = NoopHost;
        self.run_graph_file_with_host(graph_path, &mut host)
    }

    pub fn run_graph_file_with_host(
        &self,
        graph_path: &Path,
        host: &mut dyn Host,
    ) -> Result<GraphRun, RuntimeError> {
        let graph = load_graph(graph_path)?;
        let graph_dir = graph_path.parent().unwrap_or_else(|| Path::new("."));
        self.run_graph_with_host_outcome(graph_dir, graph, host, BlockedGraphOutcome::Error)
    }

    pub(crate) fn run_graph_file_for_harness(
        &self,
        graph_path: &Path,
        host: &mut dyn Host,
    ) -> Result<GraphRun, RuntimeError> {
        let graph = load_graph(graph_path)?;
        let graph_dir = graph_path.parent().unwrap_or_else(|| Path::new("."));
        self.run_graph_with_host_outcome(graph_dir, graph, host, BlockedGraphOutcome::Receipt)
    }

    pub fn run_graph_with_host(
        &self,
        graph_dir: &Path,
        graph: ExecutionGraph,
        host: &mut dyn Host,
    ) -> Result<GraphRun, RuntimeError> {
        self.run_graph_with_host_outcome(graph_dir, graph, host, BlockedGraphOutcome::Error)
    }

    // rust-style-allow: long-function because graph execution drives one ordered
    // ready-node loop (admit, dispatch to host, fold outcomes, advance frontier)
    // whose step sequencing must stay in a single scope to keep the run auditable.
    fn run_graph_with_host_outcome(
        &self,
        graph_dir: &Path,
        graph: ExecutionGraph,
        host: &mut dyn Host,
        blocked_outcome: BlockedGraphOutcome,
    ) -> Result<GraphRun, RuntimeError> {
        let mut execution = GraphExecution::new(&graph);
        match execution.run(self, graph_dir, &graph, host, None) {
            Ok(()) => {
                let receipt = graph_receipt_with_effects_and_signature_policy(
                    &graph.name,
                    &mut execution.runs,
                    execution.sync_points.clone(),
                    &self.options.created_at,
                    self.options.effects.clone(),
                    self.options.signature_policy(),
                )?;
                execution.record_lifecycle(
                    host,
                    LifecycleEvent::graph_completed(&graph.name, &receipt),
                )?;
                Ok(execution.finish(graph, receipt))
            }
            Err(RuntimeError::GraphBlocked { step_id, reason })
                if blocked_outcome == BlockedGraphOutcome::Receipt =>
            {
                let receipt = graph_receipt_with_disposition_and_policy(
                    &graph.name,
                    &mut execution.runs,
                    execution.sync_points.clone(),
                    &self.options.created_at,
                    crate::receipts::GraphClosure {
                        disposition: ClosureDisposition::Blocked,
                        reason_code: "graph_blocked".to_owned(),
                        summary: format!("graph {} blocked at {step_id}: {reason}", graph.name),
                    },
                    self.options.effects.clone(),
                    self.options.signature_policy(),
                )?;
                execution.record_lifecycle(
                    host,
                    LifecycleEvent::graph_blocked(&graph.name, &step_id, &receipt),
                )?;
                Ok(execution.finish(graph, receipt))
            }
            // A governed authority denial is a policy block, not a runtime fault:
            // under the receipt-sealing outcome it seals a signed blocked receipt,
            // the same as any other graph block, so the refusal is provable.
            Err(RuntimeError::AuthorityDenied {
                verb,
                step_id,
                reason,
            }) if blocked_outcome == BlockedGraphOutcome::Receipt => {
                let receipt = graph_receipt_with_disposition_and_policy(
                    &graph.name,
                    &mut execution.runs,
                    execution.sync_points.clone(),
                    &self.options.created_at,
                    crate::receipts::GraphClosure {
                        disposition: ClosureDisposition::Blocked,
                        reason_code: "authority_denied".to_owned(),
                        summary: format!(
                            "graph {} denied {verb:?} at {step_id}: {reason}",
                            graph.name
                        ),
                    },
                    self.options.effects.clone(),
                    self.options.signature_policy(),
                )?;
                execution.record_lifecycle(
                    host,
                    LifecycleEvent::graph_blocked(&graph.name, &step_id, &receipt),
                )?;
                Ok(execution.finish(graph, receipt))
            }
            Err(error) => Err(error),
        }
    }

    pub fn run_graph_file_until_steps(
        &self,
        graph_path: &Path,
        max_steps: usize,
    ) -> Result<GraphCheckpoint, RuntimeError> {
        let mut host = NoopHost;
        self.run_graph_file_until_steps_with_host(graph_path, max_steps, &mut host)
    }

    pub fn run_graph_file_until_steps_with_host(
        &self,
        graph_path: &Path,
        max_steps: usize,
        host: &mut dyn Host,
    ) -> Result<GraphCheckpoint, RuntimeError> {
        let graph = load_graph(graph_path)?;
        let graph_dir = graph_path.parent().unwrap_or_else(|| Path::new("."));
        self.run_graph_until_steps_with_host(graph_dir, &graph, max_steps, host)
    }

    pub fn run_graph_until_steps_with_host(
        &self,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        max_steps: usize,
        host: &mut dyn Host,
    ) -> Result<GraphCheckpoint, RuntimeError> {
        let mut execution = GraphExecution::new(graph);
        execution.run(self, graph_dir, graph, host, Some(max_steps))?;
        Ok(execution.checkpoint(graph.name.clone()))
    }

    pub fn resume_graph_file(
        &self,
        graph_path: &Path,
        checkpoint: GraphCheckpoint,
    ) -> Result<GraphRun, RuntimeError> {
        let mut host = NoopHost;
        self.resume_graph_file_with_host(graph_path, checkpoint, &mut host)
    }

    pub fn resume_graph_file_with_host(
        &self,
        graph_path: &Path,
        checkpoint: GraphCheckpoint,
        host: &mut dyn Host,
    ) -> Result<GraphRun, RuntimeError> {
        let graph = load_graph(graph_path)?;
        let graph_dir = graph_path.parent().unwrap_or_else(|| Path::new("."));
        self.resume_graph_with_host(graph_dir, graph, checkpoint, host)
    }

    pub fn resume_graph_with_host(
        &self,
        graph_dir: &Path,
        graph: ExecutionGraph,
        checkpoint: GraphCheckpoint,
        host: &mut dyn Host,
    ) -> Result<GraphRun, RuntimeError> {
        let mut execution = GraphExecution::from_checkpoint(&graph, checkpoint)?;
        execution.run(self, graph_dir, &graph, host, None)?;
        let receipt = graph_receipt_with_effects_and_signature_policy(
            &graph.name,
            &mut execution.runs,
            execution.sync_points.clone(),
            &self.options.created_at,
            self.options.effects.clone(),
            self.options.signature_policy(),
        )?;
        execution.record_lifecycle(host, LifecycleEvent::graph_completed(&graph.name, &receipt))?;
        Ok(execution.finish(graph, receipt))
    }

    pub(crate) fn seal_completed_graph_checkpoint_with_host(
        &self,
        graph: ExecutionGraph,
        checkpoint: GraphCheckpoint,
        host: &mut dyn Host,
    ) -> Result<GraphRun, RuntimeError> {
        if checkpoint.state.status != GraphStatus::Succeeded {
            return Err(RuntimeError::GraphBlocked {
                step_id: "graph".to_owned(),
                reason: format!(
                    "cannot seal graph checkpoint with status {:?}",
                    checkpoint.state.status
                ),
            });
        }
        let mut execution = GraphExecution::from_checkpoint(&graph, checkpoint)?;
        let receipt = graph_receipt_with_effects_and_signature_policy(
            &graph.name,
            &mut execution.runs,
            execution.sync_points.clone(),
            &self.options.created_at,
            self.options.effects.clone(),
            self.options.signature_policy(),
        )?;
        execution.record_lifecycle(host, LifecycleEvent::graph_completed(&graph.name, &receipt))?;
        Ok(execution.finish(graph, receipt))
    }

    pub(crate) fn seal_blocked_graph_checkpoint_with_host(
        &self,
        graph: ExecutionGraph,
        checkpoint: GraphCheckpoint,
        step_id: &str,
        reason_code: impl Into<String>,
        summary: impl Into<String>,
        host: &mut dyn Host,
    ) -> Result<GraphRun, RuntimeError> {
        let mut execution = GraphExecution::from_checkpoint(&graph, checkpoint)?;
        let receipt = graph_receipt_with_disposition_and_policy(
            &graph.name,
            &mut execution.runs,
            execution.sync_points.clone(),
            &self.options.created_at,
            crate::receipts::GraphClosure {
                disposition: ClosureDisposition::Blocked,
                reason_code: reason_code.into(),
                summary: summary.into(),
            },
            self.options.effects.clone(),
            self.options.signature_policy(),
        )?;
        execution.record_lifecycle(
            host,
            LifecycleEvent::graph_blocked(&graph.name, step_id, &receipt),
        )?;
        Ok(execution.finish(graph, receipt))
    }

    pub fn resume_graph_until_steps_with_host(
        &self,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        checkpoint: GraphCheckpoint,
        max_steps: usize,
        host: &mut dyn Host,
    ) -> Result<GraphCheckpoint, RuntimeError> {
        let mut execution = GraphExecution::from_checkpoint(graph, checkpoint)?;
        execution.run(self, graph_dir, graph, host, Some(max_steps))?;
        Ok(execution.checkpoint(graph.name.clone()))
    }
}

#[cfg(feature = "cli-tool")]
pub fn run_graph_file(graph_path: impl AsRef<Path>) -> Result<GraphRun, RuntimeError> {
    let runtime = Runtime::new(
        crate::adapters::cli_tool::CliToolAdapter,
        RuntimeOptions::from_process_env()?,
    );
    runtime.run_graph_file(graph_path.as_ref())
}

#[cfg(test)]
mod tests {
    use super::{
        RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV, RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV,
        RUNX_RECEIPT_SIGN_KID_ENV, RuntimeOptions, safe_default_env_from,
    };
    use crate::sandbox::RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV;
    use std::collections::BTreeMap;

    #[test]
    fn safe_default_env_preserves_receipt_signing_inputs() {
        let env = safe_default_env_from(|key| match key {
            RUNX_RECEIPT_SIGN_KID_ENV => Some("kid_prod".to_owned()),
            RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV => Some("seed".to_owned()),
            RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV => Some("hosted".to_owned()),
            _ => None,
        });

        assert_eq!(
            env.get(RUNX_RECEIPT_SIGN_KID_ENV),
            Some(&"kid_prod".to_owned())
        );
        assert_eq!(
            env.get(RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV),
            Some(&"seed".to_owned())
        );
        assert_eq!(
            env.get(RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV),
            Some(&"hosted".to_owned())
        );
    }

    #[test]
    fn safe_default_env_preserves_sandbox_operator_override() {
        let env = safe_default_env_from(|key| match key {
            RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV => Some("local".to_owned()),
            _ => None,
        });

        assert_eq!(
            env.get(RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV),
            Some(&"local".to_owned())
        );
    }

    #[test]
    fn runtime_options_reject_incomplete_production_signing_env() -> Result<(), String> {
        let env = [(RUNX_RECEIPT_SIGN_KID_ENV.to_owned(), "kid_prod".to_owned())]
            .into_iter()
            .collect::<BTreeMap<_, _>>();

        let error = RuntimeOptions::from_env(env)
            .err()
            .ok_or_else(|| "incomplete signing env unexpectedly succeeded".to_owned())?;
        assert!(
            error
                .to_string()
                .contains("production receipt signing requires")
        );
        Ok(())
    }

    #[test]
    fn runtime_options_reject_missing_production_signing_env() -> Result<(), String> {
        let error = RuntimeOptions::from_env(BTreeMap::new())
            .err()
            .ok_or_else(|| "missing signing env unexpectedly succeeded".to_owned())?;
        assert!(
            error
                .to_string()
                .contains("governed runtime receipt signing")
        );
        Ok(())
    }

    #[test]
    fn runtime_options_reject_malformed_production_signing_seed() -> Result<(), String> {
        let env = [
            (RUNX_RECEIPT_SIGN_KID_ENV.to_owned(), "kid_prod".to_owned()),
            (
                RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV.to_owned(),
                "not-base64".to_owned(),
            ),
            (
                RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV.to_owned(),
                "hosted".to_owned(),
            ),
        ]
        .into_iter()
        .collect::<BTreeMap<_, _>>();

        let error = RuntimeOptions::from_env(env)
            .err()
            .ok_or_else(|| "malformed signing env unexpectedly succeeded".to_owned())?;
        assert!(
            error
                .to_string()
                .contains("production receipt signer key material is malformed")
        );
        Ok(())
    }

    #[test]
    fn runtime_options_strip_receipt_signing_env_after_signer_construction() -> Result<(), String> {
        let env = [
            (RUNX_RECEIPT_SIGN_KID_ENV.to_owned(), "kid_prod".to_owned()),
            (
                RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV.to_owned(),
                "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=".to_owned(),
            ),
            (
                RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV.to_owned(),
                "hosted".to_owned(),
            ),
            ("RUNX_CWD".to_owned(), "/workspace".to_owned()),
        ]
        .into_iter()
        .collect::<BTreeMap<_, _>>();

        let options = RuntimeOptions::from_env(env).map_err(|error| error.to_string())?;

        assert!(!options.env.contains_key(RUNX_RECEIPT_SIGN_KID_ENV));
        assert!(
            !options
                .env
                .contains_key(RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV)
        );
        assert!(!options.env.contains_key(RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV));
        assert_eq!(options.env.get("RUNX_CWD"), Some(&"/workspace".to_owned()));
        Ok(())
    }
}

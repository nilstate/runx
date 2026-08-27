use std::collections::BTreeMap;
use std::path::Path;

use runx_contracts::{JsonObject, Receipt, Reference};
use runx_parser::GraphStep;

use crate::CapabilityContract;
use crate::RuntimeError;
use crate::adapter::InvocationOutput;
use crate::credentials::CredentialDelivery;

use super::{EffectAdmission, EffectReplay, RuntimeEffectError};

#[derive(Clone, Debug)]
pub enum EffectPreparationOutcome {
    Ready(Box<EffectAdmission>),
    Pending { reason: String },
}

pub trait RuntimeEffect: Send + Sync {
    fn family(&self) -> &'static str;

    /// Report where tools owned by this effect family actually execute.
    /// Provider-backed effects override this rather than letting the generic
    /// catalog guess from a tool name or scope.
    fn execution_boundary(&self) -> runx_contracts::ExecutionBoundaryKind {
        runx_contracts::ExecutionBoundaryKind::NativeCapability
    }

    /// Return true only when this effect family owns the resolved execution
    /// target. Graph authors never select a family: the runtime supplies the
    /// loaded skill or registered tool identity after resolution.
    fn matches_target(&self, request: EffectStepRequest<'_>) -> bool {
        let _ = request;
        false
    }

    /// Native catalog contracts implemented by this effect family. Keeping the
    /// contract beside the effect prevents the generic runtime from acquiring
    /// provider- or domain-specific tool knowledge while still giving graphs,
    /// managed agents, and operator discovery one typed catalog surface.
    fn capabilities(&self) -> &'static [&'static dyn CapabilityContract] {
        &[]
    }

    fn can_run_parallel(&self, step: &GraphStep) -> bool {
        let _ = step;
        true
    }

    fn find_replay(
        &self,
        request: EffectStepRequest<'_>,
    ) -> Result<Option<EffectReplay>, RuntimeEffectError> {
        let _ = request;
        Ok(None)
    }

    fn recover_pending(&self, request: EffectStepRequest<'_>) -> Result<(), RuntimeEffectError> {
        let _ = request;
        Ok(())
    }

    fn admit(
        &self,
        request: EffectStepRequest<'_>,
    ) -> Result<Option<EffectAdmission>, RuntimeEffectError> {
        let _ = request;
        Ok(None)
    }

    /// Prepare an admitted effect immediately before dispatch. The effect owner
    /// creates any attempt state and may return a host-resolution request when
    /// this exact act also requires approval.
    fn prepare_execution(
        &self,
        step: &GraphStep,
        admission: EffectAdmission,
        host: &mut dyn crate::Host,
    ) -> Result<EffectPreparationOutcome, RuntimeEffectError> {
        let _ = (step, host);
        Ok(EffectPreparationOutcome::Ready(Box::new(admission)))
    }

    fn prepare_output(&self, request: EffectOutputRequest<'_>) -> Result<(), RuntimeEffectError> {
        let _ = request;
        Ok(())
    }

    fn finalize_output(&self, request: EffectReceiptRequest<'_>) -> Result<(), RuntimeEffectError> {
        let _ = request;
        Ok(())
    }

    fn persist(&self, request: EffectReceiptRequest<'_>) -> Result<(), RuntimeEffectError> {
        let _ = request;
        Ok(())
    }

    fn prepare_replay_output(
        &self,
        request: EffectReplayOutputRequest<'_>,
    ) -> Result<(), RuntimeEffectError> {
        let _ = request;
        Ok(())
    }

    fn validate_replay(
        &self,
        request: EffectReplayReceiptRequest<'_>,
    ) -> Result<(), RuntimeEffectError> {
        let _ = request;
        Ok(())
    }

    fn authority_grant_refs(
        &self,
        admission: &EffectAdmission,
    ) -> Result<Vec<Reference>, RuntimeEffectError> {
        let _ = admission;
        Ok(Vec::new())
    }

    fn authority_scope_refs(
        &self,
        admission: &EffectAdmission,
    ) -> Result<Vec<Reference>, RuntimeEffectError> {
        let _ = admission;
        Ok(Vec::new())
    }

    fn replay_authority_grant_refs(
        &self,
        replay: &EffectReplay,
    ) -> Result<Vec<Reference>, RuntimeEffectError> {
        let _ = replay;
        Ok(Vec::new())
    }

    /// Invoke one catalog tool owned by this effect family.
    fn invoke_tool(
        &self,
        request: EffectToolRequest<'_>,
    ) -> Option<Result<runx_contracts::JsonValue, RuntimeError>> {
        let _ = request;
        None
    }
}

#[derive(Clone, Copy)]
pub struct EffectToolRequest<'a> {
    pub tool_ref: &'a str,
    pub observed_at: &'a str,
    pub inputs: &'a JsonObject,
    pub env: &'a BTreeMap<String, String>,
    pub skill_directory: &'a Path,
    pub credential_delivery: &'a CredentialDelivery,
    pub admission: Option<&'a EffectAdmission>,
}

#[derive(Clone, Copy, Debug)]
pub struct EffectStepRequest<'a> {
    pub step: &'a GraphStep,
    pub target: ResolvedEffectTarget<'a>,
    pub inputs: &'a JsonObject,
    pub env: &'a BTreeMap<String, String>,
    pub graph_dir: &'a Path,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ResolvedEffectTarget<'a> {
    pub skill_name: Option<&'a str>,
    pub tool_ref: Option<&'a str>,
}

pub struct EffectOutputRequest<'a> {
    pub step: &'a GraphStep,
    pub admission: &'a EffectAdmission,
    pub claim: &'a JsonObject,
    pub output: &'a mut InvocationOutput,
}

pub struct EffectReceiptRequest<'a> {
    pub step: &'a GraphStep,
    pub graph_dir: &'a Path,
    pub admission: &'a EffectAdmission,
    pub claim: &'a JsonObject,
    pub output: &'a mut InvocationOutput,
    pub receipt: &'a Receipt,
    pub env: &'a BTreeMap<String, String>,
    pub signature_policy: crate::receipts::RuntimeReceiptSignaturePolicy<'a>,
}

pub struct EffectReplayOutputRequest<'a> {
    pub step: &'a GraphStep,
    pub replay: &'a EffectReplay,
    pub output: &'a mut InvocationOutput,
}

pub struct EffectReplayReceiptRequest<'a> {
    pub step: &'a GraphStep,
    pub replay: &'a EffectReplay,
    pub receipt: &'a Receipt,
    pub output: &'a InvocationOutput,
    pub claim: &'a JsonObject,
}

use runx_contracts::Reference;
use runx_parser::GraphStep;
use runx_runtime::{
    EffectAdmission, EffectOutputRequest, EffectReceiptRequest, EffectReplay,
    EffectReplayOutputRequest, EffectReplayReceiptRequest, EffectStepRequest, RuntimeEffect,
    RuntimeEffectError,
};

use super::admission::admit_payment_effect;
use super::context::{is_payment_admission_key, payment_admission_field_present};
use super::output::{
    finalize_payment_output, payment_authority_grant_refs, prepare_payment_output,
    prepare_payment_replay_output, replay_authority_grant_refs, validate_payment_replay,
};
use super::replay::{find_payment_replay, recover_pending_payment};
use super::{PAYMENT_EFFECT_FAMILY, PAYMENT_FULFILL_SKILL, PaymentRuntimeEffect};

impl RuntimeEffect for PaymentRuntimeEffect {
    fn family(&self) -> &'static str {
        PAYMENT_EFFECT_FAMILY
    }

    fn matches_target(&self, request: EffectStepRequest<'_>) -> bool {
        request.target.skill_name == Some(PAYMENT_FULFILL_SKILL)
    }

    fn capabilities(&self) -> &'static [&'static dyn runx_runtime::CapabilityContract] {
        crate::planning::capabilities()
    }

    fn can_run_parallel(&self, step: &GraphStep) -> bool {
        !payment_authority_marker_present(step, &step.inputs)
    }

    fn find_replay(
        &self,
        request: EffectStepRequest<'_>,
    ) -> Result<Option<EffectReplay>, RuntimeEffectError> {
        find_payment_replay(request)
    }

    fn recover_pending(&self, request: EffectStepRequest<'_>) -> Result<(), RuntimeEffectError> {
        recover_pending_payment(request)
    }

    fn admit(
        &self,
        request: EffectStepRequest<'_>,
    ) -> Result<Option<EffectAdmission>, RuntimeEffectError> {
        admit_payment_effect(request)
    }

    fn prepare_output(&self, request: EffectOutputRequest<'_>) -> Result<(), RuntimeEffectError> {
        prepare_payment_output(self.supervisor.as_ref(), request)
    }

    fn finalize_output(&self, request: EffectReceiptRequest<'_>) -> Result<(), RuntimeEffectError> {
        finalize_payment_output(request)
    }

    fn persist(&self, request: EffectReceiptRequest<'_>) -> Result<(), RuntimeEffectError> {
        super::output::persist_payment_output(request)
    }

    fn authority_grant_refs(
        &self,
        admission: &EffectAdmission,
    ) -> Result<Vec<Reference>, RuntimeEffectError> {
        payment_authority_grant_refs(admission)
    }

    fn prepare_replay_output(
        &self,
        request: EffectReplayOutputRequest<'_>,
    ) -> Result<(), RuntimeEffectError> {
        prepare_payment_replay_output(request)
    }

    fn replay_authority_grant_refs(
        &self,
        replay: &EffectReplay,
    ) -> Result<Vec<Reference>, RuntimeEffectError> {
        replay_authority_grant_refs(replay)
    }

    fn validate_replay(
        &self,
        request: EffectReplayReceiptRequest<'_>,
    ) -> Result<(), RuntimeEffectError> {
        validate_payment_replay(request)
    }

    fn invoke_tool(
        &self,
        request: runx_runtime::EffectToolRequest<'_>,
    ) -> Option<Result<runx_contracts::JsonValue, runx_runtime::RuntimeError>> {
        crate::planning::invoke(request)
    }
}

fn payment_authority_marker_present(step: &GraphStep, inputs: &runx_contracts::JsonObject) -> bool {
    let context_has = |name: &str| step.context_edges.iter().any(|edge| edge.input == name);
    step.scopes.iter().any(|scope| scope == "payment:spend")
        || payment_admission_field_present(inputs)
        || (inputs.contains_key("reserved_payment_authority") && inputs.contains_key("idempotency"))
        || step
            .context_edges
            .iter()
            .any(|edge| is_payment_admission_key(&edge.input))
        || (context_has("reserved_payment_authority") && context_has("idempotency"))
}

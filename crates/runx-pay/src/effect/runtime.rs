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
    prepare_payment_replay_output, refresh_payment_output_metadata, replay_authority_grant_refs,
    validate_payment_replay,
};
use super::replay::{find_payment_replay, recover_pending_payment};
use super::{PAYMENT_EFFECT_FAMILY, PaymentRuntimeEffect};

impl RuntimeEffect for PaymentRuntimeEffect {
    fn family(&self) -> &'static str {
        PAYMENT_EFFECT_FAMILY
    }

    fn can_run_parallel(&self, step: &GraphStep) -> bool {
        !payment_admission_field_present(&step.inputs)
            && !step
                .context_edges
                .iter()
                .any(|edge| is_payment_admission_key(&edge.input))
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

    fn refresh_output_metadata(
        &self,
        request: runx_runtime::EffectMetadataRefreshRequest<'_>,
    ) -> Result<(), RuntimeEffectError> {
        refresh_payment_output_metadata(request)
    }
}

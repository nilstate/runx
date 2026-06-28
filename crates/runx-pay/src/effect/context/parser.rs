use std::collections::BTreeMap;

use runx_contracts::{JsonObject, Reference};
use runx_runtime::{EffectAdmission, EffectReplay, RuntimeEffectError};

use super::super::PAYMENT_EFFECT_FAMILY;
use super::payment_details::{
    period_spend_reservation, run_spend_reservation, settlement_identity_from_inputs,
};
use super::types::{
    OwnedStepAuthoritySubmission, PaymentAdmissionContext, PaymentReplayContext,
    StepPaymentAuthorityContext,
};
use crate::effect_state::EffectIdempotencyKey;

pub(in crate::effect) fn payment_context(
    input: &OwnedStepAuthoritySubmission,
    inputs: &JsonObject,
    env: &BTreeMap<String, String>,
) -> Result<Option<StepPaymentAuthorityContext>, RuntimeEffectError> {
    let Some(binding) = input.spend_capability_binding.as_ref() else {
        return Ok(None);
    };
    let Some(idempotency_key) = input.idempotency_key.as_ref() else {
        return Ok(None);
    };
    let Some(spend_capability_ref) = input.spend_capability_ref.as_ref() else {
        return Ok(None);
    };
    let run_spend = run_spend_reservation(input, inputs, env)?;
    let period_spend = period_spend_reservation(input)?;
    let settlement_identity = settlement_identity_from_inputs(inputs)?;
    Ok(Some(StepPaymentAuthorityContext {
        idempotency_key: EffectIdempotencyKey::new(
            binding.rail.clone(),
            binding.counterparty.clone(),
            idempotency_key.clone(),
        ),
        spend_capability_ref: spend_capability_ref.clone(),
        rail: binding.rail.clone(),
        counterparty: binding.counterparty.clone(),
        amount_minor: binding.amount_minor,
        currency: binding.currency.clone(),
        authority_ref: input.child_authority.resource_ref.clone(),
        run_spend,
        period_spend,
        settlement_identity,
    }))
}

pub(in crate::effect) fn payment_admission_context(
    admission: &EffectAdmission,
) -> Result<&PaymentAdmissionContext, RuntimeEffectError> {
    admission
        .context::<PaymentAdmissionContext>()
        .ok_or_else(|| RuntimeEffectError::Failed {
            family: PAYMENT_EFFECT_FAMILY.to_owned(),
            operation: "effect context",
            message: "payment admission context is missing".to_owned(),
        })
}

pub(in crate::effect) fn payment_replay_context(
    replay: &EffectReplay,
) -> Result<&PaymentReplayContext, RuntimeEffectError> {
    replay
        .context::<PaymentReplayContext>()
        .ok_or_else(|| RuntimeEffectError::Failed {
            family: PAYMENT_EFFECT_FAMILY.to_owned(),
            operation: "effect replay context",
            message: "payment replay context is missing".to_owned(),
        })
}

pub(in crate::effect) fn payment_admission_field_present(inputs: &JsonObject) -> bool {
    inputs.keys().any(|key| is_payment_admission_key(key))
}

pub(in crate::effect) fn is_payment_admission_key(key: &str) -> bool {
    matches!(key, "spend_capability_ref" | "payment_challenge")
}

pub(in crate::effect) fn same_reference(left: &Reference, right: &Reference) -> bool {
    left.uri == right.uri
        && left.reference_type == right.reference_type
        && left.provider == right.provider
        && left.locator == right.locator
        && left.proof_kind == right.proof_kind
}

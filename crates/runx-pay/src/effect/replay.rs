use runx_contracts::AuthorityVerb;
use runx_runtime::{EffectReplay, EffectStepRequest, RuntimeEffectError};

use super::PAYMENT_EFFECT_FAMILY;
use super::context::{
    PaymentReplayContext, StepPaymentAuthorityContext, payment_context, step_authority_submission,
};
use super::errors::{denied, failed};
use crate::authority::{StepAuthorityAdmission, admit_step_authority};
use crate::effect_state::{
    EffectIdempotencyEntry, EffectMutation, EffectMutationStatus, EffectRecoveryState,
    escalate_effect_mutation, lookup_effect_idempotency_entry, lookup_effect_mutation,
};

pub(super) fn find_payment_replay(
    request: EffectStepRequest<'_>,
) -> Result<Option<EffectReplay>, RuntimeEffectError> {
    let Some(input) = step_authority_submission(request.step, request.inputs)? else {
        return Ok(None);
    };
    let Some(payment) = payment_context(&input, request.inputs, request.env)? else {
        return Ok(None);
    };
    let Some(entry) = lookup_effect_idempotency_entry(
        request.env,
        request.graph_dir,
        PAYMENT_EFFECT_FAMILY,
        &payment.idempotency_key,
    )
    .map_err(|source| failed("state replay lookup", source))?
    else {
        return Ok(None);
    };

    let act_id = format!("act_{}", request.step.id);
    let decision = admit_step_authority(StepAuthorityAdmission {
        parent_authority: &input.parent_authority,
        child_authority: &input.child_authority,
        reservation_decision: input.reservation_decision.as_ref(),
        subset_proof: input.subset_proof.as_ref(),
        child_harness_ref: &input.child_harness_ref,
        act_id: &act_id,
        idempotency_key: input.idempotency_key.as_deref(),
        spend_capability_binding: input.spend_capability_binding.clone(),
        consumed_spend_capability_refs: &input.consumed_spend_capability_refs,
        spend_capability_ref: input.spend_capability_ref.as_ref(),
    })
    .map_err(|source| denied(source.to_string()))?;
    if decision.verb != Some(AuthorityVerb::Commit) {
        return Ok(None);
    }
    validate_entry_matches_payment(&entry, &payment)?;

    Ok(Some(EffectReplay::new(
        PAYMENT_EFFECT_FAMILY,
        entry.receipt_ref.clone(),
        entry.receipt_created_at.clone(),
        entry.receipt_digest.clone(),
        entry.outputs.clone(),
        PaymentReplayContext {
            rail_proof_ref: entry.rail_proof_ref.clone(),
            idempotency_key: entry.idempotency_key.clone(),
            authority_ref: payment.authority_ref.clone(),
            spend_capability_ref: payment.spend_capability_ref.clone(),
            rail: entry.supervisor_proof.rail.clone(),
            counterparty: entry.supervisor_proof.counterparty.clone(),
            amount_minor: entry.supervisor_proof.amount_minor,
            currency: entry.supervisor_proof.currency.clone(),
            act_id,
            supervisor_proof: entry.supervisor_proof.clone(),
        },
    )))
}

pub(super) fn recover_pending_payment(
    request: EffectStepRequest<'_>,
) -> Result<(), RuntimeEffectError> {
    let Some(input) = step_authority_submission(request.step, request.inputs)? else {
        return Ok(());
    };
    let Some(payment) = payment_context(&input, request.inputs, request.env)? else {
        return Ok(());
    };
    let Some(mutation) = pending_mutation_for_recovery(request, &payment)? else {
        return Ok(());
    };

    let act_id = format!("act_{}", request.step.id);
    admit_step_authority(StepAuthorityAdmission {
        parent_authority: &input.parent_authority,
        child_authority: &input.child_authority,
        reservation_decision: input.reservation_decision.as_ref(),
        subset_proof: input.subset_proof.as_ref(),
        child_harness_ref: &input.child_harness_ref,
        act_id: &act_id,
        idempotency_key: input.idempotency_key.as_deref(),
        spend_capability_binding: input.spend_capability_binding.clone(),
        consumed_spend_capability_refs: &input.consumed_spend_capability_refs,
        spend_capability_ref: input.spend_capability_ref.as_ref(),
    })
    .map_err(|source| denied(source.to_string()))?;
    validate_pending_mutation_matches_payment(&mutation, &payment)?;

    let _ = escalate_effect_mutation(
        request.env,
        request.graph_dir,
        PAYMENT_EFFECT_FAMILY,
        &payment.idempotency_key,
    )
    .map_err(|source| failed("state recovery escalation", source))?;
    Err(denied(format!(
        "payment idempotency key {} has an in-flight rail mutation; recovery escalated without issuing a second rail mutation",
        payment.idempotency_key.key
    )))
}

pub(super) fn receipt_has_payment_rail_proof(
    receipt: &runx_contracts::Receipt,
    rail_proof_ref: &str,
) -> bool {
    receipt.acts.iter().any(|act| {
        act.criterion_bindings
            .iter()
            .flat_map(|criterion| criterion.verification_refs.iter())
            .any(|reference| {
                reference.uri == rail_proof_ref
                    && reference.proof_kind.as_ref()
                        == Some(&runx_contracts::ProofKind::EffectEvidence)
            })
    })
}

fn pending_mutation_for_recovery(
    request: EffectStepRequest<'_>,
    payment: &StepPaymentAuthorityContext,
) -> Result<Option<EffectMutation>, RuntimeEffectError> {
    let mutation = lookup_effect_mutation(
        request.env,
        request.graph_dir,
        PAYMENT_EFFECT_FAMILY,
        &payment.idempotency_key,
    )
    .map_err(|source| failed("state recovery lookup", source))?;
    Ok(mutation.filter(|mutation| {
        mutation.recovery_state == EffectRecoveryState::InFlight
            || mutation.status == EffectMutationStatus::Partial
    }))
}

fn validate_pending_mutation_matches_payment(
    mutation: &EffectMutation,
    payment: &StepPaymentAuthorityContext,
) -> Result<(), RuntimeEffectError> {
    if mutation.amount_minor == payment.amount_minor
        && mutation.currency == payment.currency
        && mutation.rail == payment.rail
        && mutation.counterparty == payment.counterparty
    {
        return Ok(());
    }
    Err(denied(format!(
        "payment idempotency key {} has in-flight rail mutation for {} {} on {} {}, but this spend requested {} {} on {} {}",
        payment.idempotency_key.key,
        mutation.amount_minor,
        mutation.currency,
        mutation.rail,
        mutation.counterparty,
        payment.amount_minor,
        payment.currency,
        payment.rail,
        payment.counterparty
    )))
}

fn validate_entry_matches_payment(
    entry: &EffectIdempotencyEntry,
    payment: &StepPaymentAuthorityContext,
) -> Result<(), RuntimeEffectError> {
    if entry.amount_minor != payment.amount_minor || entry.currency != payment.currency {
        return Err(denied(format!(
            "payment idempotency key {} was sealed for {} {}, but this spend requested {} {}",
            payment.idempotency_key.key,
            entry.amount_minor,
            entry.currency,
            payment.amount_minor,
            payment.currency
        )));
    }
    if entry.supervisor_proof.rail == payment.rail
        && entry.supervisor_proof.counterparty == payment.counterparty
        && entry.supervisor_proof.spend_capability_ref == payment.spend_capability_ref.uri
    {
        return Ok(());
    }
    Err(denied(format!(
        "payment idempotency key {} supervisor proof was sealed for {} {}, capability {}, but this spend requested {} {}, capability {}",
        payment.idempotency_key.key,
        entry.supervisor_proof.rail,
        entry.supervisor_proof.counterparty,
        entry.supervisor_proof.spend_capability_ref,
        payment.rail,
        payment.counterparty,
        payment.spend_capability_ref.uri
    )))
}

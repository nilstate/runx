use std::collections::BTreeMap;
use std::path::Path;

use runx_contracts::{AuthorityVerb, Reference};
use runx_core::policy::authority_term_has_verb;
use runx_core::state_machine::AuthorityAdmissionWitness;
use runx_runtime::{EffectAdmission, EffectStepRequest, RuntimeEffectError};

use super::PAYMENT_EFFECT_FAMILY;
use super::context::{
    OwnedStepAuthoritySubmission, PaymentAdmissionContext, payment_context, same_reference,
    step_authority_submission,
};
use super::errors::{failed, finality_intent_error};
use crate::authority::{StepAuthorityAdmission, admit_step_authority};
use crate::effect_state::{
    EffectStepStateInput, consumed_spend_capability_recorded, record_effect_finality_intent,
};

// rust-style-allow: long-function because admission is one fail-closed
// decision path (parse submission, check idempotency, reserve, build the
// admission record) that must read top to bottom to stay auditable.
pub(super) fn admit_payment_effect(
    request: EffectStepRequest<'_>,
) -> Result<Option<EffectAdmission>, RuntimeEffectError> {
    let Some(input) = step_authority_submission(request.step, request.inputs)? else {
        return Ok(None);
    };
    let consumed_spend_capability_refs =
        consumed_spend_capability_refs_for_admission(&input, request.env, request.graph_dir)?;
    let act_id = format!("act_{}", request.step.id);
    let admission_error_verb =
        if authority_term_has_verb(&input.child_authority, AuthorityVerb::Commit) {
            AuthorityVerb::Commit
        } else {
            input
                .child_authority
                .verbs
                .first()
                .cloned()
                .unwrap_or(AuthorityVerb::Commit)
        };
    let decision = admit_step_authority(StepAuthorityAdmission {
        parent_authority: &input.parent_authority,
        child_authority: &input.child_authority,
        reservation_decision: input.reservation_decision.as_ref(),
        subset_proof: input.subset_proof.as_ref(),
        child_harness_ref: &input.child_harness_ref,
        act_id: &act_id,
        idempotency_key: input.idempotency_key.as_deref(),
        spend_capability_binding: input.spend_capability_binding.clone(),
        consumed_spend_capability_refs: &consumed_spend_capability_refs,
        spend_capability_ref: input.spend_capability_ref.as_ref(),
    })
    .map_err(|source| RuntimeEffectError::Denied {
        family: PAYMENT_EFFECT_FAMILY.to_owned(),
        verb: admission_error_verb,
        message: source.to_string(),
    })?;
    let Some(verb) = decision.verb else {
        return Ok(None);
    };
    let payment = if verb == AuthorityVerb::Commit {
        payment_context(&input, request.inputs, request.env)?
    } else {
        None
    };
    if let Some(payment) = payment.as_ref() {
        record_effect_finality_intent(
            request.env,
            request.graph_dir,
            &EffectStepStateInput {
                family: PAYMENT_EFFECT_FAMILY,
                idempotency_key: payment.idempotency_key.clone(),
                spend_capability_ref: payment.spend_capability_ref.uri.clone().into_string(),
                rail: payment.rail.clone(),
                counterparty: payment.counterparty.clone(),
                amount_minor: payment.amount_minor,
                currency: payment.currency.clone(),
                act_id: format!("act_{}", request.step.id),
                run_spend: payment.run_spend.clone(),
                period_spend: payment.period_spend.clone(),
            },
        )
        .map_err(finality_intent_error)?;
    }
    Ok(Some(EffectAdmission::new(
        PAYMENT_EFFECT_FAMILY,
        verb.clone(),
        AuthorityAdmissionWitness {
            verb,
            parent_term_id: decision.parent_term_id.to_owned(),
            child_term_id: decision.child_term_id.to_owned(),
            idempotency_key: decision.idempotency_key.map(str::to_owned),
            capability_ref: decision.spend_capability_ref.cloned(),
        },
        PaymentAdmissionContext { payment },
    )))
}

fn consumed_spend_capability_refs_for_admission(
    input: &OwnedStepAuthoritySubmission,
    env: &BTreeMap<String, String>,
    graph_dir: &Path,
) -> Result<Vec<Reference>, RuntimeEffectError> {
    let mut refs = input.consumed_spend_capability_refs.clone();
    let Some(spend_capability_ref) = input.spend_capability_ref.as_ref() else {
        return Ok(refs);
    };
    if consumed_spend_capability_recorded(
        env,
        graph_dir,
        PAYMENT_EFFECT_FAMILY,
        &spend_capability_ref.uri,
    )
    .map_err(|source| failed("state admission lookup", source))?
        && !refs
            .iter()
            .any(|reference| same_reference(reference, spend_capability_ref))
    {
        refs.push(spend_capability_ref.clone());
    }
    Ok(refs)
}

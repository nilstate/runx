use runx_contracts::{JsonNumber, JsonObject, JsonValue, ProofKind, Reference, ReferenceType};
use runx_runtime::{
    EffectAdmission, EffectOutputRequest, EffectReceiptRequest, EffectReplay,
    EffectReplayOutputRequest, EffectReplayReceiptRequest, InvocationOutput, RuntimeEffectError,
    insert_effect_verification_ref,
};

use super::PAYMENT_EFFECT_FAMILY;
use super::context::{
    StepPaymentAuthorityContext, payment_admission_context, payment_replay_context,
};
use super::errors::{denied, failed};
use super::finality::{PaymentFinalitySupervisor, PaymentFinalitySupervisorRequest};
use super::replay::receipt_has_payment_rail_proof;
use crate::effect_state::{EffectStepStateInput, persist_effect_step_state};
use crate::packets::{
    PaymentRailProof, read_effect_evidence_packet, redact_payment_transient_material,
};
use crate::supervisor::{
    PAYMENT_RAIL_SUPERVISOR_EVIDENCE_METADATA, PaymentSupervisorProofMatch,
    PaymentSupervisorSettlementEvidence, PaymentSupervisorVerificationInput,
    insert_payment_supervisor_proof_metadata, payment_supervisor_evidence_from_payload,
    payment_supervisor_evidence_metadata_value, payment_supervisor_evidence_reference,
    payment_supervisor_proof_reference, validate_payment_supervisor_proof,
    verify_payment_rail_supervisor_proof,
};

pub(super) fn prepare_payment_output(
    supervisor: &dyn PaymentFinalitySupervisor,
    request: EffectOutputRequest<'_>,
) -> Result<(), RuntimeEffectError> {
    let Some(payment) = payment_admission_context(request.admission)?
        .payment
        .as_ref()
    else {
        return Ok(());
    };
    if !request.output.succeeded() {
        return Ok(());
    }
    let Some(packet) = read_effect_evidence_packet(request.claim)
        .map_err(|source| failed("reading rail packet", source))?
    else {
        return Ok(());
    };
    let Some(claim) = packet.proof.as_ref() else {
        return Ok(());
    };
    let status = packet
        .result
        .as_ref()
        .and_then(|result| result.status.as_deref());
    let evidence = supervise_payment_output(supervisor, payment, claim, status)?;
    attach_payment_output_evidence(request.output, payment, &evidence)?;
    redact_transient_payment_output(request.output)
}

fn supervise_payment_output(
    supervisor: &dyn PaymentFinalitySupervisor,
    payment: &StepPaymentAuthorityContext,
    claim: &PaymentRailProof,
    status: Option<&str>,
) -> Result<PaymentSupervisorSettlementEvidence, RuntimeEffectError> {
    let supervisor_evidence = supervisor
        .supervise(supervisor_request(payment, claim, status))
        .map_err(|source| {
            denied(format!(
                "supervisor-verified rail proof is required: {source}"
            ))
        })?;
    if supervisor_evidence.family != PAYMENT_EFFECT_FAMILY {
        return Err(denied(format!(
            "supervisor returned evidence family {}, expected {}",
            supervisor_evidence.family, PAYMENT_EFFECT_FAMILY
        )));
    }
    payment_supervisor_evidence_from_payload(&supervisor_evidence.payload).map_err(|source| {
        denied(format!(
            "supervisor-verified rail proof is required: {source}"
        ))
    })
}

fn attach_payment_output_evidence(
    output: &mut InvocationOutput,
    payment: &StepPaymentAuthorityContext,
    evidence: &PaymentSupervisorSettlementEvidence,
) -> Result<(), RuntimeEffectError> {
    let value = payment_supervisor_evidence_metadata_value(evidence)
        .map_err(|source| failed("encoding supervisor evidence", source))?;
    output
        .metadata
        .insert(PAYMENT_RAIL_SUPERVISOR_EVIDENCE_METADATA.to_owned(), value);
    insert_effect_verification_ref(
        &mut output.metadata,
        payment_supervisor_evidence_reference(evidence),
    )?;
    if let Some(identity) = payment.settlement_identity.as_ref() {
        insert_effect_verification_ref(
            &mut output.metadata,
            Reference {
                reference_type: ReferenceType::Target,
                uri: format!("runx:money_movement:{}", identity.money_movement_id).into(),
                provider: Some(payment.rail.clone().into()),
                locator: None,
                label: Some("verified payment movement".into()),
                observed_at: None,
                proof_kind: Some(ProofKind::EffectFinality),
            },
        )?;
    }
    Ok(())
}

pub(super) fn finalize_payment_output(
    request: EffectReceiptRequest<'_>,
) -> Result<(), RuntimeEffectError> {
    let Some(payment) = payment_admission_context(request.admission)?
        .payment
        .as_ref()
    else {
        return Ok(());
    };
    if !request.output.succeeded() {
        return Ok(());
    }
    let act_id = format!("act_{}", request.step.id);
    let proof = verify_payment_rail_supervisor_proof(PaymentSupervisorVerificationInput {
        outputs: request.claim,
        metadata: &request.output.metadata,
        receipt: request.receipt,
        rail: &payment.rail,
        counterparty: &payment.counterparty,
        amount_minor: payment.amount_minor,
        currency: &payment.currency,
        idempotency_key: &payment.idempotency_key.key,
        spend_capability_ref: &payment.spend_capability_ref.uri,
        act_id: &act_id,
    })
    .map_err(|source| {
        denied(format!(
            "spend success requires supervisor-verified rail proof: {source}"
        ))
    })?;
    insert_payment_supervisor_proof_metadata(&mut request.output.metadata, &proof)
        .map_err(|source| failed("recording supervisor proof metadata", source))?;
    Ok(())
}

pub(super) fn persist_payment_output(
    request: EffectReceiptRequest<'_>,
) -> Result<(), RuntimeEffectError> {
    let Some(payment) = payment_admission_context(request.admission)?
        .payment
        .as_ref()
    else {
        return Ok(());
    };
    let proof = crate::supervisor::payment_supervisor_proof_from_metadata(&request.output.metadata)
        .map_err(|source| failed("reading supervisor proof metadata", source))?;
    // A failed rail act carries its partial evidence packet in the failure
    // value, not in the (success-only) contract claim. Durable state must
    // still record that in-flight mutation so a later run escalates instead
    // of issuing a second rail mutation.
    let evidence = payment_effect_evidence(request.claim, request.output)?;
    persist_effect_step_state(
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
        evidence,
        request.receipt,
        proof.as_ref(),
    )
    .map_err(|source| failed("persisting state", source))
}

fn payment_effect_evidence<'a>(
    claim: &'a JsonObject,
    output: &'a InvocationOutput,
) -> Result<&'a JsonObject, RuntimeEffectError> {
    if read_effect_evidence_packet(claim)
        .map_err(|source| failed("reading persisted rail packet", source))?
        .is_some()
    {
        return Ok(claim);
    }
    let Some(value) = (!output.succeeded())
        .then(|| output.value.as_object())
        .flatten()
    else {
        return Ok(claim);
    };
    if read_effect_evidence_packet(value)
        .map_err(|source| failed("reading failed rail packet", source))?
        .is_some()
    {
        return Ok(value);
    }
    Ok(claim)
}

pub(super) fn payment_authority_grant_refs(
    admission: &EffectAdmission,
) -> Result<Vec<Reference>, RuntimeEffectError> {
    let Some(payment) = payment_admission_context(admission)?.payment.as_ref() else {
        return Ok(Vec::new());
    };
    Ok(vec![
        payment.authority_ref.clone(),
        payment.spend_capability_ref.clone(),
    ])
}

pub(super) fn prepare_payment_replay_output(
    request: EffectReplayOutputRequest<'_>,
) -> Result<(), RuntimeEffectError> {
    let context = payment_replay_context(request.replay)?;
    insert_payment_supervisor_proof_metadata(
        &mut request.output.metadata,
        &context.supervisor_proof,
    )
    .map_err(|source| failed("recording replayed supervisor proof metadata", source))?;
    insert_effect_verification_ref(
        &mut request.output.metadata,
        payment_supervisor_proof_reference(&context.supervisor_proof),
    )
}

pub(super) fn replay_authority_grant_refs(
    replay: &EffectReplay,
) -> Result<Vec<Reference>, RuntimeEffectError> {
    let context = payment_replay_context(replay)?;
    Ok(vec![
        context.authority_ref.clone(),
        context.spend_capability_ref.clone(),
    ])
}

pub(super) fn validate_payment_replay(
    request: EffectReplayReceiptRequest<'_>,
) -> Result<(), RuntimeEffectError> {
    let context = payment_replay_context(request.replay)?;
    if !receipt_has_payment_rail_proof(request.receipt, &context.rail_proof_ref) {
        return Err(denied(format!(
            "sealed payment replay rebuilt receipt without rail proof {}",
            context.rail_proof_ref
        )));
    }
    validate_payment_supervisor_proof(
        &context.supervisor_proof,
        PaymentSupervisorProofMatch {
            proof_ref: &context.rail_proof_ref,
            rail: &context.rail,
            counterparty: &context.counterparty,
            amount_minor: context.amount_minor,
            currency: &context.currency,
            idempotency_key: &context.idempotency_key.key,
            spend_capability_ref: &context.spend_capability_ref.uri,
            act_id: &context.act_id,
            receipt_ref: &request.receipt.id,
            receipt_digest: &request.receipt.digest,
        },
    )
    .map_err(|source| {
        denied(format!(
            "sealed payment replay supervisor proof mismatch: {source}"
        ))
    })
}

fn redact_transient_payment_output(
    output: &mut InvocationOutput,
) -> Result<(), RuntimeEffectError> {
    let JsonValue::Object(payload) = &mut output.value else {
        return Ok(());
    };
    redact_payment_transient_material(payload);
    if let Some(JsonValue::Object(proof)) = payload.get_mut("rail_proof") {
        proof.remove("rail_session_material_ref");
    }
    Ok(())
}

fn supervisor_request<'a>(
    payment: &'a StepPaymentAuthorityContext,
    claim: &'a PaymentRailProof,
    skill_settlement_status: Option<&'a str>,
) -> PaymentFinalitySupervisorRequest<'a> {
    let mut payload = JsonObject::new();
    payload.insert("rail".to_owned(), JsonValue::String(payment.rail.clone()));
    payload.insert(
        "counterparty".to_owned(),
        JsonValue::String(payment.counterparty.clone()),
    );
    payload.insert(
        "amount_minor".to_owned(),
        JsonValue::Number(JsonNumber::U64(payment.amount_minor)),
    );
    payload.insert(
        "currency".to_owned(),
        JsonValue::String(payment.currency.clone()),
    );
    payload.insert(
        "idempotency_key".to_owned(),
        JsonValue::String(payment.idempotency_key.key.clone()),
    );
    payload.insert(
        "proof_ref".to_owned(),
        JsonValue::String(claim.proof_ref.clone()),
    );
    if let Some(identity) = payment.settlement_identity.as_ref() {
        payload.insert(
            "payment_admission_id".to_owned(),
            JsonValue::String(identity.payment_admission_id.clone()),
        );
        payload.insert(
            "money_movement_id".to_owned(),
            JsonValue::String(identity.money_movement_id.clone()),
        );
        payload.insert(
            "kernel_token_digest".to_owned(),
            JsonValue::String(identity.kernel_token_digest.clone()),
        );
    }
    if let Some(status) = skill_settlement_status {
        payload.insert(
            "skill_settlement_status".to_owned(),
            JsonValue::String(status.to_owned()),
        );
    }
    PaymentFinalitySupervisorRequest {
        family: PAYMENT_EFFECT_FAMILY,
        payload,
    }
}

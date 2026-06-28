use std::collections::BTreeMap;
use std::path::Path;

use runx_contracts::{JsonObject, JsonValue};

use crate::packets::read_effect_evidence_packet;
use crate::supervisor::{
    PaymentSupervisorProof, PaymentSupervisorProofMatch, validate_payment_supervisor_proof,
};

use super::recovery::{payment_recovery_state, rail_mutation_status};
use super::resolver::open_supported_effect_state_store;
use super::{
    EffectCapabilityConsumption, EffectFinalityIntent, EffectFinalityIntentStatus,
    EffectIdempotencyEntry, EffectIdempotencyKey, EffectMutation, EffectStateError,
    EffectStateStore, EffectStepStateInput,
};
pub fn consumed_spend_capability_recorded(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    family: &'static str,
    capability_ref: &str,
) -> Result<bool, EffectStateError> {
    let Some(store) = open_supported_effect_state_store(env, cwd)? else {
        return Ok(false);
    };
    Ok(consumed_spend_capability_recorded_in_store(
        store.as_ref(),
        family,
        capability_ref,
    ))
}

pub fn consumed_spend_capability_recorded_in_store(
    store: &(impl EffectStateStore + ?Sized),
    family: &'static str,
    capability_ref: &str,
) -> bool {
    store
        .lookup_consumed_spend_capability(family, capability_ref)
        .is_some()
}

pub fn lookup_effect_idempotency_entry(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    family: &'static str,
    key: &EffectIdempotencyKey,
) -> Result<Option<EffectIdempotencyEntry>, EffectStateError> {
    let Some(store) = open_supported_effect_state_store(env, cwd)? else {
        return Ok(None);
    };
    Ok(lookup_effect_idempotency_entry_in_store(
        store.as_ref(),
        family,
        key,
    ))
}

pub fn lookup_effect_idempotency_entry_in_store(
    store: &(impl EffectStateStore + ?Sized),
    family: &'static str,
    key: &EffectIdempotencyKey,
) -> Option<EffectIdempotencyEntry> {
    store.lookup_idempotency(family, key).cloned()
}

pub fn lookup_effect_mutation(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    family: &'static str,
    key: &EffectIdempotencyKey,
) -> Result<Option<EffectMutation>, EffectStateError> {
    let Some(store) = open_supported_effect_state_store(env, cwd)? else {
        return Ok(None);
    };
    Ok(lookup_effect_mutation_in_store(store.as_ref(), family, key))
}

pub fn lookup_effect_mutation_in_store(
    store: &(impl EffectStateStore + ?Sized),
    family: &'static str,
    key: &EffectIdempotencyKey,
) -> Option<EffectMutation> {
    store.lookup_mutation(family, key).cloned()
}

pub fn record_effect_finality_intent(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    input: &EffectStepStateInput,
) -> Result<(), EffectStateError> {
    let Some(mut store) = open_supported_effect_state_store(env, cwd)? else {
        return Ok(());
    };
    record_effect_finality_intent_in_store(store.as_mut(), input)
}

pub fn record_effect_finality_intent_in_store(
    store: &mut (impl EffectStateStore + ?Sized),
    input: &EffectStepStateInput,
) -> Result<(), EffectStateError> {
    store.record_finality_intent(
        input.family,
        EffectFinalityIntent {
            idempotency_key: input.idempotency_key.clone(),
            rail: input.rail.clone(),
            amount_minor: input.amount_minor,
            currency: input.currency.clone(),
            counterparty: input.counterparty.clone(),
            spend_capability_ref: input.spend_capability_ref.clone(),
            act_id: input.act_id.clone(),
            status: EffectFinalityIntentStatus::Open,
        },
        input.run_spend.as_ref(),
        input.period_spend.as_ref(),
    )
}

pub fn escalate_effect_mutation(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    family: &'static str,
    key: &EffectIdempotencyKey,
) -> Result<Option<EffectMutation>, EffectStateError> {
    let Some(mut store) = open_supported_effect_state_store(env, cwd)? else {
        return Ok(None);
    };
    escalate_effect_mutation_in_store(store.as_mut(), family, key)
}

pub fn escalate_effect_mutation_in_store(
    store: &mut (impl EffectStateStore + ?Sized),
    family: &'static str,
    key: &EffectIdempotencyKey,
) -> Result<Option<EffectMutation>, EffectStateError> {
    store.escalate_mutation(family, key)
}

// rust-style-allow: long-function because effect state persistence binds
// authority, output, receipt, and recovery-state invariants in one transaction.
pub fn persist_effect_step_state(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    input: &EffectStepStateInput,
    outputs: &JsonObject,
    receipt: &runx_contracts::Receipt,
    supervisor_proof: Option<&PaymentSupervisorProof>,
) -> Result<(), EffectStateError> {
    let Some(mut store) = open_supported_effect_state_store(env, cwd)? else {
        return Ok(());
    };
    persist_effect_step_state_in_store(store.as_mut(), input, outputs, receipt, supervisor_proof)
}

// rust-style-allow: long-function because effect state persistence binds
// authority, output, receipt, and recovery-state invariants in one transaction.
pub fn persist_effect_step_state_in_store(
    store: &mut (impl EffectStateStore + ?Sized),
    input: &EffectStepStateInput,
    outputs: &JsonObject,
    receipt: &runx_contracts::Receipt,
    supervisor_proof: Option<&PaymentSupervisorProof>,
) -> Result<(), EffectStateError> {
    let rail_packet = read_effect_evidence_packet(outputs)?;
    let recovery_state = payment_recovery_state(rail_packet.as_ref());
    let rail_touched = rail_packet
        .as_ref()
        .and_then(|packet| packet.result.as_ref())
        .and_then(|result| result.status.as_deref())
        .is_some();

    if rail_touched
        && store
            .lookup_consumed_spend_capability(input.family, &input.spend_capability_ref)
            .is_none()
    {
        store.consume_spend_capability(
            input.family,
            EffectCapabilityConsumption {
                capability_ref: input.spend_capability_ref.clone(),
                idempotency_key: input.idempotency_key.clone(),
                receipt_ref: Some(receipt.id.to_string()),
                recovery_state: Some(recovery_state.clone()),
            },
        )?;
    }

    let proof_ref = rail_packet
        .as_ref()
        .and_then(|packet| packet.proof.as_ref())
        .map(|proof| proof.proof_ref.as_str());

    if let Some(proof_ref) = proof_ref
        && store
            .lookup_idempotency(input.family, &input.idempotency_key)
            .is_none()
    {
        // Validate the supervisor proof only when sealing a new record. A
        // duplicate persist for an already-sealed idempotency key keeps the
        // first record; the sealed-replay path is the guard against forged
        // replays of an existing key.
        let supervisor_proof =
            validate_sealed_supervisor_proof(input, receipt, proof_ref, supervisor_proof)?;
        let result = rail_packet
            .as_ref()
            .and_then(|packet| packet.result.as_ref());
        store.record_idempotency(
            input.family,
            EffectIdempotencyEntry {
                idempotency_key: input.idempotency_key.clone(),
                receipt_ref: receipt.id.to_string(),
                receipt_created_at: receipt.created_at.to_string(),
                receipt_digest: receipt.digest.to_string(),
                rail_proof_ref: proof_ref.to_owned(),
                supervisor_proof: supervisor_proof.clone(),
                amount_minor: result
                    .and_then(|result| result.amount_minor)
                    .unwrap_or(input.amount_minor),
                currency: result
                    .and_then(|result| result.currency.as_deref())
                    .unwrap_or(&input.currency)
                    .to_owned(),
                outputs: replay_safe_outputs(outputs)?,
            },
        )?;
        store.seal_run_spend(input.family, input, &receipt.id)?;
        store.seal_period_spend(input.family, input, &receipt.id)?;
    }

    if rail_touched
        && store
            .lookup_mutation(input.family, &input.idempotency_key)
            .is_none()
    {
        let result = rail_packet
            .as_ref()
            .and_then(|packet| packet.result.as_ref());
        store.record_mutation(
            input.family,
            EffectMutation {
                idempotency_key: input.idempotency_key.clone(),
                rail: result
                    .and_then(|result| result.rail.as_deref())
                    .unwrap_or(&input.rail)
                    .to_owned(),
                amount_minor: result
                    .and_then(|result| result.amount_minor)
                    .unwrap_or(input.amount_minor),
                currency: result
                    .and_then(|result| result.currency.as_deref())
                    .unwrap_or(&input.currency)
                    .to_owned(),
                counterparty: result
                    .and_then(|result| result.counterparty.as_deref())
                    .unwrap_or(&input.counterparty)
                    .to_owned(),
                status: rail_mutation_status(&recovery_state),
                proof_ref: proof_ref.map(str::to_owned),
                recovery_state,
            },
        )?;
    }

    Ok(())
}

fn validate_sealed_supervisor_proof<'a>(
    input: &EffectStepStateInput,
    receipt: &runx_contracts::Receipt,
    proof_ref: &str,
    supervisor_proof: Option<&'a PaymentSupervisorProof>,
) -> Result<&'a PaymentSupervisorProof, EffectStateError> {
    let proof = supervisor_proof.ok_or_else(|| EffectStateError::MissingSupervisorProof {
        proof_ref: proof_ref.to_owned(),
    })?;
    validate_payment_supervisor_proof(
        proof,
        PaymentSupervisorProofMatch {
            proof_ref,
            rail: &input.rail,
            counterparty: &input.counterparty,
            amount_minor: input.amount_minor,
            currency: &input.currency,
            idempotency_key: &input.idempotency_key.key,
            spend_capability_ref: &input.spend_capability_ref,
            act_id: &input.act_id,
            receipt_ref: &receipt.id,
            receipt_digest: &receipt.digest,
        },
    )
    .map_err(|source| EffectStateError::SupervisorProof {
        message: source.to_string(),
    })?;
    Ok(proof)
}

fn replay_safe_outputs(outputs: &JsonObject) -> Result<JsonObject, EffectStateError> {
    let mut safe_outputs = outputs.clone();
    sanitize_replay_payload(&mut safe_outputs);

    let mut stdout_payload = safe_outputs.clone();
    stdout_payload.remove("stdout");
    stdout_payload.remove("stderr");
    stdout_payload.remove("status");
    sanitize_replay_payload(&mut stdout_payload);

    let stdout = serde_json::to_string(&JsonValue::Object(stdout_payload))
        .map_err(|source| EffectStateError::ReplayOutputSerialize { source })?;
    safe_outputs.insert("stdout".to_owned(), JsonValue::String(stdout));
    safe_outputs
        .entry("stderr".to_owned())
        .or_insert_with(|| JsonValue::String(String::new()));
    safe_outputs
        .entry("status".to_owned())
        .or_insert_with(|| JsonValue::String("success".to_owned()));
    Ok(safe_outputs)
}

fn sanitize_replay_payload(payload: &mut JsonObject) {
    let Some(JsonValue::Object(packet)) = payload.get_mut("effect_evidence_packet") else {
        return;
    };
    let Some(JsonValue::Object(data)) = packet.get_mut("data") else {
        return;
    };
    if let Some(JsonValue::Object(proof)) = data.get_mut("rail_proof") {
        proof.remove("rail_session_material_ref");
    }
}

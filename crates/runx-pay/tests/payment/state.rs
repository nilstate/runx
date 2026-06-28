// Test oracle: asserting via expect_err is the intended failure mode for the
// conflict branches under test, so the workspace expect ban is lifted here.
#![allow(clippy::expect_used)]

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

use runx_contracts::EffectFinalityPhase;
use runx_contracts::{JsonObject, JsonValue, Receipt};
use runx_pay::effect_state::{
    EffectCapabilityConsumption, EffectFinalityEventRecord, EffectFinalityIntent,
    EffectFinalityIntentStatus, EffectFinalityRecord, EffectIdempotencyEntry, EffectIdempotencyKey,
    EffectMutation, EffectMutationStatus, EffectPeriodSpendReservation, EffectRecoveryState,
    EffectRunSpendReservation, EffectStateStore, EffectStepStateInput, FileBackedEffectStateStore,
    RUNX_EFFECT_STATE_PATH_ENV, RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV,
    consumed_spend_capability_recorded, escalate_effect_mutation, lookup_effect_idempotency_entry,
    lookup_effect_mutation, period_window_start, persist_effect_step_state,
    record_effect_finality_intent, record_effect_finality_intent_in_store,
};
use runx_pay::supervisor::{PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID, PaymentSupervisorProof};
use runx_pay::{INFERENCE_EFFECT_FAMILY, PAYMENT_EFFECT_FAMILY};
use runx_runtime::RUNX_RECEIPT_DIR_ENV;
use runx_runtime::receipts::step_receipt;
use runx_runtime::{InvocationStatus, SkillOutput};
use serde_json::json;

const MESSAGE_EFFECT_FAMILY: &str = "message";

#[test]
fn hosted_effect_state_backend_fails_closed_before_file_fallback()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let state_path = temp.path().join("effect-state.json");
    let env = BTreeMap::from([
        (
            RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
            state_path.display().to_string(),
        ),
        (
            RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV.to_owned(),
            json!({
                "kind": "hosted_transactional",
                "tenant_id": "tenant_123",
                "store_ref": "runx:hosted-effect-state"
            })
            .to_string(),
        ),
    ]);
    let input = payment_step_input();

    let error = record_effect_finality_intent(&env, temp.path(), &input)
        .expect_err("hosted backend descriptor must not fall back to local file state");

    assert!(
        error
            .to_string()
            .contains("complete hosted effect-state transport"),
        "{error}"
    );
    assert!(
        !state_path.exists(),
        "unsupported hosted backend must fail before opening local state"
    );
    Ok(())
}

#[test]
fn hosted_effect_state_transport_records_without_local_file_fallback()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let state_path = temp.path().join("effect-state.json");
    let transport = HostedEffectStateFixture::start()?;
    let env = BTreeMap::from([
        (
            RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
            state_path.display().to_string(),
        ),
        (
            RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV.to_owned(),
            json!({
                "kind": "hosted_transactional",
                "tenant_id": "tenant_123",
                "store_ref": "runx:hosted-effect-state",
                "endpoint_url": transport.endpoint,
                "bearer_token": transport.token,
                "allowed_families": ["payment"]
            })
            .to_string(),
        ),
    ]);
    let idempotency_key = EffectIdempotencyKey::new("mock", "merchant:paid-echo", "hosted-001");
    let input = EffectStepStateInput {
        idempotency_key: idempotency_key.clone(),
        act_id: "act_pay".to_owned(),
        ..payment_step_input()
    };

    record_effect_finality_intent(&env, temp.path(), &input)?;
    let recorded = lookup_effect_idempotency_entry(
        &env,
        temp.path(),
        PAYMENT_EFFECT_FAMILY,
        &idempotency_key,
    )?;

    assert!(
        recorded.is_none(),
        "recording a finality intent must not fabricate idempotency output"
    );
    assert!(
        transport
            .state
            .lock()
            .expect("state lock")
            .contains("finality_intents"),
        "hosted transport should hold the persisted family state"
    );
    assert!(
        !state_path.exists(),
        "hosted effect state must not fall back to local file persistence"
    );
    Ok(())
}

#[test]
fn records_finality_intent_before_rail_mutation() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let env = BTreeMap::from([(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        temp.path().join("effect-state.json").display().to_string(),
    )]);
    let idempotency_key = EffectIdempotencyKey::new("mock", "merchant:paid-echo", "money-move-001");
    let input = EffectStepStateInput {
        idempotency_key: idempotency_key.clone(),
        act_id: "act_pay".to_owned(),
        ..payment_step_input()
    };

    record_effect_finality_intent(&env, temp.path(), &input)?;
    // Admission retries are safe: the same intent is idempotent, not a second
    // mutation and not a conflict.
    record_effect_finality_intent(&env, temp.path(), &input)?;

    let store = FileBackedEffectStateStore::open(temp.path().join("effect-state.json"))?;
    assert_eq!(
        store.lookup_finality_intent(PAYMENT_EFFECT_FAMILY, &idempotency_key),
        Some(&EffectFinalityIntent {
            idempotency_key,
            rail: "mock".to_owned(),
            amount_minor: 125,
            currency: "USD".to_owned(),
            counterparty: "merchant:paid-echo".to_owned(),
            spend_capability_ref: "runx:payment-capability:paid-echo-spend-1".to_owned(),
            act_id: "act_pay".to_owned(),
            status: EffectFinalityIntentStatus::Open,
        })
    );
    Ok(())
}

#[test]
fn file_store_supports_the_effect_state_store_seam() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("effect-state.json");
    let idempotency_key = EffectIdempotencyKey::new("mock", "merchant:paid-echo", "seam-001");
    let input = EffectStepStateInput {
        idempotency_key: idempotency_key.clone(),
        act_id: "act_pay".to_owned(),
        ..payment_step_input()
    };

    let mut store = FileBackedEffectStateStore::open(&path)?;
    record_effect_finality_intent_in_store(&mut store, &input)?;

    let reopened = FileBackedEffectStateStore::open(path)?;
    assert_eq!(
        reopened
            .lookup_finality_intent(PAYMENT_EFFECT_FAMILY, &idempotency_key)
            .map(|intent| intent.act_id.as_str()),
        Some("act_pay")
    );

    Ok(())
}

#[test]
fn reserves_run_spend_and_refuses_over_aggregate_cap() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let state_path = temp.path().join("effect-state.json");
    let env = BTreeMap::from([(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        state_path.display().to_string(),
    )]);

    let first = run_spend_input("payment:run-cap-001", 125, 250);
    let second = run_spend_input("payment:run-cap-002", 125, 250);
    let third = run_spend_input("payment:run-cap-003", 1, 250);

    record_effect_finality_intent(&env, temp.path(), &first)?;
    record_effect_finality_intent(&env, temp.path(), &second)?;
    let error = record_effect_finality_intent(&env, temp.path(), &third)
        .expect_err("third under-call act must be refused at aggregate run cap");

    assert!(
        error.to_string().contains("would exceed max_per_run_units"),
        "unexpected error: {error}"
    );
    let state = std::fs::read_to_string(state_path)?;
    assert!(state.contains("\"reserved_minor\": 250"));
    assert!(!state.contains("payment:run-cap-003"));

    Ok(())
}

#[test]
fn run_spend_reservation_is_idempotent_for_same_key() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let state_path = temp.path().join("effect-state.json");
    let env = BTreeMap::from([(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        state_path.display().to_string(),
    )]);
    let input = run_spend_input("payment:run-cap-replay", 125, 125);

    record_effect_finality_intent(&env, temp.path(), &input)?;
    record_effect_finality_intent(&env, temp.path(), &input)?;

    let state = std::fs::read_to_string(state_path)?;
    assert!(state.contains("\"reserved_minor\": 125"));

    Ok(())
}

#[test]
fn reserves_period_spend_across_runs_and_refuses_over_period_cap()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let state_path = temp.path().join("effect-state.json");
    let env = BTreeMap::from([(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        state_path.display().to_string(),
    )]);

    // Each call opens a fresh store from disk and the period ledger key has no
    // run component, so these three reservations model three separate runs
    // landing in the same calendar window.
    let first = period_spend_input("payment:period-cap-001", 125, 250, "2026-06-10");
    let second = period_spend_input("payment:period-cap-002", 125, 250, "2026-06-10");
    let third = period_spend_input("payment:period-cap-003", 1, 250, "2026-06-10");

    record_effect_finality_intent(&env, temp.path(), &first)?;
    record_effect_finality_intent(&env, temp.path(), &second)?;
    let error = record_effect_finality_intent(&env, temp.path(), &third)
        .expect_err("third spend must be refused at the period cap");

    assert!(
        error
            .to_string()
            .contains("would exceed max_per_period_units"),
        "unexpected error: {error}"
    );
    let state = std::fs::read_to_string(&state_path)?;
    assert!(!state.contains("payment:period-cap-003"));

    Ok(())
}

#[test]
fn period_spend_new_window_resets_budget() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let state_path = temp.path().join("effect-state.json");
    let env = BTreeMap::from([(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        state_path.display().to_string(),
    )]);

    let exhausts_today = period_spend_input("payment:period-win-001", 250, 250, "2026-06-10");
    let tomorrow = period_spend_input("payment:period-win-002", 250, 250, "2026-06-11");

    record_effect_finality_intent(&env, temp.path(), &exhausts_today)?;
    record_effect_finality_intent(&env, temp.path(), &tomorrow)?;

    let state = std::fs::read_to_string(&state_path)?;
    assert!(state.contains("2026-06-10"));
    assert!(state.contains("2026-06-11"));

    Ok(())
}

#[test]
fn period_spend_reservation_is_idempotent_for_same_key() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let state_path = temp.path().join("effect-state.json");
    let env = BTreeMap::from([(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        state_path.display().to_string(),
    )]);
    let input = period_spend_input("payment:period-replay", 125, 125, "2026-06-10");

    record_effect_finality_intent(&env, temp.path(), &input)?;
    record_effect_finality_intent(&env, temp.path(), &input)?;

    let state = std::fs::read_to_string(&state_path)?;
    assert!(state.contains("\"reserved_minor\": 125"));

    Ok(())
}

#[test]
fn period_spend_prunes_old_windows_without_losing_replay_idempotency()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let state_path = temp.path().join("effect-state.json");
    let env = BTreeMap::from([(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        state_path.display().to_string(),
    )]);

    let first = period_spend_input("payment:period-prune-001", 100, 500, "2026-06-08");
    let second = period_spend_input("payment:period-prune-002", 100, 500, "2026-06-09");
    let third = period_spend_input("payment:period-prune-003", 100, 500, "2026-06-10");

    record_effect_finality_intent(&env, temp.path(), &first)?;
    let outputs = sealed_payment_outputs("proof:period-prune-001", first.amount_minor)?;
    let receipt = receipt_for_outputs("period_prune", "fulfill", &outputs)?;
    let proof = supervisor_proof_for_receipt(&first, "proof:period-prune-001", &receipt);
    persist_effect_step_state(&env, temp.path(), &first, &outputs, &receipt, Some(&proof))?;
    record_effect_finality_intent(&env, temp.path(), &second)?;
    record_effect_finality_intent(&env, temp.path(), &third)?;

    let state = std::fs::read_to_string(&state_path)?;
    assert!(
        !state.contains("\"window_start\": \"2026-06-08\""),
        "oldest period ledger window should be pruned"
    );
    assert!(state.contains("\"window_start\": \"2026-06-09\""));
    assert!(state.contains("\"window_start\": \"2026-06-10\""));
    assert!(
        lookup_effect_idempotency_entry(
            &env,
            temp.path(),
            PAYMENT_EFFECT_FAMILY,
            &first.idempotency_key
        )?
        .is_some(),
        "sealed replay idempotency must survive period ledger pruning"
    );

    Ok(())
}

#[test]
fn period_spend_pruning_preserves_out_of_order_active_window()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let state_path = temp.path().join("effect-state.json");
    let env = BTreeMap::from([(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        state_path.display().to_string(),
    )]);

    let newer = period_spend_input("payment:period-ooo-010", 100, 500, "2026-06-10");
    let newest = period_spend_input("payment:period-ooo-011", 100, 500, "2026-06-11");
    let active_late = period_spend_input("payment:period-ooo-009", 100, 500, "2026-06-09");
    let over_cap = period_spend_input("payment:period-ooo-over", 401, 500, "2026-06-09");

    record_effect_finality_intent(&env, temp.path(), &newer)?;
    record_effect_finality_intent(&env, temp.path(), &newest)?;
    record_effect_finality_intent(&env, temp.path(), &active_late)?;
    let error = record_effect_finality_intent(&env, temp.path(), &over_cap)
        .expect_err("out-of-order active reservation must still count toward the period cap");

    let state = std::fs::read_to_string(&state_path)?;
    assert!(
        state.contains("\"window_start\": \"2026-06-09\""),
        "out-of-order active reservation window must not be pruned"
    );
    assert!(state.contains("\"window_start\": \"2026-06-10\""));
    assert!(state.contains("\"window_start\": \"2026-06-11\""));
    assert!(
        error
            .to_string()
            .contains("would exceed max_per_period_units"),
        "unexpected error: {error}"
    );

    Ok(())
}

#[test]
fn period_window_start_computes_calendar_windows() -> Result<(), Box<dyn std::error::Error>> {
    // 2026-06-10T15:30:00Z, a Wednesday.
    let now = 1_781_105_400;
    assert_eq!(period_window_start("daily", now)?, "2026-06-10");
    assert_eq!(period_window_start("weekly", now)?, "2026-06-08");
    assert_eq!(period_window_start("monthly", now)?, "2026-06-01");
    let error =
        period_window_start("fortnightly", now).expect_err("unrecognized periods must fail closed");
    assert!(error.to_string().contains("not supported"));
    Ok(())
}

#[test]
fn inference_family_uses_generic_run_and_period_accounting()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let state_path = temp.path().join("effect-state.json");
    let env = BTreeMap::from([(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        state_path.display().to_string(),
    )]);

    let inference_first =
        inference_run_and_period_input("inference:claude-001", 300, 500, 700, "2026-06-10");
    let inference_second =
        inference_run_and_period_input("inference:claude-002", 200, 500, 700, "2026-06-10");
    let inference_over_run =
        inference_run_and_period_input("inference:claude-003", 1, 500, 700, "2026-06-10");
    let payment_same_window = period_spend_input("payment:same-window", 250, 250, "2026-06-10");

    record_effect_finality_intent(&env, temp.path(), &inference_first)?;
    record_effect_finality_intent(&env, temp.path(), &inference_second)?;
    record_effect_finality_intent(&env, temp.path(), &payment_same_window)?;
    let error = record_effect_finality_intent(&env, temp.path(), &inference_over_run)
        .expect_err("inference token budget should be denied at the run cap");

    assert!(
        error.to_string().contains("would exceed max_per_run_units"),
        "unexpected error: {error}"
    );
    let state = std::fs::read_to_string(&state_path)?;
    assert!(state.contains("\"inference\""));
    assert!(state.contains("\"payment\""));
    assert!(state.contains("\"currency\": \"tokens\""));
    assert!(state.contains("\"reserved_minor\": 500"));
    assert!(!state.contains("inference:claude-003"));

    Ok(())
}

#[test]
fn state_files_written_before_period_ledger_still_load() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let state_path = temp.path().join("effect-state.json");
    std::fs::write(
        &state_path,
        serde_json::to_string_pretty(&json!({
            "schema_version": "runx.effect_state.v1",
            "families": {
                "payment": {
                    "finality_intents": {},
                    "finality_records": {},
                    "finality_events": {},
                    "run_spend_ledger": {},
                    "idempotency_entries": {},
                    "consumed_spend_capabilities": {},
                    "rail_mutations": {}
                }
            }
        }))?,
    )?;

    let env = BTreeMap::from([(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        state_path.display().to_string(),
    )]);
    let input = period_spend_input("payment:period-legacy", 100, 250, "2026-06-10");
    record_effect_finality_intent(&env, temp.path(), &input)?;

    Ok(())
}

#[test]
fn finality_records_update_depth_and_reject_immutable_conflicts()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("effect-state.json");
    let mut store = FileBackedEffectStateStore::open(&path)?;
    let first = finality_record(
        "money-movement-001",
        EffectFinalityPhase::InFlight,
        Some(1),
        "receipt:settlement:depth-1",
    );
    let sealed = finality_record(
        "money-movement-001",
        EffectFinalityPhase::Sealed,
        Some(3),
        "receipt:settlement:sealed",
    );

    store.record_finality_record(PAYMENT_EFFECT_FAMILY, first)?;
    store.record_finality_record(PAYMENT_EFFECT_FAMILY, sealed.clone())?;
    assert_eq!(
        store
            .lookup_finality_record(PAYMENT_EFFECT_FAMILY, "money-movement-001")
            .map(|record| (&record.phase, record.confirmation_depth)),
        Some((&EffectFinalityPhase::Sealed, Some(3)))
    );

    let mut conflict = sealed;
    conflict.rail = "stripe-spt".to_owned();
    let error = store
        .record_finality_record(PAYMENT_EFFECT_FAMILY, conflict)
        .expect_err("same money movement on a different rail must conflict");
    assert!(
        error
            .to_string()
            .contains("conflicts with existing finality state")
    );

    Ok(())
}

#[test]
fn finality_events_are_idempotent_and_conflict_on_drift() -> Result<(), Box<dyn std::error::Error>>
{
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("effect-state.json");
    let mut store = FileBackedEffectStateStore::open(&path)?;
    let event = EffectFinalityEventRecord {
        provider_event_id: "evt_depth_1".to_owned(),
        rail: "mpp-tempo".to_owned(),
        event_kind: "confirmation_depth".to_owned(),
        received_at: "2026-06-01T00:00:10Z".to_owned(),
        signature_digest: "sha256:event-depth-1".to_owned(),
        money_movement_id: "money-movement-001".to_owned(),
        result_phase: EffectFinalityPhase::InFlight,
    };

    store.record_finality_event(PAYMENT_EFFECT_FAMILY, event.clone())?;
    store.record_finality_event(PAYMENT_EFFECT_FAMILY, event.clone())?;
    let mut drifted = event;
    drifted.result_phase = EffectFinalityPhase::Reversed;
    let error = store
        .record_finality_event(PAYMENT_EFFECT_FAMILY, drifted)
        .expect_err("same provider event id cannot change result");
    assert!(
        error
            .to_string()
            .contains("conflicts with existing event state")
    );

    Ok(())
}

#[test]
fn persists_effect_state_across_fresh_store() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("effect-state.json");
    let idempotency_key =
        EffectIdempotencyKey::new("mock", "merchant:paid-echo", "payment:paid-echo-001");

    {
        let mut store = FileBackedEffectStateStore::open(&path)?;
        store.record_idempotency(
            PAYMENT_EFFECT_FAMILY,
            EffectIdempotencyEntry {
                idempotency_key: idempotency_key.clone(),
                receipt_ref: "receipt:paid-echo:first".to_owned(),
                receipt_created_at: "2026-05-18T00:00:00Z".to_owned(),
                receipt_digest: "sha256:receipt-paid-echo-first".to_owned(),
                rail_proof_ref: "receipt-proof:mock:paid-echo-001".to_owned(),
                supervisor_proof: supervisor_proof_for_fields(
                    "receipt-proof:mock:paid-echo-001",
                    "receipt:paid-echo:first",
                    "sha256:receipt-paid-echo-first",
                ),
                amount_minor: 125,
                currency: "USD".to_owned(),
                outputs: JsonObject::new(),
            },
        )?;
        store.record_mutation(
            PAYMENT_EFFECT_FAMILY,
            EffectMutation {
                idempotency_key: idempotency_key.clone(),
                rail: "mock".to_owned(),
                amount_minor: 125,
                currency: "USD".to_owned(),
                counterparty: "merchant:paid-echo".to_owned(),
                status: EffectMutationStatus::Fulfilled,
                proof_ref: Some("receipt-proof:mock:paid-echo-001".to_owned()),
                recovery_state: EffectRecoveryState::Sealed,
            },
        )?;
    }

    let store = FileBackedEffectStateStore::open(&path)?;
    let entry = store
        .lookup_idempotency(PAYMENT_EFFECT_FAMILY, &idempotency_key)
        .ok_or("idempotency entry should survive fresh store open")?;
    assert_eq!(entry.receipt_ref, "receipt:paid-echo:first");
    assert_eq!(entry.rail_proof_ref, "receipt-proof:mock:paid-echo-001");

    let mutation = store
        .lookup_mutation(PAYMENT_EFFECT_FAMILY, &idempotency_key)
        .ok_or("rail mutation should survive fresh store open")?;
    assert_eq!(mutation.status, EffectMutationStatus::Fulfilled);
    assert_eq!(mutation.recovery_state, EffectRecoveryState::Sealed);

    Ok(())
}

#[test]
fn effect_state_namespaces_idempotency_by_family() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("effect-state.json");
    let idempotency_key =
        EffectIdempotencyKey::new("mock", "merchant:paid-echo", "payment:paid-echo-001");
    let mut store = FileBackedEffectStateStore::open(&path)?;

    store.record_idempotency(
        PAYMENT_EFFECT_FAMILY,
        EffectIdempotencyEntry {
            idempotency_key: idempotency_key.clone(),
            receipt_ref: "receipt:payment".to_owned(),
            receipt_created_at: "2026-05-18T00:00:00Z".to_owned(),
            receipt_digest: "sha256:receipt-payment".to_owned(),
            rail_proof_ref: "proof:payment".to_owned(),
            supervisor_proof: supervisor_proof_for_fields(
                "proof:payment",
                "receipt:payment",
                "sha256:receipt-payment",
            ),
            amount_minor: 125,
            currency: "USD".to_owned(),
            outputs: JsonObject::new(),
        },
    )?;
    store.record_idempotency(
        MESSAGE_EFFECT_FAMILY,
        EffectIdempotencyEntry {
            idempotency_key: idempotency_key.clone(),
            receipt_ref: "receipt:message".to_owned(),
            receipt_created_at: "2026-05-18T00:00:00Z".to_owned(),
            receipt_digest: "sha256:receipt-message".to_owned(),
            rail_proof_ref: "proof:message".to_owned(),
            supervisor_proof: supervisor_proof_for_fields(
                "proof:message",
                "receipt:message",
                "sha256:receipt-message",
            ),
            amount_minor: 125,
            currency: "USD".to_owned(),
            outputs: JsonObject::new(),
        },
    )?;

    let store = FileBackedEffectStateStore::open(&path)?;
    assert_eq!(
        store
            .lookup_idempotency(PAYMENT_EFFECT_FAMILY, &idempotency_key)
            .map(|entry| entry.receipt_ref.as_str()),
        Some("receipt:payment")
    );
    assert_eq!(
        store
            .lookup_idempotency(MESSAGE_EFFECT_FAMILY, &idempotency_key)
            .map(|entry| entry.receipt_ref.as_str()),
        Some("receipt:message")
    );

    Ok(())
}

#[test]
fn records_consumed_spend_capability_for_reuse_lookup() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("nested").join("effect-state.json");
    let idempotency_key =
        EffectIdempotencyKey::new("mock", "merchant:paid-echo", "payment:paid-echo-001");
    let capability_ref = "runx:payment-capability:paid-echo-spend-1";

    let mut store = FileBackedEffectStateStore::open(&path)?;
    store.consume_spend_capability(
        PAYMENT_EFFECT_FAMILY,
        EffectCapabilityConsumption {
            capability_ref: capability_ref.to_owned(),
            idempotency_key: idempotency_key.clone(),
            receipt_ref: Some("receipt:paid-echo:first".to_owned()),
            recovery_state: Some(EffectRecoveryState::Sealed),
        },
    )?;

    let store = FileBackedEffectStateStore::open(&path)?;
    let consumed = store
        .lookup_consumed_spend_capability(PAYMENT_EFFECT_FAMILY, capability_ref)
        .ok_or("consumed spend capability should be persisted")?;
    assert_eq!(consumed.idempotency_key, idempotency_key);
    assert_eq!(
        consumed.receipt_ref.as_deref(),
        Some("receipt:paid-echo:first")
    );

    Ok(())
}

#[test]
fn rejects_duplicate_spend_capability_consumption() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("effect-state.json");
    let idempotency_key =
        EffectIdempotencyKey::new("mock", "merchant:paid-echo", "payment:paid-echo-001");
    let capability_ref = "runx:payment-capability:paid-echo-spend-1";
    let consumption = EffectCapabilityConsumption {
        capability_ref: capability_ref.to_owned(),
        idempotency_key,
        receipt_ref: Some("receipt:paid-echo:first".to_owned()),
        recovery_state: Some(EffectRecoveryState::Sealed),
    };

    let mut store = FileBackedEffectStateStore::open(&path)?;
    store.consume_spend_capability(PAYMENT_EFFECT_FAMILY, consumption.clone())?;

    let error = store
        .consume_spend_capability(PAYMENT_EFFECT_FAMILY, consumption)
        .err()
        .ok_or("duplicate spend capability should be rejected")?;
    assert_eq!(
        error.to_string(),
        "spend capability runx:payment-capability:paid-echo-spend-1 was already consumed"
    );

    Ok(())
}

#[test]
fn rejects_duplicate_idempotency_and_rail_mutation_without_overwrite()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("effect-state.json");
    let idempotency_key =
        EffectIdempotencyKey::new("mock", "merchant:paid-echo", "payment:paid-echo-001");
    let mut store = FileBackedEffectStateStore::open(&path)?;

    store.record_idempotency(
        PAYMENT_EFFECT_FAMILY,
        EffectIdempotencyEntry {
            idempotency_key: idempotency_key.clone(),
            receipt_ref: "receipt:first".to_owned(),
            receipt_created_at: "2026-05-18T00:00:00Z".to_owned(),
            receipt_digest: "sha256:receipt-first".to_owned(),
            rail_proof_ref: "proof:first".to_owned(),
            supervisor_proof: supervisor_proof_for_fields(
                "proof:first",
                "receipt:first",
                "sha256:receipt-first",
            ),
            amount_minor: 125,
            currency: "USD".to_owned(),
            outputs: JsonObject::new(),
        },
    )?;
    let idempotency_error = store
        .record_idempotency(
            PAYMENT_EFFECT_FAMILY,
            EffectIdempotencyEntry {
                idempotency_key: idempotency_key.clone(),
                receipt_ref: "receipt:second".to_owned(),
                receipt_created_at: "2026-05-18T00:00:00Z".to_owned(),
                receipt_digest: "sha256:receipt-second".to_owned(),
                rail_proof_ref: "proof:second".to_owned(),
                supervisor_proof: supervisor_proof_for_fields(
                    "proof:second",
                    "receipt:second",
                    "sha256:receipt-second",
                ),
                amount_minor: 250,
                currency: "USD".to_owned(),
                outputs: JsonObject::new(),
            },
        )
        .err()
        .ok_or("duplicate idempotency record should be rejected")?;
    assert_eq!(
        idempotency_error.to_string(),
        "idempotency key mock\u{1f}merchant:paid-echo\u{1f}payment:paid-echo-001 was already recorded"
    );

    let stored = store
        .lookup_idempotency(PAYMENT_EFFECT_FAMILY, &idempotency_key)
        .ok_or("original idempotency entry should remain stored")?;
    assert_eq!(stored.receipt_ref, "receipt:first");

    store.record_mutation(
        PAYMENT_EFFECT_FAMILY,
        EffectMutation {
            idempotency_key: idempotency_key.clone(),
            rail: "mock".to_owned(),
            amount_minor: 125,
            currency: "USD".to_owned(),
            counterparty: "merchant:paid-echo".to_owned(),
            status: EffectMutationStatus::Partial,
            proof_ref: None,
            recovery_state: EffectRecoveryState::InFlight,
        },
    )?;
    let mutation_error = store
        .record_mutation(
            PAYMENT_EFFECT_FAMILY,
            EffectMutation {
                idempotency_key: idempotency_key.clone(),
                rail: "mock".to_owned(),
                amount_minor: 250,
                currency: "USD".to_owned(),
                counterparty: "merchant:paid-echo".to_owned(),
                status: EffectMutationStatus::Fulfilled,
                proof_ref: Some("proof:second".to_owned()),
                recovery_state: EffectRecoveryState::Sealed,
            },
        )
        .err()
        .ok_or("duplicate rail mutation should be rejected")?;
    assert_eq!(
        mutation_error.to_string(),
        "rail mutation for idempotency key mock\u{1f}merchant:paid-echo\u{1f}payment:paid-echo-001 was already recorded"
    );

    let mutation = store
        .lookup_mutation(PAYMENT_EFFECT_FAMILY, &idempotency_key)
        .ok_or("original rail mutation should remain stored")?;
    assert_eq!(mutation.status, EffectMutationStatus::Partial);
    assert_eq!(mutation.recovery_state, EffectRecoveryState::InFlight);

    Ok(())
}

#[test]
fn persists_sealed_payment_step_state_for_replay_and_reuse_lookups()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let graph_dir = temp.path().join("graph");
    std::fs::create_dir(&graph_dir)?;
    let mut env = BTreeMap::new();
    env.insert(RUNX_RECEIPT_DIR_ENV.to_owned(), "receipts".to_owned());
    let input = payment_step_input();

    let outputs = sealed_payment_outputs("receipt-proof:mock:paid-echo-001", 125)?;
    let receipt = receipt_for_outputs("x402-pay-idempotency-replay", "fulfill", &outputs)?;
    let supervisor_proof =
        supervisor_proof_for_receipt(&input, "receipt-proof:mock:paid-echo-001", &receipt);
    persist_effect_step_state(
        &env,
        &graph_dir,
        &input,
        &outputs,
        &receipt,
        Some(&supervisor_proof),
    )?;

    let entry = lookup_effect_idempotency_entry(
        &env,
        &graph_dir,
        PAYMENT_EFFECT_FAMILY,
        &input.idempotency_key,
    )?
    .ok_or("sealed idempotency entry should be available through public lookup")?;
    assert_eq!(entry.receipt_ref, receipt.id);
    assert_eq!(entry.rail_proof_ref, "receipt-proof:mock:paid-echo-001");
    assert_eq!(entry.receipt_created_at, receipt.created_at.as_str());
    assert_eq!(entry.receipt_digest, receipt.digest);
    let entry_text = serde_json::to_string(&entry)?;
    assert!(
        !entry_text.contains("rail_session_material_ref"),
        "replay state must not persist rail session material"
    );
    assert!(consumed_spend_capability_recorded(
        &env,
        &graph_dir,
        PAYMENT_EFFECT_FAMILY,
        &input.spend_capability_ref
    )?);

    let store =
        FileBackedEffectStateStore::open(graph_dir.join("receipts").join("effect-state.json"))?;
    let mutation = store
        .lookup_mutation(PAYMENT_EFFECT_FAMILY, &input.idempotency_key)
        .ok_or("sealed rail mutation should be persisted")?;
    assert_eq!(mutation.status, EffectMutationStatus::Fulfilled);
    assert_eq!(mutation.recovery_state, EffectRecoveryState::Sealed);
    assert_eq!(
        mutation.proof_ref.as_deref(),
        Some("receipt-proof:mock:paid-echo-001")
    );

    Ok(())
}

#[test]
fn effect_step_state_persistence_keeps_first_sealed_record()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let mut env = BTreeMap::new();
    env.insert(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        "effect-state.json".to_owned(),
    );
    let input = payment_step_input();

    let first_outputs = sealed_payment_outputs("receipt-proof:mock:first", 125)?;
    let first_receipt = receipt_for_outputs("first", "fulfill", &first_outputs)?;
    let first_supervisor_proof =
        supervisor_proof_for_receipt(&input, "receipt-proof:mock:first", &first_receipt);
    persist_effect_step_state(
        &env,
        temp.path(),
        &input,
        &first_outputs,
        &first_receipt,
        Some(&first_supervisor_proof),
    )?;
    let second_outputs = sealed_payment_outputs("receipt-proof:mock:second", 250)?;
    let second_receipt = receipt_for_outputs("second", "fulfill", &second_outputs)?;
    let mut second_supervisor_proof =
        supervisor_proof_for_receipt(&input, "receipt-proof:mock:second", &second_receipt);
    second_supervisor_proof.amount_minor = 250;
    persist_effect_step_state(
        &env,
        temp.path(),
        &input,
        &second_outputs,
        &second_receipt,
        Some(&second_supervisor_proof),
    )?;

    let store = FileBackedEffectStateStore::open(temp.path().join("effect-state.json"))?;
    let entry = store
        .lookup_idempotency(PAYMENT_EFFECT_FAMILY, &input.idempotency_key)
        .ok_or("first idempotency entry should remain stored")?;
    assert_eq!(entry.receipt_ref, first_receipt.id);
    assert_eq!(entry.rail_proof_ref, "receipt-proof:mock:first");
    assert_eq!(entry.amount_minor, 125);

    let mutation = store
        .lookup_mutation(PAYMENT_EFFECT_FAMILY, &input.idempotency_key)
        .ok_or("first rail mutation should remain stored")?;
    assert_eq!(mutation.amount_minor, 125);
    assert_eq!(
        mutation.proof_ref.as_deref(),
        Some("receipt-proof:mock:first")
    );

    Ok(())
}

#[test]
fn stale_store_mutation_reloads_locked_state_before_writing()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("effect-state.json");
    let idempotency_key =
        EffectIdempotencyKey::new("mock", "merchant:paid-echo", "payment:paid-echo-001");
    let mut first = FileBackedEffectStateStore::open(&path)?;
    let mut stale_second = FileBackedEffectStateStore::open(&path)?;

    first.record_idempotency(
        PAYMENT_EFFECT_FAMILY,
        EffectIdempotencyEntry {
            idempotency_key: idempotency_key.clone(),
            receipt_ref: "receipt:first".to_owned(),
            receipt_created_at: "2026-05-18T00:00:00Z".to_owned(),
            receipt_digest: "sha256:receipt-first".to_owned(),
            rail_proof_ref: "proof:first".to_owned(),
            supervisor_proof: supervisor_proof_for_fields(
                "proof:first",
                "receipt:first",
                "sha256:receipt-first",
            ),
            amount_minor: 125,
            currency: "USD".to_owned(),
            outputs: JsonObject::new(),
        },
    )?;

    let error = stale_second
        .record_idempotency(
            PAYMENT_EFFECT_FAMILY,
            EffectIdempotencyEntry {
                idempotency_key: idempotency_key.clone(),
                receipt_ref: "receipt:second".to_owned(),
                receipt_created_at: "2026-05-18T00:00:00Z".to_owned(),
                receipt_digest: "sha256:receipt-second".to_owned(),
                rail_proof_ref: "proof:second".to_owned(),
                supervisor_proof: supervisor_proof_for_fields(
                    "proof:second",
                    "receipt:second",
                    "sha256:receipt-second",
                ),
                amount_minor: 250,
                currency: "USD".to_owned(),
                outputs: JsonObject::new(),
            },
        )
        .err()
        .ok_or("stale store must not overwrite locked effect state")?;
    assert_eq!(
        error.to_string(),
        "idempotency key mock\u{1f}merchant:paid-echo\u{1f}payment:paid-echo-001 was already recorded"
    );

    let fresh = FileBackedEffectStateStore::open(&path)?;
    let entry = fresh
        .lookup_idempotency(PAYMENT_EFFECT_FAMILY, &idempotency_key)
        .ok_or("first idempotency entry should remain persisted")?;
    assert_eq!(entry.receipt_ref, "receipt:first");

    Ok(())
}

#[test]
fn persists_partial_rail_mutation_for_recovery_lookup_without_sealed_idempotency()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let mut env = BTreeMap::new();
    env.insert(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        "effect-state.json".to_owned(),
    );
    let input = payment_step_input();

    let outputs = partial_payment_outputs()?;
    let receipt = receipt_for_outputs("partial", "fulfill", &outputs)?;
    persist_effect_step_state(&env, temp.path(), &input, &outputs, &receipt, None)?;

    assert!(
        lookup_effect_idempotency_entry(
            &env,
            temp.path(),
            PAYMENT_EFFECT_FAMILY,
            &input.idempotency_key
        )?
        .is_none(),
        "partial rail mutation without proof must not be exposed as sealed replay"
    );
    assert!(consumed_spend_capability_recorded(
        &env,
        temp.path(),
        PAYMENT_EFFECT_FAMILY,
        &input.spend_capability_ref
    )?);

    let store = FileBackedEffectStateStore::open(temp.path().join("effect-state.json"))?;
    let mutation = store
        .lookup_mutation(PAYMENT_EFFECT_FAMILY, &input.idempotency_key)
        .ok_or("partial rail mutation should be persisted for recovery")?;
    assert_eq!(mutation.status, EffectMutationStatus::Partial);
    assert_eq!(mutation.recovery_state, EffectRecoveryState::InFlight);
    assert_eq!(mutation.proof_ref, None);

    let escalated = escalate_effect_mutation(
        &env,
        temp.path(),
        PAYMENT_EFFECT_FAMILY,
        &input.idempotency_key,
    )?
    .ok_or("partial rail mutation should be escalated by public recovery helper")?;
    assert_eq!(escalated.status, EffectMutationStatus::Escalated);
    assert_eq!(escalated.recovery_state, EffectRecoveryState::Escalated);
    let looked_up = lookup_effect_mutation(
        &env,
        temp.path(),
        PAYMENT_EFFECT_FAMILY,
        &input.idempotency_key,
    )?
    .ok_or("escalated rail mutation should remain queryable")?;
    assert_eq!(looked_up.status, EffectMutationStatus::Escalated);
    assert_eq!(looked_up.recovery_state, EffectRecoveryState::Escalated);

    Ok(())
}

fn payment_step_input() -> EffectStepStateInput {
    EffectStepStateInput {
        family: PAYMENT_EFFECT_FAMILY,
        idempotency_key: EffectIdempotencyKey::new(
            "mock",
            "merchant:paid-echo",
            "payment:paid-echo-001",
        ),
        spend_capability_ref: "runx:payment-capability:paid-echo-spend-1".to_owned(),
        rail: "mock".to_owned(),
        counterparty: "merchant:paid-echo".to_owned(),
        amount_minor: 125,
        currency: "USD".to_owned(),
        act_id: "act_fulfill".to_owned(),
        run_spend: None,
        period_spend: None,
    }
}

struct HostedEffectStateFixture {
    endpoint: String,
    token: String,
    state: Arc<Mutex<String>>,
}

impl HostedEffectStateFixture {
    fn start() -> Result<Self, Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let state = Arc::new(Mutex::new("{}".to_owned()));
        let fixture_state = Arc::clone(&state);
        thread::spawn(move || {
            for stream in listener.incoming().flatten().take(8) {
                handle_hosted_effect_state_fixture_request(stream, &fixture_state);
            }
        });
        Ok(Self {
            endpoint: format!("http://127.0.0.1:{port}/effect-state"),
            token: "fixture-token".to_owned(),
            state,
        })
    }
}

fn handle_hosted_effect_state_fixture_request(mut stream: TcpStream, state: &Arc<Mutex<String>>) {
    let mut buffer = [0_u8; 65536];
    let Ok(read) = stream.read(&mut buffer) else {
        return;
    };
    let request = String::from_utf8_lossy(&buffer[..read]);
    if !request.contains("Authorization: Bearer fixture-token") {
        write_fixture_response(&mut stream, 401, r#"{"state":{},"version":0}"#);
        return;
    }
    if request.starts_with("GET ") {
        let state = state.lock().expect("state lock").clone();
        write_fixture_response(
            &mut stream,
            200,
            &format!(r#"{{"state":{state},"version":1}}"#),
        );
        return;
    }
    if request.starts_with("PUT ") {
        let body = request.split("\r\n\r\n").nth(1).unwrap_or("{}");
        let payload: serde_json::Value = serde_json::from_str(body).unwrap_or_else(|_| json!({}));
        let next_state = payload
            .get("state")
            .cloned()
            .unwrap_or_else(|| json!({}))
            .to_string();
        *state.lock().expect("state lock") = next_state.clone();
        write_fixture_response(
            &mut stream,
            200,
            &format!(r#"{{"state":{next_state},"version":1}}"#),
        );
        return;
    }
    write_fixture_response(&mut stream, 405, r#"{"state":{},"version":0}"#);
}

fn write_fixture_response(stream: &mut TcpStream, status: u16, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

fn inference_step_input() -> EffectStepStateInput {
    EffectStepStateInput {
        family: INFERENCE_EFFECT_FAMILY,
        idempotency_key: EffectIdempotencyKey::new(
            "tokens",
            "model:anthropic:claude-test",
            "inference:claude-001",
        ),
        spend_capability_ref: "runx:inference-capability:claude-test".to_owned(),
        rail: "tokens".to_owned(),
        counterparty: "model:anthropic:claude-test".to_owned(),
        amount_minor: 125,
        currency: "tokens".to_owned(),
        act_id: "act_infer".to_owned(),
        run_spend: None,
        period_spend: None,
    }
}

fn inference_run_and_period_input(
    idempotency_key: &str,
    token_units: u64,
    max_per_run_units: u64,
    max_per_period_units: u64,
    window_start: &str,
) -> EffectStepStateInput {
    EffectStepStateInput {
        idempotency_key: EffectIdempotencyKey::new(
            "tokens",
            "model:anthropic:claude-test",
            idempotency_key,
        ),
        amount_minor: token_units,
        run_spend: Some(EffectRunSpendReservation {
            run_id: "run:inference-demo".to_owned(),
            authority_ref: "runx:inference-grant:claude-test".to_owned(),
            max_per_run_units,
        }),
        period_spend: Some(EffectPeriodSpendReservation {
            authority_ref: "runx:inference-grant:claude-test".to_owned(),
            max_per_period_units,
            period: "daily".to_owned(),
            window_start: window_start.to_owned(),
        }),
        ..inference_step_input()
    }
}

fn period_spend_input(
    idempotency_key: &str,
    amount_minor: u64,
    max_per_period_units: u64,
    window_start: &str,
) -> EffectStepStateInput {
    EffectStepStateInput {
        idempotency_key: EffectIdempotencyKey::new("mock", "merchant:paid-echo", idempotency_key),
        amount_minor,
        period_spend: Some(EffectPeriodSpendReservation {
            authority_ref: "runx:payment-grant:paid-echo".to_owned(),
            max_per_period_units,
            period: "daily".to_owned(),
            window_start: window_start.to_owned(),
        }),
        ..payment_step_input()
    }
}

fn run_spend_input(
    idempotency_key: &str,
    amount_minor: u64,
    max_per_run_units: u64,
) -> EffectStepStateInput {
    EffectStepStateInput {
        idempotency_key: EffectIdempotencyKey::new("mock", "merchant:paid-echo", idempotency_key),
        amount_minor,
        run_spend: Some(EffectRunSpendReservation {
            run_id: "run:demo-cap".to_owned(),
            authority_ref: "runx:payment-grant:paid-echo".to_owned(),
            max_per_run_units,
        }),
        ..payment_step_input()
    }
}

fn finality_record(
    money_movement_id: &str,
    phase: EffectFinalityPhase,
    confirmation_depth: Option<u64>,
    latest_receipt_ref: &str,
) -> EffectFinalityRecord {
    EffectFinalityRecord {
        money_movement_id: money_movement_id.to_owned(),
        rail: "mpp-tempo".to_owned(),
        phase,
        confirmation_depth,
        finality_threshold: Some(3),
        original_receipt_ref: "receipt:payment:original".to_owned(),
        latest_receipt_ref: latest_receipt_ref.to_owned(),
        terminal_reason: None,
        updated_at: "2026-06-01T00:00:10Z".to_owned(),
    }
}

fn supervisor_proof_for_receipt(
    input: &EffectStepStateInput,
    proof_ref: &str,
    receipt: &Receipt,
) -> PaymentSupervisorProof {
    PaymentSupervisorProof {
        verifier_id: PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID.to_owned(),
        proof_ref: proof_ref.to_owned(),
        rail: input.rail.clone(),
        counterparty: input.counterparty.clone(),
        amount_minor: input.amount_minor,
        currency: input.currency.clone(),
        idempotency_key: input.idempotency_key.key.clone(),
        spend_capability_ref: input.spend_capability_ref.clone(),
        act_id: input.act_id.clone(),
        receipt_ref: receipt.id.to_string(),
        receipt_digest: receipt.digest.to_string(),
        evidence_digest: "sha256:test-supervisor-evidence".to_owned(),
    }
}

fn supervisor_proof_for_fields(
    proof_ref: &str,
    receipt_ref: &str,
    receipt_digest: &str,
) -> PaymentSupervisorProof {
    PaymentSupervisorProof {
        verifier_id: PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID.to_owned(),
        proof_ref: proof_ref.to_owned(),
        rail: "mock".to_owned(),
        counterparty: "merchant:paid-echo".to_owned(),
        amount_minor: 125,
        currency: "USD".to_owned(),
        idempotency_key: "payment:paid-echo-001".to_owned(),
        spend_capability_ref: "runx:payment-capability:paid-echo-spend-1".to_owned(),
        act_id: "act_fulfill".to_owned(),
        receipt_ref: receipt_ref.to_owned(),
        receipt_digest: receipt_digest.to_owned(),
        evidence_digest: "sha256:test-supervisor-evidence".to_owned(),
    }
}

fn sealed_payment_outputs(
    proof_ref: &str,
    amount_minor: u64,
) -> Result<JsonObject, serde_json::Error> {
    serde_json::from_value(json!({
        "effect_evidence_packet": {
            "data": {
                "rail_result": {
                    "status": "fulfilled",
                    "rail": "mock",
                    "amount_minor": amount_minor,
                    "currency": "USD",
                    "counterparty": "merchant:paid-echo"
                },
                "rail_proof": {
                    "proof_ref": proof_ref,
                    "idempotency_key": "payment:paid-echo-001",
                    "rail_session_material_ref": "rail-session-material:mock:paid-echo-001"
                },
                "recovery_hint": { "status": "sealed" }
            }
        }
    }))
}

fn partial_payment_outputs() -> Result<JsonObject, serde_json::Error> {
    serde_json::from_value(json!({
        "effect_evidence_packet": {
            "data": {
                "rail_result": {
                    "status": "partial",
                    "rail": "mock",
                    "amount_minor": 125,
                    "currency": "USD",
                    "counterparty": "merchant:paid-echo"
                },
                "recovery_hint": { "status": "partial" }
            }
        }
    }))
}

fn receipt_for_outputs(
    graph_name: &str,
    step_id: &str,
    outputs: &JsonObject,
) -> Result<Receipt, Box<dyn std::error::Error>> {
    let output = SkillOutput {
        status: InvocationStatus::Success,
        stdout: serde_json::to_string(&JsonValue::Object(outputs.clone()))?,
        stderr: String::new(),
        exit_code: Some(0),
        duration_ms: 1,
        metadata: JsonObject::new(),
    };
    Ok(step_receipt(
        graph_name,
        step_id,
        1,
        &output,
        "2026-05-18T00:00:00Z",
    )?)
}

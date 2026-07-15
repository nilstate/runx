// Test oracle: asserting via expect/unwrap is the intended failure mode, so the
// workspace expect/unwrap bans are lifted for this test target.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use runx_contracts::{ClosureDisposition, JsonObject, Receipt, Reference, ReferenceType};
use runx_core::state_machine::StepAdmissionWitness;
use runx_pay::ledger::{
    PaidToolEvidence, PaymentLedgerEvidence, PaymentLedgerEvidencePacket,
    PaymentLedgerProjectedEventPayload, PaymentLedgerProjection, PaymentLedgerProjectionError,
    PaymentLedgerProjectionInput, PaymentRailSettlementEvidence, PaymentRefusalEvidence,
    PaymentReservationEvidence, build_payment_ledger_projection,
    persist_x402_payment_ledger_projection_event, write_payment_ledger_projection_artifact,
};
use runx_pay::supervisor::{
    PAYMENT_RAIL_SUPERVISOR_EVIDENCE_METADATA, PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID,
    PaymentSupervisorProof, PaymentSupervisorSettlementEvidence,
    insert_payment_supervisor_proof_metadata, payment_supervisor_evidence_metadata_value,
    payment_supervisor_evidence_reference,
};
use runx_runtime::receipts::{graph_receipt, step_receipt, step_receipt_with_authority_grant_refs};
use runx_runtime::{InvocationStatus, SkillOutput, StepRun, insert_effect_verification_ref};
use serde_json::Value;

const CREATED_AT: &str = "2026-05-18T00:00:00Z";

#[test]
fn x402_happy_settlement_projection_matches_golden_fixture()
-> Result<(), Box<dyn std::error::Error>> {
    let reserve = step_run(
        "x402-pay-paid-echo",
        "reserve",
        r#"{"payment_reservation_packet":{"data":{"payment_decision":{"decision_id":"decision_paid_echo_reservation","choice":"continue","inputs":{"signal_refs":[],"target_ref":null,"opportunity_refs":[],"selection_ref":null},"proposed_intent":{"purpose":"complete a bounded paid echo","legitimacy":"authorized by selected reservation decision","success_criteria":[],"constraints":[],"derived_from":[]},"selected_act_id":"act_fulfill","selected_harness_ref":null,"justification":{"summary":"reservation selected a bounded paid echo spend act","evidence_refs":[]},"closure":null,"artifact_refs":[]},"reserved_payment_authority":{"parent_authority":{"term_id":"paid-echo-parent","principal_ref":{"type":"principal","uri":"runx:principal:paid-echo-agent"},"resource_ref":{"type":"grant","uri":"runx:payment-grant:paid-echo"},"resource_family":"effect","verbs":["estimate","prepare","commit","verify"],"bounds":{"effect_limits":[{"family":"payment","unit":"USD","max_per_call_units":10000,"max_per_run_units":25000,"channels":["mock"],"peer":"merchant:paid-echo","operation":"paid.echo","authorization_form":"single_use_capability","preflight_required":true,"commitment_required":true,"idempotency_required":true,"recovery_required":true,"receipt_before_success":true,"single_use_capability":true}]},"capabilities":["effect_single_use_capability"],"expires_at":"2026-05-22T00:00:00Z","issued_by_ref":{"type":"grant","uri":"runx:grant:paid-echo-issuer"},"credential_ref":{"type":"credential","uri":"runx:credential:paid-echo-session"}},"child_authority":{"term_id":"paid-echo-child","principal_ref":{"type":"principal","uri":"runx:principal:paid-echo-agent"},"resource_ref":{"type":"grant","uri":"runx:payment-grant:paid-echo"},"resource_family":"effect","verbs":["prepare","commit"],"bounds":{"effect_limits":[{"family":"payment","unit":"USD","max_per_call_units":2500,"max_per_run_units":25000,"channels":["mock"],"peer":"merchant:paid-echo","operation":"paid.echo","authorization_form":"single_use_capability","preflight_required":true,"commitment_required":true,"idempotency_required":true,"recovery_required":true,"receipt_before_success":true,"single_use_capability":true}]},"capabilities":["effect_single_use_capability"],"expires_at":"2026-05-22T00:00:00Z","issued_by_ref":{"type":"grant","uri":"runx:grant:paid-echo-issuer"},"credential_ref":{"type":"credential","uri":"runx:credential:paid-echo-session"}},"reservation_decision":{"decision_id":"decision_paid_echo_reservation","choice":"continue","inputs":{"signal_refs":[],"target_ref":null,"opportunity_refs":[],"selection_ref":null},"proposed_intent":{"purpose":"complete a bounded paid echo","legitimacy":"authorized by selected reservation decision","success_criteria":[],"constraints":[],"derived_from":[]},"selected_act_id":"act_fulfill","selected_harness_ref":null,"justification":{"summary":"reservation selected a bounded paid echo spend act","evidence_refs":[]},"closure":null,"artifact_refs":[]},"child_harness_ref":{"type":"harness","uri":"runx:harness:x402-pay-paid-echo_fulfill"},"spend_capability_binding":{"child_harness_ref":{"type":"harness","uri":"runx:harness:x402-pay-paid-echo_fulfill"},"act_id":"act_fulfill","reservation_decision_id":"decision_paid_echo_reservation","idempotency_key":"payment:paid-echo-001","amount_minor":125,"currency":"USD","counterparty":"merchant:paid-echo","rail":"mock"},"consumed_spend_capability_refs":[],"subset_proof":{"parent_authority_ref":{"type":"grant","uri":"runx:payment-grant:paid-echo"},"comparison_algorithm":"runx.payment-authority-subset.v1","result":"subset","compared_terms":[{"child_term_id":"paid-echo-child","parent_term_id":"paid-echo-parent","relation":"subset"}],"checked_at":"2026-05-22T00:00:00Z"}},"spend_capability_ref":{"type":"credential","uri":"runx:payment-capability:paid-echo-spend-1"},"idempotency":{"key":"payment:paid-echo-001"}}}}"#,
    )?;
    let fulfill = step_run(
        "x402-pay-paid-echo",
        "fulfill",
        r#"{"effect_evidence_packet":{"data":{"rail_result":{"status":"fulfilled","rail":"mock","amount_minor":125,"currency":"USD"},"credential_envelope":{"form":"paid_tool_credential","credential_ref":"credential:mock:paid-echo-001"},"redactions":["rail_session_material"],"recovery_hint":{"status":"sealed"},"rail_proof":{"proof_ref":"receipt-proof:mock:paid-echo-001","idempotency_key":"payment:paid-echo-001","rail_session_material_ref":"rail-session-material:mock:paid-echo-001"}}}}"#,
    )?;
    let echo = step_run(
        "x402-pay-paid-echo",
        "echo",
        r#"{"paid_echo_result":{"message":"hello from paid echo","payment_capability_ref":"credential:mock:paid-echo-001","payment_proof_ref":"receipt-proof:mock:paid-echo-001","input_surface":"sealed_refs_only"}}"#,
    )?;
    let graph = graph(
        "x402-pay-paid-echo_graph",
        &[reserve.clone(), fulfill.clone(), echo.clone()],
    )?;

    let projection = build_payment_ledger_projection(PaymentLedgerProjectionInput {
        graph_receipt: &graph,
        scenario_id: "P1.5",
        evidence: vec![
            PaymentLedgerEvidence {
                receipt: &fulfill.receipt,
                packet: PaymentLedgerEvidencePacket::RailSettlement(Box::new(
                    PaymentRailSettlementEvidence {
                        amount_minor: 125,
                        currency: "USD".to_owned(),
                        rail: "mock".to_owned(),
                        proof_ref: "receipt-proof:mock:paid-echo-001".to_owned(),
                        idempotency_key: "payment:paid-echo-001".to_owned(),
                        supervisor_proof: Some(paid_echo_supervisor_proof(&fulfill.receipt)),
                    },
                )),
            },
            PaymentLedgerEvidence {
                receipt: &echo.receipt,
                packet: PaymentLedgerEvidencePacket::PaidTool(PaidToolEvidence {
                    payment_proof_ref: "receipt-proof:mock:paid-echo-001".to_owned(),
                }),
            },
            PaymentLedgerEvidence {
                receipt: &reserve.receipt,
                packet: PaymentLedgerEvidencePacket::Reservation(paid_echo_reservation(
                    "payment:paid-echo-001",
                    "runx:payment-capability:paid-echo-spend-1",
                    125,
                )),
            },
        ],
    })?;

    assert_golden(
        &serde_json::to_value(projection)?,
        "fixtures/ledger-projections/x402-pay-ledger-happy-settlement.json",
    )?;
    Ok(())
}

#[test]
fn x402_settlement_projection_requires_supervisor_proof() -> Result<(), Box<dyn std::error::Error>>
{
    let reserve = step_run("x402-pay-paid-echo", "reserve", "{}")?;
    let fulfill = step_run(
        "x402-pay-paid-echo",
        "fulfill",
        r#"{"effect_evidence_packet":{"data":{"rail_result":{"status":"fulfilled","rail":"mock","amount_minor":125,"currency":"USD"},"rail_proof":{"proof_ref":"receipt-proof:mock:paid-echo-001","idempotency_key":"payment:paid-echo-001"}}}}"#,
    )?;
    let graph = graph(
        "x402-pay-paid-echo_graph",
        &[reserve.clone(), fulfill.clone()],
    )?;

    let error = build_payment_ledger_projection(PaymentLedgerProjectionInput {
        graph_receipt: &graph,
        scenario_id: "P1.5",
        evidence: vec![
            PaymentLedgerEvidence {
                receipt: &reserve.receipt,
                packet: PaymentLedgerEvidencePacket::Reservation(paid_echo_reservation(
                    "payment:paid-echo-001",
                    "runx:payment-capability:paid-echo-spend-1",
                    125,
                )),
            },
            PaymentLedgerEvidence {
                receipt: &fulfill.receipt,
                packet: PaymentLedgerEvidencePacket::RailSettlement(Box::new(
                    PaymentRailSettlementEvidence {
                        amount_minor: 125,
                        currency: "USD".to_owned(),
                        rail: "mock".to_owned(),
                        proof_ref: "receipt-proof:mock:paid-echo-001".to_owned(),
                        idempotency_key: "payment:paid-echo-001".to_owned(),
                        supervisor_proof: None,
                    },
                )),
            },
        ],
    })
    .err()
    .ok_or("settlement projection without supervisor proof should fail")?;

    assert_eq!(
        error,
        PaymentLedgerProjectionError::MissingSupervisorProof {
            proof_ref: "receipt-proof:mock:paid-echo-001".to_owned()
        }
    );
    Ok(())
}

#[test]
fn x402_settlement_projection_rejects_mismatched_supervisor_proof()
-> Result<(), Box<dyn std::error::Error>> {
    let reserve = step_run("x402-pay-paid-echo", "reserve", "{}")?;
    let fulfill = step_run(
        "x402-pay-paid-echo",
        "fulfill",
        r#"{"effect_evidence_packet":{"data":{"rail_result":{"status":"fulfilled","rail":"mock","amount_minor":125,"currency":"USD"},"rail_proof":{"proof_ref":"receipt-proof:mock:paid-echo-001","idempotency_key":"payment:paid-echo-001"}}}}"#,
    )?;
    let graph = graph(
        "x402-pay-paid-echo_graph",
        &[reserve.clone(), fulfill.clone()],
    )?;
    let mut supervisor_proof = paid_echo_supervisor_proof(&fulfill.receipt);
    supervisor_proof.amount_minor = 250;

    let error = build_payment_ledger_projection(PaymentLedgerProjectionInput {
        graph_receipt: &graph,
        scenario_id: "P1.5",
        evidence: vec![
            PaymentLedgerEvidence {
                receipt: &reserve.receipt,
                packet: PaymentLedgerEvidencePacket::Reservation(paid_echo_reservation(
                    "payment:paid-echo-001",
                    "runx:payment-capability:paid-echo-spend-1",
                    125,
                )),
            },
            PaymentLedgerEvidence {
                receipt: &fulfill.receipt,
                packet: PaymentLedgerEvidencePacket::RailSettlement(Box::new(
                    PaymentRailSettlementEvidence {
                        amount_minor: 125,
                        currency: "USD".to_owned(),
                        rail: "mock".to_owned(),
                        proof_ref: "receipt-proof:mock:paid-echo-001".to_owned(),
                        idempotency_key: "payment:paid-echo-001".to_owned(),
                        supervisor_proof: Some(supervisor_proof),
                    },
                )),
            },
        ],
    })
    .err()
    .ok_or("settlement projection with mismatched supervisor proof should fail")?;

    match error {
        PaymentLedgerProjectionError::SupervisorProofMismatch { message } => {
            assert!(
                message.contains("amount_minor mismatch"),
                "expected amount mismatch, got: {message}"
            );
        }
        other => {
            return Err(
                std::io::Error::other(format!("unexpected projection error: {other}")).into(),
            );
        }
    }
    Ok(())
}

#[test]
fn x402_governed_refusal_projection_matches_golden_fixture()
-> Result<(), Box<dyn std::error::Error>> {
    let reserve = step_run(
        "x402-pay-negative-cap-exceeded",
        "reserve",
        r#"{"payment_reservation_packet":{"data":{"payment_decision":{"decision_id":"decision_paid_echo_cap_exceeded","choice":"continue","inputs":{"signal_refs":[],"target_ref":null,"opportunity_refs":[],"selection_ref":null},"proposed_intent":{"purpose":"attempt a cap-exceeded paid echo reservation","legitimacy":"negative fixture for cap refusal","success_criteria":[],"constraints":[],"derived_from":[]},"selected_act_id":"act_fulfill","selected_harness_ref":null,"justification":{"summary":"reservation intentionally exceeds child cap","evidence_refs":[]},"closure":null,"artifact_refs":[]},"reserved_payment_authority":{"parent_authority":{"term_id":"paid-echo-parent","principal_ref":{"type":"principal","uri":"runx:principal:paid-echo-agent"},"resource_ref":{"type":"grant","uri":"runx:payment-grant:paid-echo"},"resource_family":"effect","verbs":["estimate","prepare","commit","verify"],"bounds":{"effect_limits":[{"family":"payment","unit":"USD","max_per_call_units":10000,"max_per_run_units":25000,"channels":["mock"],"peer":"merchant:paid-echo","operation":"paid.echo","authorization_form":"single_use_capability","preflight_required":true,"commitment_required":true,"idempotency_required":true,"recovery_required":true,"receipt_before_success":true,"single_use_capability":true}]},"capabilities":["effect_single_use_capability"],"expires_at":"2026-05-22T00:00:00Z","issued_by_ref":{"type":"grant","uri":"runx:grant:paid-echo-issuer"},"credential_ref":{"type":"credential","uri":"runx:credential:paid-echo-session"}},"child_authority":{"term_id":"paid-echo-child-cap-exceeded","principal_ref":{"type":"principal","uri":"runx:principal:paid-echo-agent"},"resource_ref":{"type":"grant","uri":"runx:payment-grant:paid-echo"},"resource_family":"effect","verbs":["prepare","commit"],"bounds":{"effect_limits":[{"family":"payment","unit":"USD","max_per_call_units":100,"max_per_run_units":25000,"channels":["mock"],"peer":"merchant:paid-echo","operation":"paid.echo","authorization_form":"single_use_capability","preflight_required":true,"commitment_required":true,"idempotency_required":true,"recovery_required":true,"receipt_before_success":true,"single_use_capability":true}]},"capabilities":["effect_single_use_capability"],"expires_at":"2026-05-22T00:00:00Z","issued_by_ref":{"type":"grant","uri":"runx:grant:paid-echo-issuer"},"credential_ref":{"type":"credential","uri":"runx:credential:paid-echo-session"}},"reservation_decision":{"decision_id":"decision_paid_echo_cap_exceeded","choice":"continue","inputs":{"signal_refs":[],"target_ref":null,"opportunity_refs":[],"selection_ref":null},"proposed_intent":{"purpose":"attempt a cap-exceeded paid echo reservation","legitimacy":"negative fixture for cap refusal","success_criteria":[],"constraints":[],"derived_from":[]},"selected_act_id":"act_fulfill","selected_harness_ref":null,"justification":{"summary":"reservation intentionally exceeds child cap","evidence_refs":[]},"closure":null,"artifact_refs":[]},"child_harness_ref":{"type":"harness","uri":"runx:harness:x402-pay-negative-cap-exceeded_fulfill"},"spend_capability_binding":{"child_harness_ref":{"type":"harness","uri":"runx:harness:x402-pay-negative-cap-exceeded_fulfill"},"act_id":"act_fulfill","reservation_decision_id":"decision_paid_echo_cap_exceeded","idempotency_key":"payment:paid-echo-cap-exceeded-001","amount_minor":125,"currency":"USD","counterparty":"merchant:paid-echo","rail":"mock"},"consumed_spend_capability_refs":[],"subset_proof":{"parent_authority_ref":{"type":"grant","uri":"runx:payment-grant:paid-echo"},"comparison_algorithm":"runx.payment-authority-subset.v1","result":"subset","compared_terms":[{"child_term_id":"paid-echo-child-cap-exceeded","parent_term_id":"paid-echo-parent","relation":"subset"}],"checked_at":"2026-05-22T00:00:00Z"}},"spend_capability_ref":{"type":"credential","uri":"runx:payment-capability:paid-echo-cap-exceeded-spend"},"idempotency":{"key":"payment:paid-echo-cap-exceeded-001"},"payment_refusal_packet":{"scenario_id":"P1.3","status":"refused","reason_code":"cap_exceeded","rail_call_performed":false}}}}"#,
    )?;
    let graph = graph(
        "x402-pay-negative-cap-exceeded_graph",
        std::slice::from_ref(&reserve),
    )?;

    let projection = build_payment_ledger_projection(PaymentLedgerProjectionInput {
        graph_receipt: &graph,
        scenario_id: "P1.3",
        evidence: vec![
            PaymentLedgerEvidence {
                receipt: &reserve.receipt,
                packet: PaymentLedgerEvidencePacket::Reservation(paid_echo_reservation(
                    "payment:paid-echo-cap-exceeded-001",
                    "runx:payment-capability:paid-echo-cap-exceeded-spend",
                    125,
                )),
            },
            PaymentLedgerEvidence {
                receipt: &reserve.receipt,
                packet: PaymentLedgerEvidencePacket::Refusal(PaymentRefusalEvidence {
                    reason_code: "cap_exceeded".to_owned(),
                    refused_stage: "reserve".to_owned(),
                    rail_call_performed: false,
                    ledger_spend_recorded: false,
                }),
            },
        ],
    })?;

    assert_golden(
        &serde_json::to_value(projection)?,
        "fixtures/ledger-projections/x402-pay-ledger-governed-refusal.json",
    )?;
    Ok(())
}

#[test]
fn x402_projection_artifact_writer_persists_under_receipt_dir_and_returns_event_payload()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let projection: PaymentLedgerProjection = serde_json::from_value(golden(
        "fixtures/ledger-projections/x402-pay-ledger-happy-settlement.json",
    )?)?;

    let artifact = write_payment_ledger_projection_artifact(temp.path(), &projection)?;
    let persisted: PaymentLedgerProjection =
        serde_json::from_str(&std::fs::read_to_string(&artifact.path)?)?;

    assert_eq!(persisted, projection);
    // The artifact file stem is the content-addressed receipt id (the part after
    // the `runx:receipt:` prefix on the projection's source receipt ref).
    let receipt_stem = projection
        .source_receipt_id
        .strip_prefix("runx:receipt:")
        .expect("source receipt ref");
    assert_eq!(
        artifact.path,
        temp.path()
            .join("artifacts")
            .join("payment-ledger")
            .join("x402-pay")
            .join(format!("{receipt_stem}.json"))
    );
    assert_eq!(
        artifact.event_payload,
        PaymentLedgerProjectedEventPayload {
            kind: "payment_ledger_projected".to_owned(),
            payment_profile: "x402-pay".to_owned(),
            projection_artifact_id: format!("x402-pay:{}", projection.source_receipt_id),
            projection_artifact_path: artifact.path.to_string_lossy().into_owned(),
            source_receipt_id: projection.source_receipt_id.clone(),
            scenario_id: "P1.5".to_owned(),
            disposition: projection.disposition.clone(),
        }
    );

    let second_write = write_payment_ledger_projection_artifact(temp.path(), &projection)?;
    assert_eq!(second_write.event_payload, artifact.event_payload);
    Ok(())
}

#[test]
fn x402_projection_event_persists_after_sealed_graph_receipt()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let reserve = step_run(
        "x402-pay-paid-echo",
        "reserve",
        r#"{"payment_reservation_packet":{"data":{"reserved_payment_authority":{"child_authority":{"bounds":{"effect_limits":[{"family":"payment","operation":"paid.echo"}]}}},"spend_capability_binding":{"idempotency_key":"payment:paid-echo-001","amount_minor":125,"currency":"USD","counterparty":"merchant:paid-echo","rail":"mock"},"spend_capability_ref":{"type":"credential","uri":"runx:payment-capability:paid-echo-spend-1"}}}}"#,
    )?;
    let mut fulfill = step_run(
        "x402-pay-paid-echo",
        "fulfill",
        r#"{"effect_evidence_packet":{"data":{"rail_result":{"status":"fulfilled","rail":"mock","amount_minor":125,"currency":"USD"},"rail_proof":{"proof_ref":"receipt-proof:mock:paid-echo-001","idempotency_key":"payment:paid-echo-001"},"credential_envelope":{"form":"paid_tool_credential","credential_ref":"credential:mock:paid-echo-001"}}}}"#,
    )?;
    insert_payment_supervisor_proof_metadata(
        &mut fulfill.output.metadata,
        &paid_echo_supervisor_proof(&fulfill.receipt),
    )?;
    let echo = step_run(
        "x402-pay-paid-echo",
        "echo",
        r#"{"paid_echo_result":{"message":"hello from paid echo","payment_capability_ref":"credential:mock:paid-echo-001","payment_proof_ref":"receipt-proof:mock:paid-echo-001","input_surface":"sealed_refs_only"}}"#,
    )?;
    let graph = graph(
        "x402-pay-paid-echo_graph",
        &[reserve.clone(), fulfill.clone(), echo.clone()],
    )?;
    let steps = vec![reserve, fulfill, echo];

    let event = persist_x402_payment_ledger_projection_event(
        temp.path(),
        "gx_x402-pay-paid-echo",
        CREATED_AT,
        &graph,
        &steps,
        "P1.5",
    )?
    .ok_or("missing x402 payment ledger event")?;
    let second = persist_x402_payment_ledger_projection_event(
        temp.path(),
        "gx_x402-pay-paid-echo",
        CREATED_AT,
        &graph,
        &steps,
        "P1.5",
    );

    assert!(event.artifact.path.exists());
    assert_eq!(
        event.ledger_path,
        temp.path()
            .join("ledgers")
            .join("gx_x402-pay-paid-echo.jsonl")
    );
    let lines = std::fs::read_to_string(&event.ledger_path)?
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 1);
    let record: Value = serde_json::from_str(&lines[0])?;
    assert_eq!(record["entry"]["type"], "run_event");
    assert_eq!(record["entry"]["data"]["kind"], "payment_ledger_projected");
    assert_eq!(
        record["entry"]["data"]["detail"]["source_receipt_id"],
        Value::String(format!("runx:receipt:{}", graph.id))
    );
    assert_eq!(record["entry"]["meta"]["run_id"], "gx_x402-pay-paid-echo");
    assert!(second.is_ok(), "second write must be idempotent");
    assert_eq!(
        std::fs::read_to_string(&event.ledger_path)?.lines().count(),
        1
    );
    Ok(())
}

#[test]
fn x402_projection_event_persists_refusal_for_blocked_graph_receipt()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let reserve = step_run(
        "x402-pay-ledger-governed-refusal",
        "reserve",
        r#"{"payment_reservation_packet":{"data":{"reserved_payment_authority":{"child_authority":{"bounds":{"effect_limits":[{"family":"payment","operation":"paid.echo"}]}}},"spend_capability_binding":{"idempotency_key":"payment:paid-echo-cap-exceeded-001","amount_minor":125,"currency":"USD","counterparty":"merchant:paid-echo","rail":"mock"},"spend_capability_ref":{"type":"credential","uri":"runx:payment-capability:paid-echo-cap-exceeded-spend"},"payment_refusal_packet":{"scenario_id":"P1.3","status":"refused","reason_code":"cap_exceeded","rail_call_performed":false,"ledger_spend_recorded":false}}}}"#,
    )?;
    let mut graph = graph(
        "x402-pay-ledger-governed-refusal_graph",
        std::slice::from_ref(&reserve),
    )?;
    graph.seal.disposition = ClosureDisposition::Blocked;
    graph.seal.reason_code = "graph_blocked".into();

    let event = persist_x402_payment_ledger_projection_event(
        temp.path(),
        "gx_x402-pay-ledger-governed-refusal",
        CREATED_AT,
        &graph,
        &[reserve],
        "P1.3",
    )?
    .ok_or("missing x402 refusal payment ledger event")?;

    let projection: Value = serde_json::from_str(&std::fs::read_to_string(&event.artifact.path)?)?;
    assert_eq!(projection["disposition"], "refused");
    assert_eq!(projection["accrual"]["amount_minor"], 0);
    assert_eq!(
        projection["accrual"]["rail_proof_refs"]
            .as_array()
            .map(Vec::len),
        Some(0)
    );
    assert_eq!(projection["refusal"]["reason_code"], "cap_exceeded");
    assert_eq!(projection["refusal"]["ledger_spend_recorded"], false);

    let lines = std::fs::read_to_string(&event.ledger_path)?
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 1);
    let record: Value = serde_json::from_str(&lines[0])?;
    assert_eq!(record["entry"]["data"]["kind"], "payment_ledger_projected");
    assert_eq!(record["entry"]["data"]["detail"]["disposition"], "refused");
    Ok(())
}

fn paid_echo_supervisor_proof(receipt: &Receipt) -> PaymentSupervisorProof {
    PaymentSupervisorProof {
        verifier_id: PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID.to_owned(),
        proof_ref: "receipt-proof:mock:paid-echo-001".to_owned(),
        rail: "mock".to_owned(),
        counterparty: "merchant:paid-echo".to_owned(),
        amount_minor: 125,
        currency: "USD".to_owned(),
        idempotency_key: "payment:paid-echo-001".to_owned(),
        spend_capability_ref: "runx:payment-capability:paid-echo-spend-1".to_owned(),
        act_id: "act_fulfill".to_owned(),
        receipt_ref: receipt.id.to_string(),
        receipt_digest: receipt.digest.to_string(),
        evidence_digest: "sha256:test-supervisor-evidence".to_owned(),
    }
}

fn paid_echo_reservation(
    idempotency_key: &str,
    spend_capability_ref: &str,
    amount_minor: u64,
) -> PaymentReservationEvidence {
    PaymentReservationEvidence {
        amount_minor,
        currency: "USD".to_owned(),
        rail: "mock".to_owned(),
        counterparty: "merchant:paid-echo".to_owned(),
        operation: "paid.echo".to_owned(),
        idempotency_key: idempotency_key.to_owned(),
        spend_capability_ref: spend_capability_ref.to_owned(),
    }
}

fn graph(graph_name: &str, steps: &[StepRun]) -> Result<Receipt, Box<dyn std::error::Error>> {
    let mut steps = steps.to_vec();
    Ok(graph_receipt(
        graph_name,
        &mut steps,
        Vec::new(),
        CREATED_AT,
    )?)
}

fn step_run(
    graph_name: &str,
    step_id: &str,
    stdout: &str,
) -> Result<StepRun, Box<dyn std::error::Error>> {
    let mut output = SkillOutput {
        status: InvocationStatus::Success,
        stdout: stdout.to_owned(),
        stderr: String::new(),
        exit_code: Some(0),
        duration_ms: 1,
        metadata: JsonObject::new(),
    };
    if step_id == "fulfill" {
        let evidence = paid_echo_supervisor_evidence();
        output.metadata.insert(
            PAYMENT_RAIL_SUPERVISOR_EVIDENCE_METADATA.to_owned(),
            payment_supervisor_evidence_metadata_value(&evidence)?,
        );
        insert_effect_verification_ref(
            &mut output.metadata,
            payment_supervisor_evidence_reference(&evidence),
        )?;
    }
    let receipt = if step_id == "fulfill" {
        step_receipt_with_authority_grant_refs(
            graph_name,
            step_id,
            1,
            &output,
            paid_echo_authority_refs(),
            CREATED_AT,
        )?
    } else {
        step_receipt(graph_name, step_id, 1, &output, CREATED_AT)?
    };
    let admission_witness = StepAdmissionWitness::local_runtime(step_id, receipt.id.as_str());
    let outputs = serde_json::from_str::<runx_contracts::JsonValue>(&output.stdout)
        .ok()
        .and_then(|value| match value {
            runx_contracts::JsonValue::Object(object) => Some(object),
            _ => None,
        })
        .unwrap_or_default();
    Ok(StepRun {
        step_id: step_id.to_owned(),
        attempt: 1,
        skill: step_id.to_owned(),
        runner: None,
        fanout_group: None,
        output,
        outputs,
        receipt,
        admission_witness,
    })
}

fn paid_echo_authority_refs() -> Vec<Reference> {
    vec![
        Reference::with_uri(ReferenceType::Grant, "runx:payment-grant:paid-echo"),
        Reference::with_uri(
            ReferenceType::Credential,
            "runx:payment-capability:paid-echo-spend-1",
        ),
    ]
}

fn paid_echo_supervisor_evidence() -> PaymentSupervisorSettlementEvidence {
    PaymentSupervisorSettlementEvidence {
        verifier_id: PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID.to_owned(),
        proof_ref: "receipt-proof:mock:paid-echo-001".to_owned(),
        rail: "mock".to_owned(),
        counterparty: "merchant:paid-echo".to_owned(),
        amount_minor: 125,
        currency: "USD".to_owned(),
        idempotency_key: "payment:paid-echo-001".to_owned(),
        payment_admission_id: None,
        money_movement_id: None,
        kernel_token_digest: None,
        proof_locator: None,
        proof_status: None,
        settlement_status: Some("fulfilled".to_owned()),
        provider_event_ref: Some("provider:event:payment:paid-echo-001".to_owned()),
    }
}

fn golden(path: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let contents = std::fs::read_to_string(root.join(path))?;
    Ok(serde_json::from_str(&contents)?)
}

fn assert_golden(actual: &Value, path: &str) -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var("RUNX_REGEN_FIXTURES").is_ok() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        std::fs::write(
            root.join(path),
            format!("{}\n", serde_json::to_string_pretty(actual)?),
        )?;
        return Ok(());
    }
    assert_eq!(*actual, golden(path)?);
    Ok(())
}

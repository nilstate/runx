use runx_contracts::{JsonObject, ProofKind, ReferenceType};
use runx_pay::supervisor::{
    PAYMENT_RAIL_SUPERVISOR_EVIDENCE_METADATA, PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID,
    PaymentSupervisorSettlementEvidence, payment_supervisor_evidence_metadata_value,
    payment_supervisor_evidence_reference,
};
use runx_runtime::receipts::step_receipt;
use runx_runtime::{InvocationStatus, SkillOutput, insert_effect_verification_ref};

const CREATED_AT: &str = "2026-05-18T00:00:00Z";

#[test]
fn payment_rail_receipts_carry_supervisor_evidence_refs() -> Result<(), Box<dyn std::error::Error>>
{
    let mut metadata = JsonObject::new();
    let evidence = PaymentSupervisorSettlementEvidence {
        verifier_id: PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID.to_owned(),
        proof_ref: "receipt-proof:mock:demo-search-001".to_owned(),
        rail: "mock".to_owned(),
        counterparty: "merchant:demo-search".to_owned(),
        amount_minor: 125,
        currency: "USD".to_owned(),
        idempotency_key: "payment:demo-search-001".to_owned(),
        payment_admission_id: None,
        money_movement_id: None,
        kernel_token_digest: None,
        proof_locator: None,
        proof_status: None,
        settlement_status: Some("fulfilled".to_owned()),
        provider_event_ref: Some("provider:event:demo-search-001".to_owned()),
    };
    metadata.insert(
        PAYMENT_RAIL_SUPERVISOR_EVIDENCE_METADATA.to_owned(),
        payment_supervisor_evidence_metadata_value(&evidence)?,
    );
    insert_effect_verification_ref(
        &mut metadata,
        payment_supervisor_evidence_reference(&evidence),
    )?;
    let output = SkillOutput {
        status: InvocationStatus::Success,
        stdout: r#"{"effect_evidence_packet":{"data":{"rail_result":{"status":"fulfilled","rail":"mock","amount_minor":125,"currency":"USD"},"rail_proof":{"proof_ref":"receipt-proof:mock:demo-search-001","idempotency_key":"payment:demo-search-001"},"credential_envelope":{"form":"paid_tool_credential","credential_ref":"credential:mock:demo-search-001"}}}}"#.to_owned(),
        stderr: String::new(),
        exit_code: Some(0),
        duration_ms: 10,
        metadata,
    };

    let receipt = step_receipt("payment_execute", "fulfill", 1, &output, CREATED_AT)?;
    let act = &receipt.acts[0];

    let verification_refs: Vec<_> = act
        .criterion_bindings
        .iter()
        .flat_map(|criterion| criterion.verification_refs.iter())
        .collect();
    assert!(verification_refs.iter().any(|reference| {
        reference.reference_type == ReferenceType::Verification
            && reference.uri == "receipt-proof:mock:demo-search-001"
            && reference.locator.as_deref() == Some("payment:demo-search-001")
            && reference.proof_kind.as_ref() == Some(&ProofKind::EffectEvidence)
    }));
    Ok(())
}

use runx_contracts::{
    EffectFinalityPhase, EffectFinalityReceipt, EffectFinalityReceiptSchema, JsonObject, JsonValue,
    ProofKind, Reference, ReferenceType,
};

const EFFECT_CONFIRMATION_CHANNEL: &str = "ledger-confirmation";

#[test]
fn effect_finality_deferred_chain_reaches_sealed_at_threshold() {
    let original = Reference::runx(ReferenceType::Receipt, "receipt_effect_original");
    let proof = effect_evidence_reference("effect-proof:depth:111111");

    let provisional = effect_finality_receipt(EffectFinalityReceiptInput {
        id: "effect-finality-provisional",
        created_at: "2026-06-01T00:00:00Z".to_owned(),
        phase: EffectFinalityPhase::Provisional,
        original_receipt_ref: original.clone(),
        criterion_id: "criterion_effect_finality".to_owned(),
        proof_ref: None,
        evidence_refs: Vec::new(),
        norm_refs: Vec::new(),
        confirmation_depth: None,
        payload: finality_payload(EFFECT_CONFIRMATION_CHANNEL, "submitted"),
    });
    let in_flight_1 = effect_finality_receipt(EffectFinalityReceiptInput {
        id: "effect-finality-in-flight-1",
        created_at: "2026-06-01T00:00:10Z".to_owned(),
        phase: EffectFinalityPhase::InFlight,
        original_receipt_ref: original.clone(),
        criterion_id: "criterion_effect_finality".to_owned(),
        proof_ref: Some(proof.clone()),
        evidence_refs: vec![Reference::runx(ReferenceType::Artifact, &provisional.id)],
        norm_refs: Vec::new(),
        confirmation_depth: Some(1),
        payload: finality_payload(EFFECT_CONFIRMATION_CHANNEL, "confirming"),
    });
    let in_flight_2 = effect_finality_receipt(EffectFinalityReceiptInput {
        id: "effect-finality-in-flight-2",
        created_at: "2026-06-01T00:00:20Z".to_owned(),
        phase: EffectFinalityPhase::InFlight,
        original_receipt_ref: original.clone(),
        criterion_id: "criterion_effect_finality".to_owned(),
        proof_ref: Some(proof.clone()),
        evidence_refs: vec![Reference::runx(ReferenceType::Artifact, &in_flight_1.id)],
        norm_refs: Vec::new(),
        confirmation_depth: Some(2),
        payload: finality_payload(EFFECT_CONFIRMATION_CHANNEL, "confirming"),
    });
    let sealed = effect_finality_receipt(EffectFinalityReceiptInput {
        id: "effect-finality-sealed",
        created_at: "2026-06-01T00:00:30Z".to_owned(),
        phase: EffectFinalityPhase::Sealed,
        original_receipt_ref: original.clone(),
        criterion_id: "criterion_effect_finality".to_owned(),
        proof_ref: Some(proof.clone()),
        evidence_refs: vec![Reference::runx(ReferenceType::Artifact, &in_flight_2.id)],
        norm_refs: vec!["acme:norm:reply-before-escalation".into()],
        confirmation_depth: Some(3),
        payload: finality_payload(EFFECT_CONFIRMATION_CHANNEL, "sealed"),
    });

    assert_eq!(provisional.phase, EffectFinalityPhase::Provisional);
    assert_eq!(provisional.confirmation_depth, None);
    assert_eq!(in_flight_1.phase, EffectFinalityPhase::InFlight);
    assert_eq!(in_flight_1.confirmation_depth, Some(1));
    assert_eq!(in_flight_2.phase, EffectFinalityPhase::InFlight);
    assert_eq!(in_flight_2.confirmation_depth, Some(2));
    assert_eq!(sealed.phase, EffectFinalityPhase::Sealed);
    assert_eq!(sealed.confirmation_depth, Some(3));
    assert_eq!(sealed.proof_ref.as_ref(), Some(&proof));
    assert_eq!(proof.proof_kind, Some(ProofKind::EffectEvidence));

    for receipt in [&provisional, &in_flight_1, &in_flight_2, &sealed] {
        assert_eq!(receipt.family.as_ref(), "generic_effect");
        assert_eq!(receipt.original_receipt_ref, original);
    }
    assert_eq!(
        in_flight_1.evidence_refs,
        vec![Reference::runx(ReferenceType::Artifact, &provisional.id)]
    );
    assert_eq!(
        in_flight_2.evidence_refs,
        vec![Reference::runx(ReferenceType::Artifact, &in_flight_1.id)]
    );
    assert_eq!(
        sealed.evidence_refs,
        vec![Reference::runx(ReferenceType::Artifact, &in_flight_2.id)]
    );
    assert!(provisional.norm_refs.is_empty());
    assert_eq!(
        sealed
            .norm_refs
            .iter()
            .map(AsRef::as_ref)
            .collect::<Vec<_>>(),
        vec!["acme:norm:reply-before-escalation"],
    );
    assert_ne!(provisional.id, in_flight_1.id);
    assert_ne!(in_flight_1.id, in_flight_2.id);
    assert_ne!(in_flight_2.id, sealed.id);
}

#[test]
fn effect_finality_observer_event_seals_directly_without_confirmation_depth() {
    let original = Reference::runx(ReferenceType::Receipt, "receipt_effect_observed");
    let mut proof =
        Reference::with_uri(ReferenceType::Verification, "effect-observer:event:sealed");
    proof.proof_kind = Some(ProofKind::EffectEvidence);
    proof.provider = Some("effect-observer".into());

    let sealed = effect_finality_receipt(EffectFinalityReceiptInput {
        id: "effect-finality-observer-sealed",
        created_at: "2026-06-01T00:00:05Z".to_owned(),
        phase: EffectFinalityPhase::Sealed,
        original_receipt_ref: original.clone(),
        criterion_id: "criterion_effect_finality".to_owned(),
        proof_ref: Some(proof.clone()),
        evidence_refs: Vec::new(),
        norm_refs: Vec::new(),
        confirmation_depth: None,
        payload: finality_payload(EFFECT_CONFIRMATION_CHANNEL, "observer_event_sealed"),
    });

    assert_eq!(sealed.phase, EffectFinalityPhase::Sealed);
    assert_eq!(sealed.confirmation_depth, None);
    assert_eq!(sealed.original_receipt_ref, original);
    assert_eq!(sealed.proof_ref.as_ref(), Some(&proof));
}

fn finality_payload(channel: &str, status: &str) -> JsonObject {
    JsonObject::from([
        ("channel".to_owned(), JsonValue::String(channel.to_owned())),
        ("status".to_owned(), JsonValue::String(status.to_owned())),
    ])
}

struct EffectFinalityReceiptInput {
    id: &'static str,
    created_at: String,
    phase: EffectFinalityPhase,
    original_receipt_ref: Reference,
    criterion_id: String,
    proof_ref: Option<Reference>,
    evidence_refs: Vec<Reference>,
    norm_refs: Vec<String>,
    confirmation_depth: Option<u64>,
    payload: JsonObject,
}

fn effect_finality_receipt(input: EffectFinalityReceiptInput) -> EffectFinalityReceipt {
    EffectFinalityReceipt {
        schema: EffectFinalityReceiptSchema::V1,
        id: input.id.into(),
        created_at: input.created_at.into(),
        family: "generic_effect".into(),
        phase: input.phase,
        original_receipt_ref: input.original_receipt_ref,
        criterion_id: input.criterion_id.into(),
        proof_ref: input.proof_ref,
        evidence_refs: input.evidence_refs,
        norm_refs: input.norm_refs.into_iter().map(Into::into).collect(),
        confirmation_depth: input.confirmation_depth,
        payload: input.payload,
    }
}

fn effect_evidence_reference(uri: &str) -> Reference {
    let mut reference = Reference::with_uri(ReferenceType::Verification, uri);
    reference.proof_kind = Some(ProofKind::EffectEvidence);
    reference.provider = Some("effect-observer".into());
    reference
}

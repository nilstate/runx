use std::collections::BTreeMap;

use runx_contracts::{
    AuthorityBounds, AuthorityCapability, AuthorityEffectCredentialForm, AuthorityEffectLimit,
    AuthorityResourceFamily, AuthorityTerm, JsonNumber, JsonObject, JsonValue,
};
use runx_receipts::{canonical_receipt_body_digest, content_addressed_receipt_id};
use runx_runtime::{
    CredentialDelivery, EffectToolRequest, InvocationOutput, LocalReceiptStore,
    RUNX_RECEIPT_DIR_ENV,
};

use super::*;
use crate::planning::refund::refund_plan;

#[test]
fn refund_plan_receipt_proof() {
    let temp = tempfile::tempdir().expect("temporary workspace");
    let receipt_dir = temp.path().join("receipts");
    let store = LocalReceiptStore::new(&receipt_dir);
    let original = payment_receipt("charge", AuthorityVerb::Commit, "charge", 125, None);
    store.write_receipt(&original).expect("original receipt");
    let prior_refund = payment_receipt(
        "prior-refund",
        AuthorityVerb::Reverse,
        REFUND_OPERATION,
        25,
        Some(original.id.as_str()),
    );
    store
        .write_receipt(&prior_refund)
        .expect("prior refund receipt");

    let parent = refund_authority(125);
    let inputs = refund_inputs(original.id.as_str(), &parent, 100);
    let env = BTreeMap::from([(
        RUNX_RECEIPT_DIR_ENV.to_owned(),
        receipt_dir.to_string_lossy().into_owned(),
    )]);
    let credentials = CredentialDelivery::none();
    let request = EffectToolRequest {
        tool_ref: "payment.refund_plan",
        observed_at: "2026-07-20T00:00:00Z",
        inputs: &inputs,
        env: &env,
        skill_directory: temp.path(),
        credential_delivery: &credentials,
        admission: None,
    };

    let first = refund_plan(request).expect("verified refund plan");
    let second = refund_plan(request).expect("stable verified refund plan");
    let first_plan = first
        .as_object()
        .and_then(|output| output.get("refund_plan"))
        .and_then(JsonValue::as_object)
        .expect("refund plan packet");
    let second_plan = second
        .as_object()
        .and_then(|output| output.get("refund_plan"))
        .and_then(JsonValue::as_object)
        .expect("refund plan packet");

    assert_eq!(
        first_plan.get("decision").and_then(JsonValue::as_str),
        Some("ready_for_refund_adapter")
    );
    assert_eq!(
        first_plan
            .get("original_charge")
            .and_then(JsonValue::as_object)
            .and_then(|charge| charge.get("refunded_minor"))
            .and_then(json_u64),
        Some(25_u64)
    );
    assert_eq!(
        first_plan
            .get("idempotency")
            .and_then(JsonValue::as_object)
            .and_then(|value| value.get("key")),
        second_plan
            .get("idempotency")
            .and_then(JsonValue::as_object)
            .and_then(|value| value.get("key"))
    );
    assert!(!inputs.contains_key("original_receipt"));
    assert!(!inputs.contains_key("idempotency_seed"));

    let over_refund = refund_inputs(original.id.as_str(), &parent, 101);
    let blocked = refund_plan(EffectToolRequest {
        inputs: &over_refund,
        ..request
    })
    .expect("over-refund plan");
    assert_eq!(
        blocked
            .as_object()
            .and_then(|output| output.get("refund_plan"))
            .and_then(JsonValue::as_object)
            .and_then(|plan| plan.get("decision"))
            .and_then(JsonValue::as_str),
        Some("blocked")
    );
}

fn payment_receipt(
    step_id: &str,
    verb: AuthorityVerb,
    operation: &str,
    amount_minor: u64,
    original_receipt_ref: Option<&str>,
) -> Receipt {
    let output = InvocationOutput::runtime_success(
        JsonValue::Object(JsonObject::new()),
        1,
        JsonObject::new(),
    );
    let mut receipt = runx_runtime::receipts::step_receipt(
        "refund-proof-test",
        step_id,
        1,
        &output,
        &JsonObject::new(),
        "2026-07-20T00:00:00Z",
    )
    .expect("base receipt");
    receipt.authority.terms = vec![payment_authority(verb, operation, amount_minor)];
    receipt.authority.grant_refs = vec![Reference::with_uri(
        ReferenceType::Grant,
        format!("runx:grant:payment:{step_id}"),
    )];
    let mut references = vec![
        Reference {
            reference_type: ReferenceType::Verification,
            uri: format!("proof:{step_id}").into(),
            provider: Some("mock".into()),
            locator: None,
            label: Some("payment rail supervisor proof".into()),
            observed_at: None,
            proof_kind: Some(ProofKind::EffectEvidence),
        },
        Reference {
            reference_type: ReferenceType::Target,
            uri: format!("{MONEY_MOVEMENT_URI_PREFIX}{step_id}").into(),
            provider: Some("mock".into()),
            locator: None,
            label: Some("verified payment movement".into()),
            observed_at: None,
            proof_kind: Some(ProofKind::EffectFinality),
        },
    ];
    if let Some(original_receipt_ref) = original_receipt_ref {
        references.push(Reference {
            reference_type: ReferenceType::Receipt,
            uri: format!("{RECEIPT_URI_PREFIX}{original_receipt_ref}").into(),
            provider: None,
            locator: None,
            label: Some("original payment receipt".into()),
            observed_at: None,
            proof_kind: Some(ProofKind::EffectFinality),
        });
    }
    receipt.acts[0].criterion_bindings[0].verification_refs = references.clone();
    receipt.seal.criteria[0].verification_refs = references;
    reseal(receipt)
}

fn reseal(mut receipt: Receipt) -> Receipt {
    receipt.id = "pending".into();
    receipt.digest = "sha256:pending".into();
    receipt.signature.value = "sig:pending".into();
    receipt.id = content_addressed_receipt_id(&receipt)
        .expect("content-addressed receipt id")
        .into();
    let digest = canonical_receipt_body_digest(&receipt).expect("receipt body digest");
    receipt.digest = digest.clone().into();
    receipt.signature.value = format!("sig:{digest}").into();
    receipt
}

fn refund_inputs(
    original_receipt_ref: &str,
    parent: &AuthorityTerm,
    amount_minor: u64,
) -> JsonObject {
    JsonObject::from([
        (
            "original_receipt_ref".to_owned(),
            JsonValue::String(original_receipt_ref.to_owned()),
        ),
        (
            "refund_request".to_owned(),
            serde_json::from_value(serde_json::json!({
                "amount_minor": amount_minor,
                "reason": "operator_refund",
                "requested_counterparty": "payer:demo",
            }))
            .expect("refund request"),
        ),
        (
            "settlement_family".to_owned(),
            JsonValue::String("mock".to_owned()),
        ),
        (
            "parent_payment_authority".to_owned(),
            serde_json::from_value(serde_json::to_value(parent).expect("parent value"))
                .expect("parent JSON"),
        ),
    ])
}

fn json_u64(value: &JsonValue) -> Option<u64> {
    match value {
        JsonValue::Number(JsonNumber::U64(value)) => Some(*value),
        JsonValue::Number(JsonNumber::I64(value)) => u64::try_from(*value).ok(),
        _ => None,
    }
}

fn payment_authority(verb: AuthorityVerb, operation: &str, amount_minor: u64) -> AuthorityTerm {
    authority("payment-receipt", verb, operation, amount_minor)
}

fn refund_authority(amount_minor: u64) -> AuthorityTerm {
    authority(
        "refund-parent",
        AuthorityVerb::Reverse,
        REFUND_OPERATION,
        amount_minor,
    )
}

fn authority(
    term_id: &str,
    verb: AuthorityVerb,
    operation: &str,
    amount_minor: u64,
) -> AuthorityTerm {
    AuthorityTerm {
        term_id: term_id.into(),
        principal_ref: Reference::with_uri(ReferenceType::Principal, "runx:principal:operator"),
        resource_ref: Reference::with_uri(ReferenceType::Target, "payer:demo"),
        resource_family: AuthorityResourceFamily::Effect,
        verbs: vec![verb],
        bounds: AuthorityBounds {
            effect_limits: vec![AuthorityEffectLimit {
                family: PAYMENT_FAMILY.into(),
                unit: "USD".into(),
                max_per_call_units: Some(amount_minor),
                max_per_run_units: Some(500),
                max_per_period_units: None,
                period: None,
                channels: vec!["mock".into()],
                realm: Some("test".into()),
                peer: Some("payer:demo".into()),
                operation: Some(operation.into()),
                preflight_ttl_ms: None,
                approval_threshold_units: None,
                authorization_form: Some(AuthorityEffectCredentialForm::SingleUseCapability),
                preflight_required: false,
                commitment_required: false,
                idempotency_required: true,
                recovery_required: true,
                receipt_before_success: true,
                single_use_capability: true,
            }],
            ..AuthorityBounds::default()
        },
        conditions: Vec::new(),
        approvals: Vec::new(),
        capabilities: vec![AuthorityCapability::EffectSingleUseCapability],
        expires_at: None,
        issued_by_ref: Reference::with_uri(ReferenceType::Grant, "runx:grant:payment"),
        credential_ref: None,
    }
}

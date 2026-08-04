use runx_contracts::{JsonObject, JsonValue};

use super::{AttestationInput, build};

fn digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn ready_inputs() -> AttestationInput {
    AttestationInput {
        action: "issued a refund".to_owned(),
        principal: "ops:jordan".to_owned(),
        claim: "refund completed".to_owned(),
        evidence: vec![JsonValue::Object(JsonObject::from([
            (
                "ref".to_owned(),
                JsonValue::String("provider:refund:1".to_owned()),
            ),
            ("digest".to_owned(), JsonValue::String(digest('a'))),
            (
                "proves".to_owned(),
                JsonValue::String("provider recorded refund".to_owned()),
            ),
        ]))],
        scope: None,
    }
}

#[test]
fn prepares_a_digest_bound_attestation_without_claiming_external_verification() {
    let output = build(&ready_inputs()).expect("attestation");
    let attestation = packet(&output);
    assert_eq!(text(attestation, "decision"), "ready_to_seal");
    let proof = attestation
        .get("proof_boundary")
        .and_then(JsonValue::as_object)
        .expect("proof boundary");
    assert_eq!(
        proof.get("external_action_verified"),
        Some(&JsonValue::Bool(false))
    );
    assert!(
        attestation
            .get("attestation_digest")
            .and_then(JsonValue::as_str)
            .is_some_and(|value| value.starts_with("sha256:"))
    );
}

#[test]
fn missing_subject_needs_an_agent() {
    let output = build(&AttestationInput {
        action: String::new(),
        principal: String::new(),
        claim: String::new(),
        evidence: Vec::new(),
        scope: None,
    })
    .expect("attestation");
    assert_eq!(text(packet(&output), "decision"), "needs_agent");
}

#[test]
fn raw_fields_and_duplicate_references_are_refused() {
    let mut inputs = ready_inputs();
    let evidence = inputs.evidence[0].clone();
    let mut raw = evidence.as_object().expect("item").clone();
    raw.insert(
        "raw_value".to_owned(),
        JsonValue::String("secret".to_owned()),
    );
    inputs.evidence = vec![JsonValue::Object(raw), evidence];
    let output = build(&inputs).expect("attestation");
    let attestation = packet(&output);
    assert_eq!(text(attestation, "decision"), "needs_more_evidence");
    let codes = attestation
        .get("gaps")
        .and_then(JsonValue::as_array)
        .expect("gaps")
        .iter()
        .filter_map(|gap| {
            gap.as_object()
                .and_then(|gap| gap.get("code"))
                .and_then(JsonValue::as_str)
        })
        .collect::<Vec<_>>();
    assert!(codes.contains(&"attestation.evidence.raw_fields"));
    assert!(codes.contains(&"attestation.evidence.duplicate"));
}

fn packet(output: &JsonValue) -> &JsonObject {
    output
        .as_object()
        .and_then(|output| output.get("attestation"))
        .and_then(JsonValue::as_object)
        .expect("attestation packet")
}

fn text<'a>(object: &'a JsonObject, field: &str) -> &'a str {
    object
        .get(field)
        .and_then(JsonValue::as_str)
        .expect("text field")
}

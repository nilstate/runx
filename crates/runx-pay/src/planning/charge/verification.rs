use super::super::{
    EffectToolRequest, JsonObject, JsonValue, PaymentPlanningError, admit_opaque, finding, invalid,
    json_bytes, object_value, packet_findings, required_object, sha256_hex,
};

pub(in crate::planning) fn charge_verification_request(
    request: EffectToolRequest<'_>,
) -> Result<JsonValue, PaymentPlanningError> {
    let price_packet = required_object(request.inputs, "charge_price_packet")?;
    let challenge_packet = required_object(request.inputs, "charge_challenge_packet")?;
    let price = required_object(price_packet, "charge_price")?;
    let challenge = required_object(challenge_packet, "charge_challenge")?;
    let credential = required_object(request.inputs, "returned_credential")?;
    let mut findings = packet_findings(price_packet);
    findings.extend(packet_findings(challenge_packet));
    let family = admit_opaque(
        request.inputs.get("settlement_family"),
        "settlement_family",
        64,
        true,
        &mut findings,
    );
    let credential_family = admit_opaque(
        credential.get("family"),
        "returned_credential.family",
        64,
        true,
        &mut findings,
    );
    let credential_ref = admit_opaque(
        credential.get("credential_ref"),
        "returned_credential.credential_ref",
        512,
        true,
        &mut findings,
    );
    let capability_ref = admit_opaque(
        request.inputs.get("verify_capability_ref"),
        "verify_capability_ref",
        512,
        true,
        &mut findings,
    );
    let extras = credential
        .keys()
        .filter(|field| !matches!(field.as_str(), "family" | "credential_ref"))
        .cloned()
        .collect::<Vec<_>>();
    if !extras.is_empty() {
        findings.push(finding(
            "credential.raw_fields",
            format!(
                "returned_credential contains unsupported fields: {}",
                extras.join(", ")
            ),
        ));
    }
    let admitted_families = challenge_packet
        .get("accepted_settlement_families")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    if family.as_deref().is_some_and(|selected| {
        !admitted_families
            .iter()
            .any(|candidate| candidate.as_str() == Some(selected))
    }) {
        findings.push(finding(
            "family.not_admitted",
            "settlement family is not admitted by the challenge",
        ));
    }
    if family != credential_family {
        findings.push(finding(
            "family.mismatch",
            "credential family does not match selected settlement family",
        ));
    }
    if challenge.get("decision").and_then(JsonValue::as_str) != Some("ready") {
        findings.push(finding(
            "challenge.blocked",
            "charge challenge is not ready",
        ));
    }
    let idempotency = required_object(request.inputs, "idempotency")?;
    let core = serde_json::json!({
        "price_id": price.get("price_id").and_then(JsonValue::as_str).unwrap_or_default(),
        "challenge_id": challenge.get("challenge_id").and_then(JsonValue::as_str).unwrap_or_default(),
        "settlement_family": family.clone(),
        "credential_ref": credential_ref.clone(),
        "verify_capability_ref": capability_ref,
        "idempotency": idempotency,
    });
    let request_digest = format!("sha256:{}", sha256_hex(&json_bytes(&core)?));
    let ready = findings.is_empty();
    let mut verification_request = object_value(core)?
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("verification request must be an object"))?;
    verification_request.insert(
        "decision".to_owned(),
        JsonValue::String(
            if ready {
                "ready_for_provider_adapter"
            } else {
                "blocked"
            }
            .to_owned(),
        ),
    );
    verification_request.insert(
        "request_digest".to_owned(),
        JsonValue::String(request_digest),
    );
    let output = JsonValue::Object(JsonObject::from([
        (
            "verification_request".to_owned(),
            JsonValue::Object(verification_request),
        ),
        (
            "credential_binding".to_owned(),
            object_value(serde_json::json!({
                "family": credential_family,
                "credential_ref": credential_ref,
            }))?,
        ),
        (
            "provider_status".to_owned(),
            JsonValue::String("not_called".to_owned()),
        ),
        (
            "receipt_status".to_owned(),
            JsonValue::String("not_sealed".to_owned()),
        ),
        (
            "forwarding_status".to_owned(),
            JsonValue::String("not_forwarded".to_owned()),
        ),
        ("open_questions".to_owned(), JsonValue::Array(findings)),
    ]));
    super::super::validate_typed_output::<super::super::PaymentChargeVerificationRequest>(
        &output,
        "charge verification request",
    )?;
    Ok(output)
}

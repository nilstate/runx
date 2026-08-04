use super::super::{
    EffectToolRequest, JsonObject, JsonValue, PaymentPlanningError, invalid, json_bytes,
    object_value, packet_findings, required_object, sha256_hex,
};

pub(in crate::planning) fn charge_plan(
    request: EffectToolRequest<'_>,
) -> Result<JsonValue, PaymentPlanningError> {
    let price = required_object(request.inputs, "charge_price_packet")?;
    let challenge = required_object(request.inputs, "charge_challenge_packet")?;
    let verification = required_object(request.inputs, "charge_verification_request")?;
    let mut findings = packet_findings(price);
    findings.extend(packet_findings(challenge));
    findings.extend(packet_findings(verification));
    let verification_request = required_object(verification, "verification_request")?;
    let ready = verification_request
        .get("decision")
        .and_then(JsonValue::as_str)
        == Some("ready_for_provider_adapter")
        && findings.is_empty();
    let core = serde_json::json!({
        "charge_price": price.get("charge_price").and_then(JsonValue::as_object),
        "charge_challenge": challenge.get("charge_challenge").and_then(JsonValue::as_object),
        "idempotency": challenge.get("idempotency").and_then(JsonValue::as_object),
        "verification_request": verification_request,
        "credential_binding": verification.get("credential_binding").and_then(JsonValue::as_object),
    });
    let plan_digest = format!("sha256:{}", sha256_hex(&json_bytes(&core)?));
    let mut plan = object_value(core)?
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("charge plan must be an object"))?;
    for (key, value) in [
        (
            "decision",
            if ready {
                "ready_for_provider_verification"
            } else {
                "blocked"
            },
        ),
        ("provider_status", "not_called"),
        ("receipt_status", "not_sealed"),
        ("forwarding_status", "not_forwarded"),
        ("approval_status", "not_requested"),
    ] {
        plan.insert(key.to_owned(), JsonValue::String(value.to_owned()));
    }
    plan.insert(
        "schema".to_owned(),
        JsonValue::String("runx.payment.charge_plan.v1".to_owned()),
    );
    plan.insert(
        "runtime_forwarding_enabled".to_owned(),
        JsonValue::Bool(false),
    );
    plan.insert("findings".to_owned(), JsonValue::Array(findings));
    plan.insert("plan_digest".to_owned(), JsonValue::String(plan_digest));
    plan.insert(
        "next_action".to_owned(),
        JsonValue::String(
            if ready {
                "route through the selected settlement-family verifier; seal its receipt before forwarding"
            } else {
                "resolve the recorded pricing, challenge, or credential gaps"
            }
            .to_owned(),
        ),
    );
    super::super::validate_typed_output::<super::super::PaymentChargePlan>(
        &JsonValue::Object(plan.clone()),
        "charge plan",
    )?;
    Ok(JsonValue::Object(JsonObject::from([(
        "charge_plan".to_owned(),
        JsonValue::Object(plan),
    )])))
}

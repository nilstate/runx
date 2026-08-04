use super::super::{
    EffectToolRequest, JsonObject, JsonValue, PaymentPlanningError, finding, json_bytes,
    object_value, packet_findings, required_object, required_string, sha256_hex,
};

pub(in crate::planning) fn charge_challenge(
    request: EffectToolRequest<'_>,
) -> Result<JsonValue, PaymentPlanningError> {
    let packet = required_object(request.inputs, "charge_price_packet")?;
    let price = required_object(packet, "charge_price")?;
    let authority = required_object(packet, "requested_payment_authority")?;
    let mut findings = packet_findings(packet);
    if price.get("decision").and_then(JsonValue::as_str) != Some("ready") {
        findings.push(finding("price.blocked", "charge price is not ready"));
    }
    let seed = required_string(request.inputs, "idempotency_seed")?;
    let price_id = required_string(price, "price_id")?;
    let challenge_id = format!(
        "charge-challenge:{}",
        sha256_hex(&json_bytes(&serde_json::json!({
            "price_id": price_id,
            "idempotency_seed": seed,
        }))?)
    );
    let families = price
        .get("settlement_families")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    let rail = families.first().and_then(JsonValue::as_str);
    let ready = findings.is_empty();
    Ok(JsonValue::Object(JsonObject::from([
        (
            "effect_required_signal".to_owned(),
            object_value(serde_json::json!({
                "signal_type": "effect_required",
                "challenge_id": challenge_id.clone(),
                "amount_minor": price.get("amount_minor"),
                "currency": price.get("currency"),
                "rail": rail,
                "counterparty": price.get("counterparty"),
                "operation": price.get("operation"),
            }))?,
        ),
        (
            "charge_challenge".to_owned(),
            object_value(serde_json::json!({
                "decision": if ready { "ready" } else { "blocked" },
                "challenge_id": challenge_id,
                "price_id": price_id,
                "required_authority": authority,
                "receipt_before_forward_required": true,
            }))?,
        ),
        (
            "idempotency".to_owned(),
            object_value(serde_json::json!({
                "key": format!("charge:{seed}"),
                "replay_policy": "recover_or_refuse_duplicate",
            }))?,
        ),
        (
            "accepted_settlement_families".to_owned(),
            JsonValue::Array(families),
        ),
        ("open_questions".to_owned(), JsonValue::Array(findings)),
    ])))
}

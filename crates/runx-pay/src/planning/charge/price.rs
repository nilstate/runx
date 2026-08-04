use super::super::{
    EffectToolRequest, JsonObject, JsonValue, PAYMENT_FAMILY, PaymentPlanningError, admit_opaque,
    admit_opaque_array, finding, json_bytes, looks_like_iso_datetime, object_value, optional_u64,
    required_object, sha256_hex,
};

pub(in crate::planning) fn charge_price(
    request: EffectToolRequest<'_>,
) -> Result<JsonValue, PaymentPlanningError> {
    let call = required_object(request.inputs, "mcp_tool_call")?;
    let policy = required_object(request.inputs, "provider_policy")?;
    let mut findings = Vec::new();
    let operation = admit_opaque(
        call.get("tool"),
        "mcp_tool_call.tool",
        256,
        true,
        &mut findings,
    );
    let arguments = call.get("arguments").and_then(JsonValue::as_object);
    if arguments.is_none() {
        findings.push(finding(
            "mcp_tool_call.arguments",
            "mcp_tool_call.arguments must be an object",
        ));
    }
    let amount_minor = match optional_u64(policy, "price_minor")? {
        Some(amount) if amount > 0 => Some(amount),
        _ => {
            findings.push(finding(
                "provider_policy.price_minor",
                "provider_policy.price_minor must be a positive safe integer",
            ));
            None
        }
    };
    let currency = admit_opaque(
        policy.get("currency"),
        "provider_policy.currency",
        3,
        true,
        &mut findings,
    );
    if currency.as_deref().is_some_and(|value| {
        value.len() != 3 || !value.bytes().all(|byte| byte.is_ascii_uppercase())
    }) {
        findings.push(finding(
            "provider_policy.currency",
            "provider_policy.currency must be an uppercase ISO 4217 code",
        ));
    }
    let settlement_families = admit_opaque_array(
        policy.get("accepted_settlement_families"),
        "provider_policy.accepted_settlement_families",
        10,
        64,
        &mut findings,
    );
    if settlement_families.is_empty() {
        findings.push(finding(
            "provider_policy.accepted_settlement_families",
            "at least one settlement family is required",
        ));
    }
    let counterparty = admit_opaque(
        policy.get("counterparty"),
        "provider_policy.counterparty",
        256,
        true,
        &mut findings,
    );
    let realm = admit_opaque(
        policy.get("realm"),
        "provider_policy.realm",
        64,
        false,
        &mut findings,
    )
    .unwrap_or_else(|| "local".to_owned());
    let expires_at = policy
        .get("expires_at")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if expires_at
        .as_deref()
        .is_some_and(|value| !looks_like_iso_datetime(value))
    {
        findings.push(finding(
            "provider_policy.expires_at",
            "provider_policy.expires_at must be an ISO-8601 UTC timestamp",
        ));
    }
    let policy_ref = admit_opaque(
        policy.get("policy_ref"),
        "provider_policy.policy_ref",
        256,
        false,
        &mut findings,
    );
    let price_core = serde_json::json!({
        "operation": operation.clone(),
        "amount_minor": amount_minor,
        "currency": currency.clone(),
        "settlement_families": settlement_families.clone(),
        "counterparty": counterparty.clone(),
        "realm": realm.clone(),
        "expires_at": expires_at.clone(),
    });
    let price_id = format!("charge-price:{}", sha256_hex(&json_bytes(&price_core)?));
    let policy_source = policy_ref.unwrap_or(format!(
        "policy:sha256:{}",
        sha256_hex(&json_bytes(policy)?)
    ));
    let tool_source = format!("tool-call:sha256:{}", sha256_hex(&json_bytes(call)?));
    let arguments_digest = format!(
        "sha256:{}",
        sha256_hex(&json_bytes(&arguments.cloned().unwrap_or_default())?)
    );
    let ready = findings.is_empty();
    let charge_price = object_value(serde_json::json!({
        "decision": if ready { "ready" } else { "blocked" },
        "price_id": price_id,
        "operation": operation.clone(),
        "amount_minor": amount_minor,
        "currency": currency.clone(),
        "settlement_families": settlement_families.clone(),
        "counterparty": counterparty.clone(),
        "realm": realm.clone(),
        "expires_at": expires_at,
    }))?;
    let requested_payment_authority = object_value(serde_json::json!({
        "resource_family": "effect",
        "verbs": ["verify"],
        "bounds": {
            "effect_limits": [{
                "family": PAYMENT_FAMILY,
                "unit": currency.clone(),
                "max_per_call_units": amount_minor,
                "channels": settlement_families,
                "realm": realm.clone(),
                "peer": counterparty,
                "operation": operation,
                "idempotency_required": true,
                "receipt_before_success": true,
            }],
        },
    }))?;
    Ok(JsonValue::Object(JsonObject::from([
        ("charge_price".to_owned(), charge_price),
        (
            "requested_payment_authority".to_owned(),
            requested_payment_authority,
        ),
        (
            "price_evidence".to_owned(),
            object_value(serde_json::json!({
                "source_refs": [policy_source, tool_source],
                "arguments_digest": arguments_digest,
            }))?,
        ),
        (
            "policy_metadata".to_owned(),
            object_value(serde_json::json!({
                "provider_realm": realm,
                "direction": "provider_charge",
            }))?,
        ),
        ("open_questions".to_owned(), JsonValue::Array(findings)),
    ])))
}

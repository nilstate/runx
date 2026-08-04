use super::{
    AuthorityTerm, EffectToolRequest, JsonObject, JsonValue, PaymentInvoiceSettlementPlan,
    PaymentPlanningError, QUOTE_TOOL, finding, invalid, is_opaque_reference, is_sha256, json_bytes,
    object_value, quote, required_object, required_string, required_typed, required_u64,
    sha256_hex, typed_value, validate_typed_output,
};

// Function rationale: invoice planning validates invoice, payee, rail, authority, and canonical spend handoff as one non-mutating decision.
pub(super) fn invoice_plan(
    request: EffectToolRequest<'_>,
) -> Result<JsonValue, PaymentPlanningError> {
    let invoice_ref = required_string(request.inputs, "invoice_ref")?;
    let amount_minor = required_u64(request.inputs, "amount_minor")?;
    if amount_minor == 0 {
        return Err(invalid("amount_minor must be greater than zero"));
    }
    let currency = required_string(request.inputs, "currency")?;
    if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err(invalid("currency must be an uppercase ISO 4217 code"));
    }
    let rail = required_string(request.inputs, "rail")?;
    let rail_profile_ref = required_string(request.inputs, "rail_profile_ref")?;
    let idempotency_seed = required_string(request.inputs, "idempotency_seed")?;
    let parent: AuthorityTerm = required_typed(request.inputs, "parent_payment_authority")?;
    let (payee, mut findings) = admit_invoice_payee(required_object(request.inputs, "payee")?);
    let runner = canonical_spend_runner(rail);
    if runner.is_none() {
        findings.push(finding(
            "rail.unsupported",
            format!("rail {rail:?} has no canonical spend runner"),
        ));
    }

    let payment_signal = object_value(serde_json::json!({
        "signal_type": "invoice",
        "challenge_id": invoice_ref,
        "invoice_ref": invoice_ref,
        "amount_minor": amount_minor,
        "currency": currency,
        "rail": rail,
        "counterparty": payee.get("party_ref").and_then(JsonValue::as_str),
        "operation": "invoice.settle",
        "realm": request.inputs.get("realm").and_then(JsonValue::as_str),
    }))?;
    let mut quote_inputs = JsonObject::from([
        ("payment_signal".to_owned(), payment_signal.clone()),
        ("parent_payment_authority".to_owned(), typed_value(&parent)?),
        (
            "idempotency_seed".to_owned(),
            JsonValue::String(idempotency_seed.to_owned()),
        ),
    ]);
    if let Some(realm) = request.inputs.get("realm") {
        quote_inputs.insert("realm".to_owned(), realm.clone());
    }
    let quote_request = EffectToolRequest {
        tool_ref: QUOTE_TOOL,
        inputs: &quote_inputs,
        ..request
    };
    if let Err(error) = quote(quote_request) {
        findings.push(finding("authority.denied", error.to_string()));
    }

    let ready = findings.is_empty();
    let downstream = if ready {
        let mut inputs = JsonObject::from([
            ("payment_signal".to_owned(), payment_signal.clone()),
            ("parent_payment_authority".to_owned(), typed_value(&parent)?),
            (
                "rail_profile_ref".to_owned(),
                JsonValue::String(rail_profile_ref.to_owned()),
            ),
            (
                "idempotency_seed".to_owned(),
                JsonValue::String(idempotency_seed.to_owned()),
            ),
        ]);
        for field in ["realm", "payment_admission"] {
            if let Some(value) = request.inputs.get(field) {
                inputs.insert(field.to_owned(), value.clone());
            }
        }
        Some(object_value(serde_json::json!({
            "skill": "spend",
            "runner": runner,
            "inputs": inputs,
        }))?)
    } else {
        None
    };
    let digest_input = serde_json::json!({
        "invoice_ref": invoice_ref,
        "amount_minor": amount_minor,
        "currency": currency,
        "payee": payee,
        "rail": rail,
        "rail_profile_ref": rail_profile_ref,
        "parent_term_id": parent.term_id,
        "idempotency_seed": idempotency_seed,
    });
    let plan_digest = format!("sha256:{}", sha256_hex(&json_bytes(&digest_input)?));
    let settlement_plan = object_value(serde_json::json!({
        "schema": "runx.payment.invoice_settlement_plan.v1",
        "decision": if ready { "ready_for_spend" } else { "blocked" },
        "invoice": {
            "invoice_ref": invoice_ref,
            "amount_minor": amount_minor,
            "currency": currency,
        },
        "payee": payee,
        "rail": rail,
        "authority": {
            "parent_term_id": parent.term_id,
            "validation": "native_payment_quote",
        },
        "payment_signal": payment_signal,
        "idempotency_seed": idempotency_seed,
        "downstream": downstream,
        "provider_effect": { "status": "not_started", "money_moved": false },
        "findings": findings,
        "plan_digest": plan_digest,
    }))?;
    validate_typed_output::<PaymentInvoiceSettlementPlan>(
        &settlement_plan,
        "invoice settlement plan",
    )?;
    Ok(JsonValue::Object(JsonObject::from([(
        "settlement_plan".to_owned(),
        settlement_plan,
    )])))
}

fn canonical_spend_runner(rail: &str) -> Option<&'static str> {
    match rail {
        "mock" => Some("mock"),
        "mpp" => Some("mpp"),
        "stripe-spt" => Some("stripe-spt"),
        _ => None,
    }
}

fn admit_invoice_payee(payee: &JsonObject) -> (JsonObject, Vec<JsonValue>) {
    let mut findings = Vec::new();
    reject_extra_payee_fields(payee, &mut findings);
    let mut admitted = JsonObject::new();
    admit_payee_identity(payee, &mut admitted, &mut findings);
    admit_payee_settlement(payee, &mut admitted, &mut findings);
    (admitted, findings)
}

fn reject_extra_payee_fields(payee: &JsonObject, findings: &mut Vec<JsonValue>) {
    let allowed = ["name", "party_ref", "settlement_ref", "settlement_digest"];
    let extras = payee
        .keys()
        .filter(|field| !allowed.contains(&field.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !extras.is_empty() {
        findings.push(finding(
            "payee.raw_fields",
            format!("payee contains unsupported fields: {}", extras.join(", ")),
        ));
    }
}

fn admit_payee_identity(
    payee: &JsonObject,
    admitted: &mut JsonObject,
    findings: &mut Vec<JsonValue>,
) {
    let name = payee
        .get("name")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let party_ref = payee
        .get("party_ref")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| is_opaque_reference(value));
    if name.is_none() {
        findings.push(finding("payee.name", "payee.name is required"));
    }
    if party_ref.is_none() {
        findings.push(finding(
            "payee.party_ref",
            "payee.party_ref must be an opaque non-secret reference",
        ));
    }
    if let Some(value) = name {
        admitted.insert("name".to_owned(), JsonValue::String(value.to_owned()));
    }
    if let Some(value) = party_ref {
        admitted.insert("party_ref".to_owned(), JsonValue::String(value.to_owned()));
    }
}

fn admit_payee_settlement(
    payee: &JsonObject,
    admitted: &mut JsonObject,
    findings: &mut Vec<JsonValue>,
) {
    let settlement_ref = payee
        .get("settlement_ref")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| is_opaque_reference(value));
    let settlement_digest = payee
        .get("settlement_digest")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| is_sha256(value));
    if settlement_ref.is_some() == settlement_digest.is_some() {
        findings.push(finding(
            "payee.settlement",
            "payee requires exactly one opaque settlement_ref or sha256 settlement_digest",
        ));
    }
    if let Some(value) = settlement_ref {
        admitted.insert(
            "settlement_ref".to_owned(),
            JsonValue::String(value.to_owned()),
        );
    }
    if let Some(value) = settlement_digest {
        admitted.insert(
            "settlement_digest".to_owned(),
            JsonValue::String(value.to_owned()),
        );
    }
}

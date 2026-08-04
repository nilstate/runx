// Module rationale: quote and reservation form one attenuation protocol whose shared consistency checks must remain adjacent and auditable.

use super::{
    AttenuationRequest, AuthorityTerm, Decision, DecisionChoice, DecisionInputs,
    DecisionJustification, EffectToolRequest, Intent, IsoDateTime, JsonObject, JsonValue,
    PaymentBoundsComparator, PaymentPlanningError, PaymentQuotePacket, PaymentReservationPacket,
    Reference, ReferenceType, invalid, json_bytes, mint_attenuated, object_value, optional_u64,
    required_array, required_object, required_string, required_typed, required_u64, sha256_hex,
    single_string, typed_value, validate_typed_output,
};

mod authority;

pub(super) use authority::payment_limit;
use authority::{
    consistent_optional_string, consistent_string, requested_authority, select_rail,
    validate_parent, validate_requested_quote,
};

// Function rationale: quote construction binds the provider signal, parent authority, caller ceilings, rail selection, and idempotency into one packet.
pub(super) fn quote(request: EffectToolRequest<'_>) -> Result<JsonValue, PaymentPlanningError> {
    let signal = required_object(request.inputs, "payment_signal")?;
    let parent: AuthorityTerm = required_typed(request.inputs, "parent_payment_authority")?;
    let parent_limit = payment_limit(&parent)?.clone();
    validate_parent(&parent, &parent_limit)?;

    let amount_minor = required_u64(signal, "amount_minor")?;
    if amount_minor == 0 {
        return Err(invalid(
            "payment_signal.amount_minor must be greater than zero",
        ));
    }
    if let Some(caller_cap) = optional_u64(request.inputs, "max_per_call_units")?
        && amount_minor > caller_cap
    {
        return Err(invalid(format!(
            "payment amount {amount_minor} exceeds caller max_per_call_units {caller_cap}"
        )));
    }
    if parent_limit
        .max_per_call_units
        .is_none_or(|cap| amount_minor > cap)
    {
        return Err(invalid(
            "payment amount is outside the parent per-call authority ceiling",
        ));
    }

    let currency = consistent_string(request.inputs, signal, "currency")?;
    if currency != parent_limit.unit.as_str() {
        return Err(invalid(format!(
            "payment currency {currency:?} is outside parent currency {:?}",
            parent_limit.unit.as_str()
        )));
    }
    let counterparty = consistent_string(request.inputs, signal, "counterparty")?;
    if parent_limit.peer.as_deref() != Some(counterparty) {
        return Err(invalid(
            "payment counterparty does not match the bounded parent authority",
        ));
    }
    let operation = consistent_string(request.inputs, signal, "operation")?;
    if parent_limit.operation.as_deref() != Some(operation) {
        return Err(invalid(
            "payment operation does not match the bounded parent authority",
        ));
    }
    let realm = consistent_optional_string(request.inputs, signal, "realm")?;
    if let Some(parent_realm) = parent_limit.realm.as_deref()
        && realm.as_deref() != Some(parent_realm)
    {
        return Err(invalid(
            "payment realm does not match the bounded parent authority",
        ));
    }

    let rail = select_rail(request.inputs, signal, &parent_limit)?;
    let idempotency_seed = required_string(request.inputs, "idempotency_seed")?;
    let requested_authority = requested_authority(
        &parent,
        &parent_limit,
        amount_minor,
        currency,
        rail,
        counterparty,
        operation,
        realm.as_deref(),
        idempotency_seed,
    )?;

    let quote_fingerprint = serde_json::json!({
        "amount_minor": amount_minor,
        "currency": currency,
        "rail": rail,
        "counterparty": counterparty,
        "operation": operation,
        "realm": realm,
        "idempotency_seed": idempotency_seed,
        "parent_term_id": parent.term_id,
    });
    let quote_id = format!("quote-{}", sha256_hex(&json_bytes(&quote_fingerprint)?));
    let signal_digest = sha256_hex(&json_bytes(signal)?);
    let signal_ref = signal
        .get("challenge_id")
        .and_then(JsonValue::as_str)
        .map_or_else(
            || format!("sha256:{signal_digest}"),
            |challenge| format!("signal:{challenge}"),
        );

    let packet = JsonValue::Object(JsonObject::from([
        (
            "payment_quote".to_owned(),
            object_value(serde_json::json!({
                "quote_id": quote_id,
                "amount_minor": amount_minor,
                "currency": currency,
                "rails": [rail],
                "counterparty": counterparty,
                "operation": operation,
                "realm": realm,
                "observed_at": request.observed_at,
            }))?,
        ),
        (
            "requested_payment_authority".to_owned(),
            typed_value(&requested_authority)?,
        ),
        (
            "challenge_evidence".to_owned(),
            object_value(serde_json::json!({
                "source_refs": [signal_ref],
                "signal_digest": format!("sha256:{signal_digest}"),
                "redactions": [],
            }))?,
        ),
        ("risk_notes".to_owned(), JsonValue::Array(Vec::new())),
        ("open_questions".to_owned(), JsonValue::Array(Vec::new())),
    ]));
    validate_typed_output::<PaymentQuotePacket>(&packet, "payment quote")?;
    Ok(packet)
}

// Function rationale: reservation recomputes attenuation and binds the single-use capability, downstream act, and replay posture in one transaction.
pub(super) fn reserve(request: EffectToolRequest<'_>) -> Result<JsonValue, PaymentPlanningError> {
    let quote_packet = required_object(request.inputs, "payment_quote_packet")?;
    let quote = required_object(quote_packet, "payment_quote")?;
    let requested: AuthorityTerm = required_typed(quote_packet, "requested_payment_authority")?;
    let parent: AuthorityTerm = required_typed(request.inputs, "parent_payment_authority")?;
    let target_harness_ref: Reference = required_typed(request.inputs, "target_harness_ref")?;
    let target_act_id = required_string(request.inputs, "target_act_id")?;
    let idempotency_seed = required_string(request.inputs, "idempotency_seed")?;

    let amount_minor = required_u64(quote, "amount_minor")?;
    let currency = required_string(quote, "currency")?;
    let counterparty = required_string(quote, "counterparty")?;
    let operation = required_string(quote, "operation")?;
    let rail = single_string(required_array(quote, "rails")?, "payment_quote.rails")?;
    validate_requested_quote(
        &requested,
        amount_minor,
        currency,
        rail,
        counterparty,
        operation,
    )?;

    let attenuation = AttenuationRequest {
        principal_ref: requested.principal_ref.clone(),
        resource_ref: requested.resource_ref.clone(),
        resource_family: requested.resource_family.clone(),
        verbs: requested.verbs.clone(),
        capabilities: requested.capabilities.clone(),
        bounds: requested.bounds.clone(),
        expires_at: requested.expires_at.clone(),
    };
    let (child_authority, subset_proof) = mint_attenuated(
        &parent,
        &attenuation,
        &PaymentBoundsComparator,
        IsoDateTime::from(request.observed_at),
    )
    .map_err(|error| PaymentPlanningError::Attenuation(error.to_string()))?;

    let reservation_fingerprint = serde_json::json!({
        "quote_id": required_string(quote, "quote_id")?,
        "parent_term_id": parent.term_id,
        "child_term_id": child_authority.term_id,
        "idempotency_seed": idempotency_seed,
        "target_harness_ref": target_harness_ref,
        "target_act_id": target_act_id,
    });
    let reservation_digest = sha256_hex(&json_bytes(&reservation_fingerprint)?);
    let decision_id = format!("decision-payment-{reservation_digest}");
    let idempotency_key = format!("payment:{reservation_digest}");
    let spend_capability_ref = Reference::with_uri(
        ReferenceType::Credential,
        format!("capability:payment:{reservation_digest}"),
    );
    let decision = Decision {
        decision_id: decision_id.clone().into(),
        choice: DecisionChoice::Continue,
        inputs: DecisionInputs::default(),
        proposed_intent: Intent {
            purpose: "complete one bounded payment".into(),
            legitimacy: "authorized by deterministic payment attenuation".into(),
            success_criteria: Vec::new(),
            constraints: Vec::new(),
            derived_from: Vec::new(),
        },
        selected_act_id: Some(target_act_id.into()),
        selected_harness_ref: Some(target_harness_ref.clone()),
        justification: DecisionJustification {
            summary: "native reservation selected the digest-bound payment act".into(),
            evidence_refs: Vec::new(),
        },
        closure: None,
        artifact_refs: Vec::new(),
    };
    let binding = serde_json::json!({
        "child_harness_ref": target_harness_ref,
        "act_id": target_act_id,
        "reservation_decision_id": decision_id,
        "idempotency_key": idempotency_key,
        "amount_minor": amount_minor,
        "currency": currency,
        "counterparty": counterparty,
        "rail": rail,
    });
    let reserved = serde_json::json!({
        "parent_authority": parent,
        "child_authority": child_authority,
        "reservation_decision": decision,
        "subset_proof": subset_proof,
        "child_harness_ref": target_harness_ref,
        "spend_capability_binding": binding,
        "consumed_spend_capability_refs": [],
    });

    let packet = JsonValue::Object(JsonObject::from([
        ("payment_decision".to_owned(), typed_value(&decision)?),
        (
            "reserved_payment_authority".to_owned(),
            object_value(reserved)?,
        ),
        (
            "spend_capability_ref".to_owned(),
            typed_value(&spend_capability_ref)?,
        ),
        (
            "idempotency".to_owned(),
            object_value(serde_json::json!({
                "key": idempotency_key,
                "recovery_required": true,
            }))?,
        ),
        (
            "approval".to_owned(),
            object_value(serde_json::json!({
                "required": true,
                "status": "pending",
            }))?,
        ),
        (
            "core_requirements".to_owned(),
            JsonValue::Array(
                [
                    "payment_authority_subset",
                    "reserve_before_rail",
                    "receipt_before_success",
                    "single_use_capability",
                ]
                .into_iter()
                .map(|value| JsonValue::String(value.to_owned()))
                .collect(),
            ),
        ),
        ("open_questions".to_owned(), JsonValue::Array(Vec::new())),
    ]));
    validate_typed_output::<PaymentReservationPacket>(&packet, "payment reservation")?;
    Ok(packet)
}

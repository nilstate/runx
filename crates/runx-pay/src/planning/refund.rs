use super::refund_proof::resolve_refund_proof;
use super::{
    AuthorityCapability, AuthorityEffectCredentialForm, AuthorityResourceFamily, AuthorityTerm,
    AuthorityVerb, EffectToolRequest, JsonObject, JsonValue, PaymentPlanningError,
    PaymentRefundPlan, RefundAdmissionDecision, RefundAdmissionInput, RefundRefusalCode,
    RefundRequest, RefundableCharge, admit_opaque, admit_refund, finding, invalid,
    is_opaque_reference, json_bytes, object_value, payment_limit, required_object, required_string,
    required_typed, required_u64, sha256_hex, validate_typed_output,
};

// Function rationale: refund admission binds original finality, remaining refundable amount, authority, payer, rail, and idempotency before any adapter handoff.
pub(super) fn refund_plan(
    request: EffectToolRequest<'_>,
) -> Result<JsonValue, PaymentPlanningError> {
    let original_receipt_ref = required_string(request.inputs, "original_receipt_ref")?;
    let verified = resolve_refund_proof(request, original_receipt_ref)?;
    let original = verified.charge;
    let refund = required_object(request.inputs, "refund_request")?;
    let settlement_family = required_string(request.inputs, "settlement_family")?;
    let parent: AuthorityTerm = required_typed(request.inputs, "parent_payment_authority")?;
    let mut findings = Vec::new();

    if !is_opaque_reference(original_receipt_ref) {
        findings.push(finding(
            "original_receipt_ref.unsafe",
            "original_receipt_ref must be an opaque non-secret reference",
        ));
    }
    if !is_opaque_reference(settlement_family) {
        findings.push(finding(
            "settlement_family.unsafe",
            "settlement_family must be an opaque non-secret reference",
        ));
    }
    let extras = refund
        .keys()
        .filter(|field| {
            !matches!(
                field.as_str(),
                "amount_minor" | "reason" | "requested_counterparty"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if !extras.is_empty() {
        findings.push(finding(
            "refund_request.raw_fields",
            format!(
                "refund_request contains unsupported fields: {}",
                extras.join(", ")
            ),
        ));
    }
    let amount_minor = required_u64(refund, "amount_minor")?;
    let reason = admit_opaque(
        refund.get("reason"),
        "refund_request.reason",
        256,
        true,
        &mut findings,
    );
    let requested_counterparty = admit_opaque(
        refund.get("requested_counterparty"),
        "refund_request.requested_counterparty",
        256,
        false,
        &mut findings,
    );
    if original.rail != settlement_family {
        findings.push(finding(
            "refund.family",
            "selected settlement family does not match the linked charge",
        ));
    }
    if let Err(message) =
        validate_refund_authority(&parent, &original, settlement_family, amount_minor)
    {
        findings.push(finding("refund.authority", message));
    }
    let admission = admit_refund(&RefundAdmissionInput {
        charge: original.clone(),
        refund: RefundRequest {
            amount_minor,
            requested_counterparty,
        },
    });
    let reversal = match admission {
        RefundAdmissionDecision::Admitted { reversal } => Some(reversal),
        RefundAdmissionDecision::Refused { code, reason } => {
            findings.push(finding(refund_refusal_code(&code), reason));
            None
        }
    };
    let remaining_minor = original
        .amount_minor
        .saturating_sub(original.refunded_minor);
    let authority_digest = format!(
        "sha256:{}",
        sha256_hex(&json_bytes(&serde_json::to_value(&parent).map_err(
            |error| { invalid(format!("refund authority serialization failed: {error}")) }
        )?)?)
    );
    let idempotency_fingerprint = serde_json::json!({
        "original_receipt_ref": original_receipt_ref,
        "original_money_movement_id": original.money_movement_id,
        "receipt_proof_digest": verified.proof_digest,
        "amount_minor": amount_minor,
        "target": original.payer_ref,
        "settlement_family": settlement_family,
        "authority_digest": authority_digest,
    });
    let idempotency_key = format!(
        "refund:{}",
        sha256_hex(&json_bytes(&idempotency_fingerprint)?)
    );
    let core = serde_json::json!({
        "original_charge": {
            "receipt_ref": original_receipt_ref,
            "money_movement_id": original.money_movement_id,
            "proof_ref": original.proof_ref,
            "phase": original.phase,
            "receipt_proof_digest": verified.proof_digest,
            "refund_history_receipt_refs": verified.history_receipt_refs,
            "amount_minor": original.amount_minor,
            "refunded_minor": original.refunded_minor,
            "currency": original.currency,
            "settlement_family": original.rail,
            "payer_ref": original.payer_ref,
        },
        "refund_request": {
            "amount_minor": amount_minor,
            "reason": reason,
        },
        "settlement_family": settlement_family,
        "refundable_bounds": {
            "remaining_minor": remaining_minor,
            "currency": original.currency,
        },
        "authority": {
            "parent_term_id": parent.term_id,
            "digest": authority_digest,
            "validation": "native_refund_authority",
        },
        "idempotency": {
            "key": idempotency_key,
            "recovery_required": true,
        },
    });
    let ready = findings.is_empty() && reversal.is_some();
    let adapter_handoff = if ready {
        Some(object_value(serde_json::json!({
            "settlement_family": settlement_family,
            "original_receipt_ref": original_receipt_ref,
            "original_money_movement_id": original.money_movement_id,
            "original_proof_ref": original.proof_ref,
            "amount_minor": amount_minor,
            "currency": original.currency,
            "counterparty": original.payer_ref,
            "idempotency_key": idempotency_key,
            "authority_term_id": parent.term_id,
        }))?)
    } else {
        None
    };
    let plan_digest = format!("sha256:{}", sha256_hex(&json_bytes(&core)?));
    let mut plan = object_value(core)?
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("refund plan must be an object"))?;
    plan.insert(
        "schema".to_owned(),
        JsonValue::String("runx.payment.refund_plan.v1".to_owned()),
    );
    plan.insert(
        "decision".to_owned(),
        JsonValue::String(
            if ready {
                "ready_for_refund_adapter"
            } else {
                "blocked"
            }
            .to_owned(),
        ),
    );
    plan.insert(
        "adapter_handoff".to_owned(),
        adapter_handoff.unwrap_or(JsonValue::Null),
    );
    for (key, value) in [
        ("provider_status", "not_called"),
        ("refund_status", "not_started"),
        ("approval_status", "not_requested"),
        ("receipt_status", "not_sealed"),
    ] {
        plan.insert(key.to_owned(), JsonValue::String(value.to_owned()));
    }
    plan.insert("money_moved".to_owned(), JsonValue::Bool(false));
    plan.insert("findings".to_owned(), JsonValue::Array(findings));
    plan.insert("plan_digest".to_owned(), JsonValue::String(plan_digest));
    validate_typed_output::<PaymentRefundPlan>(&JsonValue::Object(plan.clone()), "refund plan")?;
    Ok(JsonValue::Object(JsonObject::from([(
        "refund_plan".to_owned(),
        JsonValue::Object(plan),
    )])))
}

fn validate_refund_authority(
    parent: &AuthorityTerm,
    original: &RefundableCharge,
    settlement_family: &str,
    amount_minor: u64,
) -> Result<(), String> {
    let limit = payment_limit(parent).map_err(|error| error.to_string())?;
    if parent.resource_family != AuthorityResourceFamily::Effect
        || !parent.verbs.contains(&AuthorityVerb::Reverse)
        || !parent
            .capabilities
            .contains(&AuthorityCapability::EffectSingleUseCapability)
        || limit.authorization_form != Some(AuthorityEffectCredentialForm::SingleUseCapability)
        || !limit.single_use_capability
        || !limit.idempotency_required
        || !limit.recovery_required
        || !limit.receipt_before_success
        || limit
            .max_per_call_units
            .is_none_or(|ceiling| amount_minor > ceiling)
        || (limit.max_per_run_units.is_none() && limit.max_per_period_units.is_none())
        || limit.unit.as_str() != original.currency
        || !limit
            .channels
            .iter()
            .any(|family| family.as_str() == settlement_family)
        || limit.peer.as_deref() != Some(original.payer_ref.as_str())
        || limit.operation.as_deref() != Some("refund")
    {
        return Err(
            "parent_payment_authority is not a bounded single-use refund authority for the linked payer, family, currency, and amount"
                .to_owned(),
        );
    }
    Ok(())
}

fn refund_refusal_code(code: &RefundRefusalCode) -> &'static str {
    match code {
        RefundRefusalCode::ChargeNotSealed => "refund.charge_not_sealed",
        RefundRefusalCode::ChargeReversed => "refund.charge_reversed",
        RefundRefusalCode::RefundHistoryInvalid => "refund.history_invalid",
        RefundRefusalCode::EmptyRefund => "refund.empty",
        RefundRefusalCode::RefundExceedsCharge => "refund.over_limit",
        RefundRefusalCode::CounterpartyMismatch => "refund.counterparty_mismatch",
    }
}

use super::super::{
    AuthorityCapability, AuthorityEffectCredentialForm, AuthorityEffectLimit,
    AuthorityResourceFamily, AuthorityTerm, AuthorityVerb, JsonObject, JsonValue, PAYMENT_FAMILY,
    PaymentPlanningError, invalid, is_wildcard, json_bytes, sha256_hex, string_array,
};

#[allow(clippy::too_many_arguments)]
pub(super) fn requested_authority(
    parent: &AuthorityTerm,
    parent_limit: &AuthorityEffectLimit,
    amount_minor: u64,
    currency: &str,
    rail: &str,
    counterparty: &str,
    operation: &str,
    realm: Option<&str>,
    idempotency_seed: &str,
) -> Result<AuthorityTerm, PaymentPlanningError> {
    let mut limit = parent_limit.clone();
    limit.unit = currency.into();
    limit.max_per_call_units = Some(amount_minor);
    limit.max_per_run_units = Some(amount_minor);
    limit.channels = vec![rail.into()];
    limit.peer = Some(counterparty.into());
    limit.operation = Some(operation.into());
    limit.realm = realm.map(Into::into);
    limit.authorization_form = Some(AuthorityEffectCredentialForm::SingleUseCapability);
    limit.idempotency_required = true;
    limit.recovery_required = true;
    limit.receipt_before_success = true;
    limit.single_use_capability = true;

    let mut bounds = parent.bounds.clone();
    bounds.effect_limits = vec![limit];
    let fingerprint = serde_json::json!({
        "parent_term_id": parent.term_id,
        "bounds": bounds,
        "idempotency_seed": idempotency_seed,
    });
    Ok(AuthorityTerm {
        term_id: format!("payment-request-{}", sha256_hex(&json_bytes(&fingerprint)?)).into(),
        principal_ref: parent.principal_ref.clone(),
        resource_ref: parent.resource_ref.clone(),
        resource_family: AuthorityResourceFamily::Effect,
        verbs: vec![AuthorityVerb::Prepare, AuthorityVerb::Commit],
        bounds,
        conditions: parent.conditions.clone(),
        approvals: parent.approvals.clone(),
        capabilities: vec![AuthorityCapability::EffectSingleUseCapability],
        expires_at: parent.expires_at.clone(),
        issued_by_ref: parent.issued_by_ref.clone(),
        credential_ref: parent.credential_ref.clone(),
    })
}

pub(super) fn validate_parent(
    parent: &AuthorityTerm,
    limit: &AuthorityEffectLimit,
) -> Result<(), PaymentPlanningError> {
    if parent.resource_family != AuthorityResourceFamily::Effect
        || !parent.verbs.contains(&AuthorityVerb::Prepare)
        || !parent.verbs.contains(&AuthorityVerb::Commit)
        || !parent
            .capabilities
            .contains(&AuthorityCapability::EffectSingleUseCapability)
        || limit.authorization_form != Some(AuthorityEffectCredentialForm::SingleUseCapability)
        || !limit.single_use_capability
        || limit.max_per_call_units.is_none()
        || (limit.max_per_run_units.is_none() && limit.max_per_period_units.is_none())
        || limit.channels.is_empty()
        || limit.peer.as_deref().is_none_or(is_wildcard)
        || limit.operation.as_deref().is_none_or(is_wildcard)
    {
        return Err(invalid(
            "parent_payment_authority is not a bounded single-use payment authority",
        ));
    }
    Ok(())
}

pub(super) fn validate_requested_quote(
    authority: &AuthorityTerm,
    amount_minor: u64,
    currency: &str,
    rail: &str,
    counterparty: &str,
    operation: &str,
) -> Result<(), PaymentPlanningError> {
    let limit = payment_limit(authority)?;
    if limit.max_per_call_units != Some(amount_minor)
        || limit.max_per_run_units != Some(amount_minor)
        || limit.unit.as_str() != currency
        || limit.channels.as_slice() != [rail]
        || limit.peer.as_deref() != Some(counterparty)
        || limit.operation.as_deref() != Some(operation)
    {
        return Err(invalid(
            "payment quote and requested authority are not digest-bound to the same payment",
        ));
    }
    Ok(())
}

pub(in crate::planning) fn payment_limit(
    term: &AuthorityTerm,
) -> Result<&AuthorityEffectLimit, PaymentPlanningError> {
    let mut limits = term
        .bounds
        .effect_limits
        .iter()
        .filter(|limit| limit.family.as_str() == PAYMENT_FAMILY);
    let limit = limits
        .next()
        .ok_or_else(|| invalid("payment authority has no payment effect limit"))?;
    if limits.next().is_some() {
        return Err(invalid(
            "payment authority must contain exactly one payment effect limit",
        ));
    }
    Ok(limit)
}

pub(super) fn select_rail<'a>(
    inputs: &'a JsonObject,
    signal: &'a JsonObject,
    parent: &'a AuthorityEffectLimit,
) -> Result<&'a str, PaymentPlanningError> {
    let preferences = inputs
        .get("rail_preferences")
        .map(|value| string_array(value, "rail_preferences"))
        .transpose()?
        .unwrap_or_default();
    let signal_rail = signal.get("rail").and_then(JsonValue::as_str);
    if let Some(rail) = signal_rail {
        if !preferences.is_empty() && !preferences.contains(&rail) {
            return Err(invalid(
                "payment signal rail is outside the caller rail preferences",
            ));
        }
        if !parent.channels.iter().any(|candidate| candidate == rail) {
            return Err(invalid(
                "payment signal rail is outside the parent authority",
            ));
        }
        return Ok(rail);
    }
    if let Some(rail) = preferences
        .into_iter()
        .find(|rail| parent.channels.iter().any(|candidate| candidate == rail))
    {
        return Ok(rail);
    }
    parent
        .channels
        .first()
        .map(|rail| rail.as_str())
        .ok_or_else(|| invalid("parent payment authority has no rail"))
}

pub(super) fn consistent_string<'a>(
    inputs: &'a JsonObject,
    signal: &'a JsonObject,
    field: &str,
) -> Result<&'a str, PaymentPlanningError> {
    let explicit = inputs.get(field).and_then(JsonValue::as_str);
    let observed = signal.get(field).and_then(JsonValue::as_str);
    match (explicit, observed) {
        (Some(left), Some(right)) if left != right => Err(invalid(format!(
            "{field} input does not match payment_signal.{field}"
        ))),
        (Some(value), _) | (_, Some(value)) if !value.trim().is_empty() => Ok(value),
        _ => Err(invalid(format!(
            "{field} is required in the input or payment signal"
        ))),
    }
}

pub(super) fn consistent_optional_string(
    inputs: &JsonObject,
    signal: &JsonObject,
    field: &str,
) -> Result<Option<String>, PaymentPlanningError> {
    let explicit = inputs.get(field).and_then(JsonValue::as_str);
    let observed = signal.get(field).and_then(JsonValue::as_str);
    match (explicit, observed) {
        (Some(left), Some(right)) if left != right => Err(invalid(format!(
            "{field} input does not match payment_signal.{field}"
        ))),
        (Some(value), _) | (_, Some(value)) if !value.trim().is_empty() => {
            Ok(Some(value.to_owned()))
        }
        _ => Ok(None),
    }
}

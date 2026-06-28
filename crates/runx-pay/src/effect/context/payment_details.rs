use std::collections::BTreeMap;

use runx_contracts::{AuthorityEffectLimit, AuthorityTerm, JsonObject, JsonValue};
use runx_runtime::RuntimeEffectError;

use super::super::PAYMENT_EFFECT_FAMILY;
use super::super::errors::{denied, failed};
use super::types::{OwnedStepAuthoritySubmission, PaymentSettlementIdentity};
use crate::effect_state::{
    EffectPeriodSpendReservation, EffectRunSpendReservation, period_window_start,
};

pub(in crate::effect) fn settlement_identity_from_inputs(
    inputs: &JsonObject,
) -> Result<Option<PaymentSettlementIdentity>, RuntimeEffectError> {
    let Some(value) = inputs.get("payment_admission") else {
        return Ok(None);
    };
    let JsonValue::Object(admission) = value else {
        return Err(denied(
            "payment_admission must be an object before payment rail execution".to_owned(),
        ));
    };
    let payment_admission_id = required_settlement_identity_string(
        admission,
        &["payment_admission_id", "token_digest"],
        "payment_admission.payment_admission_id",
    )?;
    let money_movement_id = optional_settlement_identity_string(
        admission,
        &["money_movement_id"],
        "payment_admission.money_movement_id",
    )?
    .map(Ok)
    .unwrap_or_else(|| {
        let Some(JsonValue::Object(token)) = admission.get("token") else {
            return Err(denied(
                "payment_admission.money_movement_id is required before payment rail execution"
                    .to_owned(),
            ));
        };
        required_settlement_identity_string(
            token,
            &["money_movement_id"],
            "payment_admission.token.money_movement_id",
        )
    })?;
    let kernel_token_digest = required_settlement_identity_string(
        admission,
        &["kernel_token_digest", "token_digest"],
        "payment_admission.kernel_token_digest",
    )?;
    Ok(Some(PaymentSettlementIdentity {
        payment_admission_id,
        money_movement_id,
        kernel_token_digest,
    }))
}

pub(in crate::effect) fn run_spend_reservation(
    input: &OwnedStepAuthoritySubmission,
    inputs: &JsonObject,
    env: &BTreeMap<String, String>,
) -> Result<Option<EffectRunSpendReservation>, RuntimeEffectError> {
    let payment = payment_effect_limit(&input.child_authority);
    let max_per_run_units = payment.and_then(|payment| payment.max_per_run_units);
    let max_per_period_units = payment.and_then(|payment| payment.max_per_period_units);
    let Some(max_per_run_units) = (match (max_per_run_units, max_per_period_units) {
        (Some(run_cap), Some(period_cap)) => Some(run_cap.min(period_cap)),
        (Some(run_cap), None) => Some(run_cap),
        (None, Some(period_cap)) => Some(period_cap),
        (None, None) => None,
    }) else {
        return Ok(None);
    };
    let Some(run_id) = payment_run_id(inputs, env)? else {
        return Err(denied(
            "payment authority with an aggregate spend cap requires a run_id before rail execution"
                .to_owned(),
        ));
    };
    Ok(Some(EffectRunSpendReservation {
        run_id,
        authority_ref: input.child_authority.resource_ref.uri.clone().into_string(),
        max_per_run_units,
    }))
}

pub(in crate::effect) fn period_spend_reservation(
    input: &OwnedStepAuthoritySubmission,
) -> Result<Option<EffectPeriodSpendReservation>, RuntimeEffectError> {
    let Some(payment) = payment_effect_limit(&input.child_authority) else {
        return Ok(None);
    };
    let Some(max_per_period_units) = payment.max_per_period_units else {
        return Ok(None);
    };
    let Some(period) = payment.period.as_ref() else {
        return Ok(None);
    };
    let unix_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|source| failed("reading wall clock for period window", source))?
        .as_secs();
    let window_start = period_window_start(period.as_str(), unix_seconds)
        .map_err(|source| denied(source.to_string()))?;
    Ok(Some(EffectPeriodSpendReservation {
        authority_ref: input.child_authority.resource_ref.uri.clone().into_string(),
        max_per_period_units,
        period: period.as_str().to_owned(),
        window_start,
    }))
}

fn payment_effect_limit(term: &AuthorityTerm) -> Option<&AuthorityEffectLimit> {
    term.bounds
        .effect_limits
        .iter()
        .find(|limit| limit.family == PAYMENT_EFFECT_FAMILY)
}

fn payment_run_id(
    inputs: &JsonObject,
    env: &BTreeMap<String, String>,
) -> Result<Option<String>, RuntimeEffectError> {
    if let Some(run_id) = env
        .get(runx_runtime::RUNX_RUN_ID_ENV)
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(Some(run_id.clone()));
    }
    if let Some(run_id) = optional_string_input(inputs, "run_id")? {
        return Ok(Some(run_id));
    }
    let Some(JsonValue::Object(admission)) = inputs.get("payment_admission") else {
        return Ok(None);
    };
    if let Some(JsonValue::Object(token)) = admission.get("token") {
        return optional_string_input(token, "run_id");
    }
    optional_string_input(admission, "run_id")
}

fn optional_string_input(
    inputs: &JsonObject,
    field: &str,
) -> Result<Option<String>, RuntimeEffectError> {
    match inputs.get(field) {
        Some(JsonValue::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        Some(JsonValue::String(_)) => Err(denied(format!(
            "{field} must not be empty before payment rail execution"
        ))),
        Some(_) => Err(denied(format!(
            "{field} must be a string before payment rail execution"
        ))),
        None => Ok(None),
    }
}

fn required_settlement_identity_string(
    object: &JsonObject,
    fields: &[&'static str],
    field_path: &'static str,
) -> Result<String, RuntimeEffectError> {
    optional_settlement_identity_string(object, fields, field_path)?.ok_or_else(|| {
        denied(format!(
            "{field_path} is required before payment rail execution"
        ))
    })
}

fn optional_settlement_identity_string(
    object: &JsonObject,
    fields: &[&'static str],
    field_path: &'static str,
) -> Result<Option<String>, RuntimeEffectError> {
    for field in fields {
        match object.get(*field) {
            Some(JsonValue::String(value)) if !value.trim().is_empty() => {
                return Ok(Some(value.to_owned()));
            }
            Some(JsonValue::String(_)) => {
                return Err(denied(format!(
                    "{field_path} must not be empty before payment rail execution"
                )));
            }
            Some(_) => {
                return Err(denied(format!(
                    "{field_path} must be a string before payment rail execution"
                )));
            }
            None => {}
        }
    }
    Ok(None)
}

//! Deterministic quote and reservation construction for the native payment
//! tools. Model judgment may select a payment intent; it never authors the
//! authority term, subset proof, idempotency binding, or capability reference.

use runx_contracts::schema::IsoDateTime;
use runx_contracts::{
    AuthorityCapability, AuthorityEffectCredentialForm, AuthorityEffectLimit,
    AuthorityResourceFamily, AuthorityTerm, AuthorityVerb, Decision, DecisionChoice,
    DecisionInputs, DecisionJustification, Intent, JsonNumber, JsonObject, JsonValue, Reference,
    ReferenceType, sha256_hex,
};
use runx_core::policy::{AttenuationRequest, mint_attenuated};
use runx_runtime::{EffectToolRequest, RuntimeError};
use serde::Serialize;
use serde::de::DeserializeOwned;
use thiserror::Error;

use crate::authority::PaymentBoundsComparator;
use crate::contracts::{
    PaymentChargePlan, PaymentChargeVerificationRequest, PaymentInvoiceSettlementPlan,
    PaymentQuotePacket, PaymentRefundPlan, PaymentReservationPacket,
};
use crate::refunds::{
    RefundAdmissionDecision, RefundAdmissionInput, RefundRefusalCode, RefundRequest,
    RefundableCharge, admit_refund,
};

mod capabilities;
mod charge;
mod invoice;
mod refund;
mod refund_proof;
mod spend;

use capabilities::{
    CHARGE_CHALLENGE_TOOL, CHARGE_PLAN_TOOL, CHARGE_PRICE_TOOL, CHARGE_VERIFICATION_REQUEST_TOOL,
    INVOICE_PLAN_TOOL, QUOTE_TOOL, REFUND_PLAN_TOOL, RESERVE_TOOL,
};
use charge::{charge_challenge, charge_plan, charge_price, charge_verification_request};
use invoice::invoice_plan;
use refund::refund_plan;
use spend::{payment_limit, quote, reserve};

const PAYMENT_FAMILY: &str = "payment";

pub(crate) fn capabilities() -> &'static [&'static dyn runx_runtime::CapabilityContract] {
    capabilities::CAPABILITIES
}

#[derive(Debug, Error)]
enum PaymentPlanningError {
    #[error("{0}")]
    Invalid(String),
    #[error("payment authority attenuation failed: {0}")]
    Attenuation(String),
    #[error("payment planning serialization failed: {0}")]
    Serialization(String),
}

pub(crate) fn invoke(request: EffectToolRequest<'_>) -> Option<Result<JsonValue, RuntimeError>> {
    let result = match request.tool_ref {
        QUOTE_TOOL => quote(request),
        RESERVE_TOOL => reserve(request),
        CHARGE_PRICE_TOOL => charge_price(request),
        CHARGE_CHALLENGE_TOOL => charge_challenge(request),
        CHARGE_VERIFICATION_REQUEST_TOOL => charge_verification_request(request),
        CHARGE_PLAN_TOOL => charge_plan(request),
        REFUND_PLAN_TOOL => refund_plan(request),
        INVOICE_PLAN_TOOL => invoice_plan(request),
        _ => return None,
    };
    Some(result.map_err(|error| RuntimeError::SkillFailed {
        skill_name: request.tool_ref.to_owned(),
        message: error.to_string(),
    }))
}

fn is_opaque_reference(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.chars().any(char::is_whitespace)
        && !value.to_ascii_lowercase().starts_with("sk-")
        && !value.to_ascii_lowercase().starts_with("bearer:")
        && !value.to_ascii_lowercase().contains("-----begin")
}

fn is_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn validate_typed_output<T>(value: &JsonValue, label: &str) -> Result<(), PaymentPlanningError>
where
    T: DeserializeOwned,
{
    value
        .clone()
        .deserialize_into::<T>()
        .map(|_| ())
        .map_err(|source| invalid(format!("{label} violated its canonical contract: {source}")))
}

fn finding(code: impl Into<String>, message: impl Into<String>) -> JsonValue {
    JsonValue::Object(JsonObject::from([
        ("code".to_owned(), JsonValue::String(code.into())),
        ("message".to_owned(), JsonValue::String(message.into())),
    ]))
}

fn packet_findings(packet: &JsonObject) -> Vec<JsonValue> {
    packet
        .get("open_questions")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default()
}

fn admit_opaque(
    value: Option<&JsonValue>,
    field: &str,
    max_len: usize,
    required: bool,
    findings: &mut Vec<JsonValue>,
) -> Option<String> {
    let Some(raw) = value else {
        if required {
            findings.push(finding(
                format!("{field}.missing"),
                format!("{field} is required"),
            ));
        }
        return None;
    };
    let Some(value) = raw
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        findings.push(finding(
            format!("{field}.invalid"),
            format!("{field} must be a non-empty string"),
        ));
        return None;
    };
    let lower = value.to_ascii_lowercase();
    if value.len() > max_len
        || value.chars().any(char::is_whitespace)
        || lower.starts_with("sk-")
        || lower.starts_with("bearer:")
        || lower.contains("-----begin")
    {
        findings.push(finding(
            format!("{field}.unsafe"),
            format!("{field} must be an opaque non-secret reference"),
        ));
        return None;
    }
    Some(value.to_owned())
}

fn admit_opaque_array(
    value: Option<&JsonValue>,
    field: &str,
    max_items: usize,
    max_len: usize,
    findings: &mut Vec<JsonValue>,
) -> Vec<String> {
    let Some(values) = value.and_then(JsonValue::as_array) else {
        findings.push(finding(
            format!("{field}.invalid"),
            format!("{field} must be an array"),
        ));
        return Vec::new();
    };
    if values.len() > max_items {
        findings.push(finding(
            format!("{field}.limit"),
            format!("{field} exceeds {max_items} entries"),
        ));
        return Vec::new();
    }
    let mut admitted = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if let Some(value) = admit_opaque(
            Some(value),
            &format!("{field}[{index}]"),
            max_len,
            true,
            findings,
        ) && !admitted.contains(&value)
        {
            admitted.push(value);
        }
    }
    admitted
}

fn looks_like_iso_datetime(value: &str) -> bool {
    let Some(value) = value.strip_suffix('Z') else {
        return false;
    };
    let mut parts = value.split('.');
    let Some(base) = parts.next() else {
        return false;
    };
    let fraction = parts.next();
    if parts.next().is_some()
        || fraction.is_some_and(|fraction| {
            fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return false;
    }
    base.len() == 19
        && base.as_bytes()[4] == b'-'
        && base.as_bytes()[7] == b'-'
        && base.as_bytes()[10] == b'T'
        && base.as_bytes()[13] == b':'
        && base.as_bytes()[16] == b':'
        && base
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16) || byte.is_ascii_digit())
}

fn required_object<'a>(
    object: &'a JsonObject,
    field: &str,
) -> Result<&'a JsonObject, PaymentPlanningError> {
    object
        .get(field)
        .and_then(JsonValue::as_object)
        .ok_or_else(|| invalid(format!("{field} must be an object")))
}

fn required_array<'a>(
    object: &'a JsonObject,
    field: &str,
) -> Result<&'a [JsonValue], PaymentPlanningError> {
    object
        .get(field)
        .and_then(JsonValue::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| invalid(format!("{field} must be an array")))
}

fn required_string<'a>(
    object: &'a JsonObject,
    field: &str,
) -> Result<&'a str, PaymentPlanningError> {
    object
        .get(field)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{field} must be a non-empty string")))
}

fn required_u64(object: &JsonObject, field: &str) -> Result<u64, PaymentPlanningError> {
    optional_u64(object, field)?
        .ok_or_else(|| invalid(format!("{field} must be a non-negative integer")))
}

fn optional_u64(object: &JsonObject, field: &str) -> Result<Option<u64>, PaymentPlanningError> {
    match object.get(field) {
        None => Ok(None),
        Some(JsonValue::Number(JsonNumber::U64(value))) => Ok(Some(*value)),
        Some(JsonValue::Number(JsonNumber::I64(value))) if *value >= 0 => {
            Ok(u64::try_from(*value).ok())
        }
        _ => Err(invalid(format!("{field} must be a non-negative integer"))),
    }
}

fn single_string<'a>(
    values: &'a [JsonValue],
    field: &str,
) -> Result<&'a str, PaymentPlanningError> {
    if values.len() != 1 {
        return Err(invalid(format!("{field} must contain exactly one rail")));
    }
    values[0]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{field}[0] must be a non-empty string")))
}

fn string_array<'a>(
    value: &'a JsonValue,
    field: &str,
) -> Result<Vec<&'a str>, PaymentPlanningError> {
    let values = value
        .as_array()
        .ok_or_else(|| invalid(format!("{field} must be an array")))?;
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            value
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid(format!("{field}[{index}] must be a string")))
        })
        .collect()
}

fn required_typed<T: DeserializeOwned>(
    object: &JsonObject,
    field: &str,
) -> Result<T, PaymentPlanningError> {
    let value = object
        .get(field)
        .ok_or_else(|| invalid(format!("{field} is required")))?;
    serde_json::from_value(
        serde_json::to_value(value)
            .map_err(|error| PaymentPlanningError::Serialization(error.to_string()))?,
    )
    .map_err(|error| invalid(format!("{field} is invalid: {error}")))
}

fn typed_value(value: &impl Serialize) -> Result<JsonValue, PaymentPlanningError> {
    serde_json::from_value(
        serde_json::to_value(value)
            .map_err(|error| PaymentPlanningError::Serialization(error.to_string()))?,
    )
    .map_err(|error| PaymentPlanningError::Serialization(error.to_string()))
}

fn object_value(value: impl Serialize) -> Result<JsonValue, PaymentPlanningError> {
    let value = typed_value(&value)?;
    match value {
        JsonValue::Object(_) => Ok(value),
        _ => Err(PaymentPlanningError::Serialization(
            "expected object value".to_owned(),
        )),
    }
}

fn json_bytes(value: &impl Serialize) -> Result<Vec<u8>, PaymentPlanningError> {
    serde_json::to_vec(value)
        .map_err(|error| PaymentPlanningError::Serialization(error.to_string()))
}

fn is_wildcard(value: &str) -> bool {
    matches!(value.trim(), "" | "*" | "any")
}

fn invalid(message: impl Into<String>) -> PaymentPlanningError {
    PaymentPlanningError::Invalid(message.into())
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::wildcard_imports)]
mod tests;

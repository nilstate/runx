use runx_contracts::{JsonNumber, JsonObject, JsonValue};
use thiserror::Error;

use crate::json_util::json_value_kind;

pub trait PaymentFinalitySupervisor: Send + Sync {
    fn supervise(
        &self,
        request: PaymentFinalitySupervisorRequest<'_>,
    ) -> Result<PaymentFinalitySupervisorEvidence, PaymentFinalitySupervisorError>;
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PaymentFinalitySupervisorError {
    #[error("payment finality supervisor is not configured")]
    SupervisorUnavailable,
    #[error("payment finality supervisor evidence is invalid: {message}")]
    InvalidEvidence { message: String },
    #[error("payment finality supervisor denied request: {message}")]
    Denied { message: String },
    #[error(
        "payment finality supervisor field {field} mismatch: expected {expected}, got {actual}"
    )]
    FieldMismatch {
        field: &'static str,
        expected: String,
        actual: String,
    },
}

#[derive(Clone, Debug)]
pub struct PaymentFinalitySupervisorRequest<'a> {
    pub family: &'a str,
    pub payload: JsonObject,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PaymentFinalitySupervisorEvidence {
    pub family: String,
    pub payload: JsonObject,
}

impl PaymentFinalitySupervisorEvidence {
    #[must_use]
    pub fn new(family: impl Into<String>, payload: JsonObject) -> Self {
        Self {
            family: family.into(),
            payload,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct DeterministicPaymentFinalitySupervisor;

impl PaymentFinalitySupervisor for DeterministicPaymentFinalitySupervisor {
    // rust-style-allow: long-function because deterministic finality validates
    // one complete rail settlement packet before evidence is admitted.
    fn supervise(
        &self,
        request: PaymentFinalitySupervisorRequest<'_>,
    ) -> Result<PaymentFinalitySupervisorEvidence, PaymentFinalitySupervisorError> {
        let status =
            supervisor_payload_optional_string(&request.payload, "skill_settlement_status")?;
        if status != Some("fulfilled") {
            return Err(PaymentFinalitySupervisorError::Denied {
                message: format!("payment rail result status {status:?} is not fulfilled"),
            });
        }
        let proof_ref = supervisor_payload_string(&request.payload, "proof_ref")?;
        let rail = supervisor_payload_string(&request.payload, "rail")?;
        let counterparty = supervisor_payload_string(&request.payload, "counterparty")?;
        let amount_minor = supervisor_payload_u64(&request.payload, "amount_minor")?;
        let currency = supervisor_payload_string(&request.payload, "currency")?;
        let idempotency_key = supervisor_payload_string(&request.payload, "idempotency_key")?;
        let payment_admission_id =
            supervisor_payload_optional_string(&request.payload, "payment_admission_id")?;
        let money_movement_id =
            supervisor_payload_optional_string(&request.payload, "money_movement_id")?;
        let kernel_token_digest =
            supervisor_payload_optional_string(&request.payload, "kernel_token_digest")?;

        let mut payload = JsonObject::new();
        payload.insert(
            "verifier_id".to_owned(),
            JsonValue::String(crate::supervisor::PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID.to_owned()),
        );
        payload.insert(
            "proof_ref".to_owned(),
            JsonValue::String(proof_ref.to_owned()),
        );
        payload.insert("rail".to_owned(), JsonValue::String(rail.to_owned()));
        payload.insert(
            "counterparty".to_owned(),
            JsonValue::String(counterparty.to_owned()),
        );
        payload.insert(
            "amount_minor".to_owned(),
            JsonValue::Number(JsonNumber::U64(amount_minor)),
        );
        payload.insert(
            "currency".to_owned(),
            JsonValue::String(currency.to_owned()),
        );
        payload.insert(
            "idempotency_key".to_owned(),
            JsonValue::String(idempotency_key.to_owned()),
        );
        insert_optional_string(&mut payload, "payment_admission_id", payment_admission_id);
        insert_optional_string(&mut payload, "money_movement_id", money_movement_id);
        insert_optional_string(&mut payload, "kernel_token_digest", kernel_token_digest);
        payload.insert(
            "proof_locator".to_owned(),
            JsonValue::String(proof_ref.to_owned()),
        );
        insert_optional_string(&mut payload, "proof_status", status);
        if let Some(status) = status {
            payload.insert(
                "settlement_status".to_owned(),
                JsonValue::String(status.to_owned()),
            );
        }
        payload.insert(
            "provider_event_ref".to_owned(),
            JsonValue::String(format!("runx-pay:test:{proof_ref}")),
        );
        Ok(PaymentFinalitySupervisorEvidence::new(
            request.family,
            payload,
        ))
    }
}

fn insert_optional_string(payload: &mut JsonObject, field: &'static str, value: Option<&str>) {
    if let Some(value) = value {
        payload.insert(field.to_owned(), JsonValue::String(value.to_owned()));
    }
}

fn supervisor_payload_string<'a>(
    payload: &'a JsonObject,
    field: &'static str,
) -> Result<&'a str, PaymentFinalitySupervisorError> {
    match payload.get(field) {
        Some(JsonValue::String(value)) => Ok(value),
        Some(value) => Err(invalid_supervisor_payload(field, value, "string")),
        None => Err(missing_supervisor_payload(field)),
    }
}

fn supervisor_payload_optional_string<'a>(
    payload: &'a JsonObject,
    field: &'static str,
) -> Result<Option<&'a str>, PaymentFinalitySupervisorError> {
    match payload.get(field) {
        Some(JsonValue::String(value)) => Ok(Some(value)),
        Some(JsonValue::Null) | None => Ok(None),
        Some(value) => Err(invalid_supervisor_payload(field, value, "string")),
    }
}

fn supervisor_payload_u64(
    payload: &JsonObject,
    field: &'static str,
) -> Result<u64, PaymentFinalitySupervisorError> {
    match payload.get(field) {
        Some(JsonValue::Number(JsonNumber::U64(value))) => Ok(*value),
        Some(value @ JsonValue::Number(JsonNumber::I64(number))) => u64::try_from(*number)
            .map_err(|_| invalid_supervisor_payload(field, value, "unsigned integer")),
        Some(value) => Err(invalid_supervisor_payload(field, value, "unsigned integer")),
        None => Err(missing_supervisor_payload(field)),
    }
}

fn missing_supervisor_payload(field: &'static str) -> PaymentFinalitySupervisorError {
    PaymentFinalitySupervisorError::InvalidEvidence {
        message: format!("payment finality supervisor payload is missing {field}"),
    }
}

fn invalid_supervisor_payload(
    field: &'static str,
    value: &JsonValue,
    expected: &'static str,
) -> PaymentFinalitySupervisorError {
    PaymentFinalitySupervisorError::InvalidEvidence {
        message: format!(
            "payment finality supervisor payload field {field} must be {expected}, got {}",
            json_value_kind(value)
        ),
    }
}

// Function rationale: payment packet parsing accepts the
// current graph output envelopes while payment execution is being generalized
// across mock and provider-backed rails.
use runx_contracts::{JsonNumber, JsonObject, JsonValue, json_bool_field, json_string_field};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentReservationPacket {
    pub amount_minor: u64,
    pub currency: String,
    pub rail: String,
    pub counterparty: String,
    pub operation: String,
    pub idempotency_key: String,
    pub spend_capability_ref: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentRailPacket {
    pub result: Option<PaymentRailResult>,
    pub proof: Option<PaymentRailProof>,
    pub recovery_status: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentRailResult {
    pub status: Option<String>,
    pub rail: Option<String>,
    pub amount_minor: Option<u64>,
    pub currency: Option<String>,
    pub counterparty: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentRailProof {
    pub proof_ref: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentRefusalPacket {
    pub reason_code: String,
    pub rail_call_performed: bool,
    pub ledger_spend_recorded: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaidToolPaymentPacket {
    pub payment_proof_ref: String,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum PaymentPacketError {
    #[error("payment packet is missing {field}")]
    MissingField { field: &'static str },
    #[error("payment packet field {field} has an invalid value")]
    InvalidField { field: &'static str },
}

pub(crate) fn redact_payment_transient_material(payload: &mut JsonObject) -> bool {
    let Some(JsonValue::Object(packet)) = payload.get_mut("effect_evidence_packet") else {
        return false;
    };
    let Some(JsonValue::Object(data)) = packet.get_mut("data") else {
        return false;
    };
    let Some(JsonValue::Object(proof)) = data.get_mut("rail_proof") else {
        return false;
    };
    proof.remove("rail_session_material_ref").is_some()
}

// Function rationale: reservation packets may derive fields
// from either the authority envelope or the spend-capability binding while the
// payment execution boundary is still being factored.
pub fn read_payment_reservation_packet(
    outputs: &JsonObject,
) -> Result<Option<PaymentReservationPacket>, PaymentPacketError> {
    let Some(data) = packet_data(outputs, "payment_reservation_packet") else {
        return Ok(None);
    };
    let Some(binding) = object_path(
        data,
        &["reserved_payment_authority", "spend_capability_binding"],
    )
    .or_else(|| object_path(data, &["spend_capability_binding"])) else {
        return Ok(None);
    };
    let payment_bounds = payment_effect_limit_path(
        data,
        &["reserved_payment_authority", "child_authority", "bounds"],
    )
    .or_else(|| {
        payment_effect_limit_path(
            data,
            &["reserved_payment_authority", "parent_authority", "bounds"],
        )
    });

    Ok(Some(PaymentReservationPacket {
        amount_minor: required_u64(
            binding,
            "amount_minor",
            "spend_capability_binding.amount_minor",
        )?,
        currency: required_string(binding, "currency", "spend_capability_binding.currency")?
            .to_owned(),
        rail: required_string(binding, "rail", "spend_capability_binding.rail")?.to_owned(),
        counterparty: required_string(
            binding,
            "counterparty",
            "spend_capability_binding.counterparty",
        )?
        .to_owned(),
        operation: payment_bounds
            .and_then(|bounds| non_empty_string_field(bounds, "operation"))
            .ok_or(PaymentPacketError::MissingField {
                field: "reserved_payment_authority.*.bounds.effect_limits[].operation",
            })?
            .to_owned(),
        idempotency_key: required_string(
            binding,
            "idempotency_key",
            "spend_capability_binding.idempotency_key",
        )?
        .to_owned(),
        spend_capability_ref: object_path(data, &["spend_capability_ref"])
            .and_then(|reference| non_empty_string_field(reference, "uri"))
            .ok_or(PaymentPacketError::MissingField {
                field: "spend_capability_ref.uri",
            })?
            .to_owned(),
    }))
}

pub fn read_effect_evidence_packet(
    outputs: &JsonObject,
) -> Result<Option<PaymentRailPacket>, PaymentPacketError> {
    let Some(data) = packet_data(outputs, "effect_evidence_packet") else {
        return Ok(None);
    };
    let result = object_path(data, &["rail_result"])
        .map(|result| {
            Ok(PaymentRailResult {
                status: non_empty_string_field(result, "status").map(str::to_owned),
                rail: non_empty_string_field(result, "rail").map(str::to_owned),
                amount_minor: optional_u64(result, "amount_minor", "rail_result.amount_minor")?,
                currency: non_empty_string_field(result, "currency").map(str::to_owned),
                counterparty: non_empty_string_field(result, "counterparty").map(str::to_owned),
            })
        })
        .transpose()?;
    let proof = object_path(data, &["rail_proof"])
        .map(|proof| {
            Ok(PaymentRailProof {
                proof_ref: required_string(proof, "proof_ref", "rail_proof.proof_ref")?.to_owned(),
                idempotency_key: required_string(
                    proof,
                    "idempotency_key",
                    "rail_proof.idempotency_key",
                )?
                .to_owned(),
            })
        })
        .transpose()?;

    Ok(Some(PaymentRailPacket {
        result,
        proof,
        recovery_status: object_path(data, &["recovery_hint"])
            .and_then(|hint| non_empty_string_field(hint, "status"))
            .map(str::to_owned),
    }))
}

pub fn read_payment_refusal_packet(
    outputs: &JsonObject,
) -> Result<Option<PaymentRefusalPacket>, PaymentPacketError> {
    let refusal = packet_data(outputs, "payment_refusal_packet").or_else(|| {
        packet_data(outputs, "payment_reservation_packet")
            .and_then(|data| object_path(data, &["payment_refusal_packet"]))
    });
    let Some(refusal) = refusal else {
        return Ok(None);
    };
    Ok(Some(PaymentRefusalPacket {
        reason_code: required_string(refusal, "reason_code", "payment_refusal_packet.reason_code")?
            .to_owned(),
        rail_call_performed: json_bool_field(refusal, "rail_call_performed").unwrap_or(false),
        ledger_spend_recorded: json_bool_field(refusal, "ledger_spend_recorded").unwrap_or(false),
    }))
}

pub fn read_paid_tool_packet(
    outputs: &JsonObject,
) -> Result<Option<PaidToolPaymentPacket>, PaymentPacketError> {
    let Some(result) = object_path(outputs, &["paid_echo_result"]) else {
        return Ok(None);
    };
    Ok(Some(PaidToolPaymentPacket {
        payment_proof_ref: required_string(
            result,
            "payment_proof_ref",
            "paid_echo_result.payment_proof_ref",
        )?
        .to_owned(),
    }))
}

fn packet_data<'a>(outputs: &'a JsonObject, packet: &str) -> Option<&'a JsonObject> {
    object_path(outputs, &[packet, "data"])
}

fn object_path<'a>(object: &'a JsonObject, path: &[&str]) -> Option<&'a JsonObject> {
    let mut current = object;
    for (index, segment) in path.iter().enumerate() {
        let value = current.get(*segment)?;
        if index + 1 == path.len() {
            return match value {
                JsonValue::Object(object) => Some(object),
                _ => None,
            };
        }
        let JsonValue::Object(next) = value else {
            return None;
        };
        current = next;
    }
    Some(current)
}

fn payment_effect_limit_path<'a>(object: &'a JsonObject, path: &[&str]) -> Option<&'a JsonObject> {
    let bounds = object_path(object, path)?;
    let JsonValue::Array(limits) = bounds.get("effect_limits")? else {
        return None;
    };
    limits.iter().find_map(|limit| {
        let JsonValue::Object(limit) = limit else {
            return None;
        };
        (json_string_field(limit, "family") == Some("payment")).then_some(limit)
    })
}

fn required_string<'a>(
    object: &'a JsonObject,
    key: &'static str,
    field: &'static str,
) -> Result<&'a str, PaymentPacketError> {
    non_empty_string_field(object, key).ok_or(PaymentPacketError::MissingField { field })
}

fn non_empty_string_field<'a>(object: &'a JsonObject, key: &str) -> Option<&'a str> {
    json_string_field(object, key).filter(|value| !value.is_empty())
}

fn required_u64(
    object: &JsonObject,
    key: &'static str,
    field: &'static str,
) -> Result<u64, PaymentPacketError> {
    match u64_field(object, key) {
        Some(value) => Ok(value),
        None if object.contains_key(key) => Err(PaymentPacketError::InvalidField { field }),
        None => Err(PaymentPacketError::MissingField { field }),
    }
}

fn optional_u64(
    object: &JsonObject,
    key: &'static str,
    field: &'static str,
) -> Result<Option<u64>, PaymentPacketError> {
    match u64_field(object, key) {
        Some(value) => Ok(Some(value)),
        None if object.contains_key(key) => Err(PaymentPacketError::InvalidField { field }),
        None => Ok(None),
    }
}

fn u64_field(object: &JsonObject, key: &'static str) -> Option<u64> {
    match object.get(key)? {
        JsonValue::Number(JsonNumber::U64(value)) => Some(*value),
        JsonValue::Number(JsonNumber::I64(value)) => u64::try_from(*value).ok(),
        JsonValue::Number(JsonNumber::F64(value))
            if value.is_finite() && value.fract() == 0.0 && *value >= 0.0 =>
        {
            Some(*value as u64)
        }
        JsonValue::Number(_) => None,
        _ => None,
    }
}

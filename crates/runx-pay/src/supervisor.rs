// Module rationale: payment rail proof schemas, claim
// validation, evidence metadata, and receipt binding share one audited payment
// trust boundary.
use runx_contracts::{
    JsonNumber, JsonObject, JsonValue, ProofKind, Receipt, Reference, ReferenceType,
    sha256_prefixed,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::json_util::json_value_kind;
use crate::packets::{PaymentPacketError, PaymentRailResult, read_effect_evidence_packet};

pub const PAYMENT_RAIL_SUPERVISOR_EVIDENCE_METADATA: &str = "payment_rail_supervisor_evidence";
pub const PAYMENT_RAIL_SUPERVISOR_PROOF_METADATA: &str = "payment_rail_supervisor_proof";
pub const PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID: &str = "runx.payment_rail_supervisor.local.v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentSupervisorSettlementEvidence {
    pub verifier_id: String,
    pub proof_ref: String,
    pub rail: String,
    pub counterparty: String,
    pub amount_minor: u64,
    pub currency: String,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_admission_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub money_movement_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel_token_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof_locator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settlement_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_event_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentSupervisorProof {
    pub verifier_id: String,
    pub proof_ref: String,
    pub rail: String,
    pub counterparty: String,
    pub amount_minor: u64,
    pub currency: String,
    pub idempotency_key: String,
    pub spend_capability_ref: String,
    pub act_id: String,
    pub receipt_ref: String,
    pub receipt_digest: String,
    pub evidence_digest: String,
}

#[derive(Clone, Copy, Debug)]
pub struct PaymentSupervisorVerificationInput<'a> {
    pub outputs: &'a JsonObject,
    pub metadata: &'a JsonObject,
    pub receipt: &'a Receipt,
    pub rail: &'a str,
    pub counterparty: &'a str,
    pub amount_minor: u64,
    pub currency: &'a str,
    pub idempotency_key: &'a str,
    pub spend_capability_ref: &'a str,
    pub act_id: &'a str,
}

#[derive(Clone, Copy, Debug)]
pub struct PaymentSupervisorProofMatch<'a> {
    pub proof_ref: &'a str,
    pub rail: &'a str,
    pub counterparty: &'a str,
    pub amount_minor: u64,
    pub currency: &'a str,
    pub idempotency_key: &'a str,
    pub spend_capability_ref: &'a str,
    pub act_id: &'a str,
    pub receipt_ref: &'a str,
    pub receipt_digest: &'a str,
}

// Function rationale: finality supervisor evidence is one
// flat wire payload assembled from a strongly typed settlement record.
pub fn payment_finality_supervisor_evidence_payload(
    evidence: &PaymentSupervisorSettlementEvidence,
) -> JsonObject {
    let mut payload = JsonObject::new();
    payload.insert(
        "verifier_id".to_owned(),
        JsonValue::String(evidence.verifier_id.clone()),
    );
    payload.insert(
        "proof_ref".to_owned(),
        JsonValue::String(evidence.proof_ref.clone()),
    );
    payload.insert("rail".to_owned(), JsonValue::String(evidence.rail.clone()));
    payload.insert(
        "counterparty".to_owned(),
        JsonValue::String(evidence.counterparty.clone()),
    );
    payload.insert(
        "amount_minor".to_owned(),
        JsonValue::Number(JsonNumber::U64(evidence.amount_minor)),
    );
    payload.insert(
        "currency".to_owned(),
        JsonValue::String(evidence.currency.clone()),
    );
    payload.insert(
        "idempotency_key".to_owned(),
        JsonValue::String(evidence.idempotency_key.clone()),
    );
    insert_optional_payload_string(
        &mut payload,
        "payment_admission_id",
        evidence.payment_admission_id.clone(),
    );
    insert_optional_payload_string(
        &mut payload,
        "money_movement_id",
        evidence.money_movement_id.clone(),
    );
    insert_optional_payload_string(
        &mut payload,
        "kernel_token_digest",
        evidence.kernel_token_digest.clone(),
    );
    insert_optional_payload_string(
        &mut payload,
        "proof_locator",
        evidence.proof_locator.clone(),
    );
    insert_optional_payload_string(&mut payload, "proof_status", evidence.proof_status.clone());
    insert_optional_payload_string(
        &mut payload,
        "settlement_status",
        evidence.settlement_status.clone(),
    );
    insert_optional_payload_string(
        &mut payload,
        "provider_event_ref",
        evidence.provider_event_ref.clone(),
    );
    payload
}

pub fn payment_supervisor_evidence_from_payload(
    payload: &JsonObject,
) -> Result<PaymentSupervisorSettlementEvidence, PaymentSupervisorError> {
    Ok(PaymentSupervisorSettlementEvidence {
        verifier_id: payload_string(payload, "verifier_id")?.to_owned(),
        proof_ref: payload_string(payload, "proof_ref")?.to_owned(),
        rail: payload_string(payload, "rail")?.to_owned(),
        counterparty: payload_string(payload, "counterparty")?.to_owned(),
        amount_minor: payload_u64(payload, "amount_minor")?,
        currency: payload_string(payload, "currency")?.to_owned(),
        idempotency_key: payload_string(payload, "idempotency_key")?.to_owned(),
        payment_admission_id: payload_optional_string(payload, "payment_admission_id")?
            .map(str::to_owned),
        money_movement_id: payload_optional_string(payload, "money_movement_id")?
            .map(str::to_owned),
        kernel_token_digest: payload_optional_string(payload, "kernel_token_digest")?
            .map(str::to_owned),
        proof_locator: payload_optional_string(payload, "proof_locator")?.map(str::to_owned),
        proof_status: payload_optional_string(payload, "proof_status")?.map(str::to_owned),
        settlement_status: payload_optional_string(payload, "settlement_status")?
            .map(str::to_owned),
        provider_event_ref: payload_optional_string(payload, "provider_event_ref")?
            .map(str::to_owned),
    })
}

fn insert_optional_payload_string(
    payload: &mut JsonObject,
    field: &'static str,
    value: Option<String>,
) {
    if let Some(value) = value {
        payload.insert(field.to_owned(), JsonValue::String(value));
    }
}

fn payload_string<'a>(
    payload: &'a JsonObject,
    field: &'static str,
) -> Result<&'a str, PaymentSupervisorError> {
    match payload.get(field) {
        Some(JsonValue::String(value)) => Ok(value),
        Some(value) => Err(invalid_payload(field, value, "string")),
        None => Err(missing_payload(field)),
    }
}

fn payload_optional_string<'a>(
    payload: &'a JsonObject,
    field: &'static str,
) -> Result<Option<&'a str>, PaymentSupervisorError> {
    match payload.get(field) {
        Some(JsonValue::String(value)) => Ok(Some(value)),
        Some(JsonValue::Null) | None => Ok(None),
        Some(value) => Err(invalid_payload(field, value, "string")),
    }
}

fn payload_u64(payload: &JsonObject, field: &'static str) -> Result<u64, PaymentSupervisorError> {
    match payload.get(field) {
        Some(JsonValue::Number(JsonNumber::U64(value))) => Ok(*value),
        Some(value @ JsonValue::Number(JsonNumber::I64(number))) => {
            u64::try_from(*number).map_err(|_| invalid_payload(field, value, "unsigned integer"))
        }
        Some(value) => Err(invalid_payload(field, value, "unsigned integer")),
        None => Err(missing_payload(field)),
    }
}

fn missing_payload(field: &'static str) -> PaymentSupervisorError {
    PaymentSupervisorError::InvalidSupervisorEvidence {
        message: format!("payment supervisor payload is missing {field}"),
    }
}

fn invalid_payload(
    field: &'static str,
    value: &JsonValue,
    expected: &'static str,
) -> PaymentSupervisorError {
    PaymentSupervisorError::InvalidSupervisorEvidence {
        message: format!(
            "payment supervisor payload field {field} must be {expected}, got {}",
            json_value_kind(value)
        ),
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PaymentSupervisorError {
    #[error("payment rail supervisor is not configured")]
    SupervisorUnavailable,
    #[error("payment rail packet is required for supervisor proof")]
    MissingRailPacket,
    #[error("payment rail result is required for supervisor proof")]
    MissingRailResult,
    #[error("payment rail proof claim is required for supervisor proof")]
    MissingRailProofClaim,
    #[error("payment rail supervisor evidence is missing")]
    MissingSupervisorEvidence,
    #[error("payment rail supervisor evidence is invalid: {message}")]
    InvalidSupervisorEvidence { message: String },
    #[error("payment rail supervisor proof is invalid: {message}")]
    InvalidSupervisorProof { message: String },
    #[error("payment rail supervisor metadata serialization failed: {message}")]
    MetadataSerialization { message: String },
    #[error("payment rail result status {status:?} is not fulfilled")]
    SettlementNotFulfilled { status: Option<String> },
    #[error(
        "payment rail supervisor proof field {field} mismatch: expected {expected}, got {actual}"
    )]
    FieldMismatch {
        field: &'static str,
        expected: String,
        actual: String,
    },
    #[error("payment receipt is missing act {act_id}")]
    MissingReceiptAct { act_id: String },
    #[error("payment receipt act {act_id} is missing typed rail proof {proof_ref}")]
    MissingReceiptRailProof { act_id: String, proof_ref: String },
    #[error("payment rail packet is invalid: {message}")]
    InvalidRailPacket { message: String },
}

impl From<PaymentPacketError> for PaymentSupervisorError {
    fn from(error: PaymentPacketError) -> Self {
        Self::InvalidRailPacket {
            message: error.to_string(),
        }
    }
}

pub fn verify_payment_rail_supervisor_proof(
    input: PaymentSupervisorVerificationInput<'_>,
) -> Result<PaymentSupervisorProof, PaymentSupervisorError> {
    let packet = read_effect_evidence_packet(input.outputs)?
        .ok_or(PaymentSupervisorError::MissingRailPacket)?;
    let result = packet
        .result
        .as_ref()
        .ok_or(PaymentSupervisorError::MissingRailResult)?;
    validate_skill_settlement_claim(result, &input)?;
    let claim = packet
        .proof
        .as_ref()
        .ok_or(PaymentSupervisorError::MissingRailProofClaim)?;
    expect_field(
        "rail_proof.idempotency_key",
        input.idempotency_key,
        &claim.idempotency_key,
    )?;
    validate_receipt_binding(
        input.receipt,
        input.act_id,
        &claim.proof_ref,
        input.idempotency_key,
    )?;

    let evidence = payment_supervisor_evidence_from_metadata(input.metadata)?
        .ok_or(PaymentSupervisorError::MissingSupervisorEvidence)?;
    build_payment_supervisor_proof(
        &evidence,
        PaymentSupervisorProofMatch {
            proof_ref: &claim.proof_ref,
            rail: input.rail,
            counterparty: input.counterparty,
            amount_minor: input.amount_minor,
            currency: input.currency,
            idempotency_key: input.idempotency_key,
            spend_capability_ref: input.spend_capability_ref,
            act_id: input.act_id,
            receipt_ref: &input.receipt.id,
            receipt_digest: &input.receipt.digest,
        },
    )
}

pub fn build_payment_supervisor_proof(
    evidence: &PaymentSupervisorSettlementEvidence,
    expected: PaymentSupervisorProofMatch<'_>,
) -> Result<PaymentSupervisorProof, PaymentSupervisorError> {
    validate_supervisor_evidence(evidence, expected)?;
    let evidence_digest = supervisor_evidence_digest(evidence, expected)?;
    Ok(PaymentSupervisorProof {
        verifier_id: evidence.verifier_id.clone(),
        proof_ref: evidence.proof_ref.clone(),
        rail: evidence.rail.clone(),
        counterparty: evidence.counterparty.clone(),
        amount_minor: evidence.amount_minor,
        currency: evidence.currency.clone(),
        idempotency_key: evidence.idempotency_key.clone(),
        spend_capability_ref: expected.spend_capability_ref.to_owned(),
        act_id: expected.act_id.to_owned(),
        receipt_ref: expected.receipt_ref.to_owned(),
        receipt_digest: expected.receipt_digest.to_owned(),
        evidence_digest,
    })
}

pub fn validate_payment_supervisor_proof(
    proof: &PaymentSupervisorProof,
    expected: PaymentSupervisorProofMatch<'_>,
) -> Result<(), PaymentSupervisorError> {
    expect_field(
        "verifier_id",
        PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID,
        &proof.verifier_id,
    )?;
    expect_field("proof_ref", expected.proof_ref, &proof.proof_ref)?;
    expect_field("rail", expected.rail, &proof.rail)?;
    expect_field("counterparty", expected.counterparty, &proof.counterparty)?;
    expect_u64("amount_minor", expected.amount_minor, proof.amount_minor)?;
    expect_field("currency", expected.currency, &proof.currency)?;
    expect_field(
        "idempotency_key",
        expected.idempotency_key,
        &proof.idempotency_key,
    )?;
    expect_field(
        "spend_capability_ref",
        expected.spend_capability_ref,
        &proof.spend_capability_ref,
    )?;
    expect_field("act_id", expected.act_id, &proof.act_id)?;
    expect_field("receipt_ref", expected.receipt_ref, &proof.receipt_ref)?;
    expect_field(
        "receipt_digest",
        expected.receipt_digest,
        &proof.receipt_digest,
    )?;
    if !proof.evidence_digest.starts_with("sha256:") {
        return Err(PaymentSupervisorError::InvalidSupervisorProof {
            message: "evidence_digest must be a sha256 digest".to_owned(),
        });
    }
    Ok(())
}

pub fn payment_supervisor_evidence_from_metadata(
    metadata: &JsonObject,
) -> Result<Option<PaymentSupervisorSettlementEvidence>, PaymentSupervisorError> {
    let Some(value) = metadata.get(PAYMENT_RAIL_SUPERVISOR_EVIDENCE_METADATA) else {
        return Ok(None);
    };
    decode_json_value(value).map(Some).map_err(|source| {
        PaymentSupervisorError::InvalidSupervisorEvidence {
            message: source.to_string(),
        }
    })
}

pub fn payment_supervisor_proof_from_metadata(
    metadata: &JsonObject,
) -> Result<Option<PaymentSupervisorProof>, PaymentSupervisorError> {
    let Some(value) = metadata.get(PAYMENT_RAIL_SUPERVISOR_PROOF_METADATA) else {
        return Ok(None);
    };
    decode_json_value(value).map(Some).map_err(|source| {
        PaymentSupervisorError::InvalidSupervisorProof {
            message: source.to_string(),
        }
    })
}

pub fn insert_payment_supervisor_proof_metadata(
    metadata: &mut JsonObject,
    proof: &PaymentSupervisorProof,
) -> Result<(), PaymentSupervisorError> {
    metadata.insert(
        PAYMENT_RAIL_SUPERVISOR_PROOF_METADATA.to_owned(),
        payment_supervisor_proof_metadata_value(proof)?,
    );
    Ok(())
}

pub fn payment_supervisor_evidence_metadata_value(
    evidence: &PaymentSupervisorSettlementEvidence,
) -> Result<JsonValue, PaymentSupervisorError> {
    encode_json_value(evidence)
}

pub fn payment_supervisor_evidence_reference(
    evidence: &PaymentSupervisorSettlementEvidence,
) -> Reference {
    Reference {
        uri: evidence.proof_ref.clone().into(),
        reference_type: ReferenceType::Verification,
        provider: None,
        locator: Some(evidence.idempotency_key.clone().into()),
        label: Some("payment rail supervisor proof".to_owned().into()),
        observed_at: None,
        proof_kind: Some(ProofKind::EffectEvidence),
    }
}

pub fn payment_supervisor_proof_reference(proof: &PaymentSupervisorProof) -> Reference {
    Reference {
        uri: proof.proof_ref.clone().into(),
        reference_type: ReferenceType::Verification,
        provider: None,
        locator: Some(proof.idempotency_key.clone().into()),
        label: Some("payment rail supervisor proof".to_owned().into()),
        observed_at: None,
        proof_kind: Some(ProofKind::EffectEvidence),
    }
}

pub fn payment_supervisor_proof_metadata_value(
    proof: &PaymentSupervisorProof,
) -> Result<JsonValue, PaymentSupervisorError> {
    encode_json_value(proof)
}

pub fn receipt_act_has_payment_rail_proof(
    receipt: &Receipt,
    act_id: &str,
    proof_ref: &str,
    idempotency_key: &str,
) -> bool {
    receipt.acts.iter().any(|act| {
        act.id == act_id
            && act
                .criterion_bindings
                .iter()
                .flat_map(|criterion| criterion.verification_refs.iter())
                .any(|reference| {
                    is_matching_payment_rail_ref(reference, proof_ref, idempotency_key)
                })
    })
}

fn validate_skill_settlement_claim(
    result: &PaymentRailResult,
    input: &PaymentSupervisorVerificationInput<'_>,
) -> Result<(), PaymentSupervisorError> {
    if result.status.as_deref() != Some("fulfilled") {
        return Err(PaymentSupervisorError::SettlementNotFulfilled {
            status: result.status.clone(),
        });
    }
    if let Some(rail) = result.rail.as_deref() {
        expect_field("rail_result.rail", input.rail, rail)?;
    }
    if let Some(amount_minor) = result.amount_minor {
        expect_u64("rail_result.amount_minor", input.amount_minor, amount_minor)?;
    }
    if let Some(currency) = result.currency.as_deref() {
        expect_field("rail_result.currency", input.currency, currency)?;
    }
    if let Some(counterparty) = result.counterparty.as_deref() {
        expect_field("rail_result.counterparty", input.counterparty, counterparty)?;
    }
    Ok(())
}

fn validate_supervisor_evidence(
    evidence: &PaymentSupervisorSettlementEvidence,
    expected: PaymentSupervisorProofMatch<'_>,
) -> Result<(), PaymentSupervisorError> {
    expect_field(
        "verifier_id",
        PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID,
        &evidence.verifier_id,
    )?;
    if evidence
        .settlement_status
        .as_deref()
        .is_some_and(|status| status != "fulfilled")
    {
        return Err(PaymentSupervisorError::SettlementNotFulfilled {
            status: evidence.settlement_status.clone(),
        });
    }
    expect_field("proof_ref", expected.proof_ref, &evidence.proof_ref)?;
    expect_field("rail", expected.rail, &evidence.rail)?;
    expect_field(
        "counterparty",
        expected.counterparty,
        &evidence.counterparty,
    )?;
    expect_u64("amount_minor", expected.amount_minor, evidence.amount_minor)?;
    expect_field("currency", expected.currency, &evidence.currency)?;
    expect_field(
        "idempotency_key",
        expected.idempotency_key,
        &evidence.idempotency_key,
    )
}

fn validate_receipt_binding(
    receipt: &Receipt,
    act_id: &str,
    proof_ref: &str,
    idempotency_key: &str,
) -> Result<(), PaymentSupervisorError> {
    if !receipt.acts.iter().any(|act| act.id == act_id) {
        return Err(PaymentSupervisorError::MissingReceiptAct {
            act_id: act_id.to_owned(),
        });
    }
    if receipt_act_has_payment_rail_proof(receipt, act_id, proof_ref, idempotency_key) {
        Ok(())
    } else {
        Err(PaymentSupervisorError::MissingReceiptRailProof {
            act_id: act_id.to_owned(),
            proof_ref: proof_ref.to_owned(),
        })
    }
}

/// Typed payment-rail proof predicate. Matching relies on the typed
/// `proof_kind`, never on human-readable label text.
pub(crate) fn is_payment_rail_proof_ref(reference: &Reference) -> bool {
    reference.reference_type == ReferenceType::Verification
        && reference.proof_kind.as_ref() == Some(&ProofKind::EffectEvidence)
}

fn is_matching_payment_rail_ref(
    reference: &Reference,
    proof_ref: &str,
    idempotency_key: &str,
) -> bool {
    is_payment_rail_proof_ref(reference)
        && reference.uri == proof_ref
        && reference.locator.as_deref() == Some(idempotency_key)
}

fn expect_field(
    field: &'static str,
    expected: &str,
    actual: &str,
) -> Result<(), PaymentSupervisorError> {
    if expected == actual {
        Ok(())
    } else {
        Err(PaymentSupervisorError::FieldMismatch {
            field,
            expected: expected.to_owned(),
            actual: actual.to_owned(),
        })
    }
}

fn expect_u64(
    field: &'static str,
    expected: u64,
    actual: u64,
) -> Result<(), PaymentSupervisorError> {
    if expected == actual {
        Ok(())
    } else {
        Err(PaymentSupervisorError::FieldMismatch {
            field,
            expected: expected.to_string(),
            actual: actual.to_string(),
        })
    }
}

fn supervisor_evidence_digest(
    evidence: &PaymentSupervisorSettlementEvidence,
    expected: PaymentSupervisorProofMatch<'_>,
) -> Result<String, PaymentSupervisorError> {
    #[derive(Serialize)]
    struct DigestInput<'a> {
        evidence: &'a PaymentSupervisorSettlementEvidence,
        spend_capability_ref: &'a str,
        act_id: &'a str,
        receipt_ref: &'a str,
        receipt_digest: &'a str,
    }

    let bytes = serde_json::to_vec(&DigestInput {
        evidence,
        spend_capability_ref: expected.spend_capability_ref,
        act_id: expected.act_id,
        receipt_ref: expected.receipt_ref,
        receipt_digest: expected.receipt_digest,
    })
    .map_err(|source| PaymentSupervisorError::MetadataSerialization {
        message: source.to_string(),
    })?;
    Ok(sha256_prefixed(&bytes))
}

fn decode_json_value<T>(value: &JsonValue) -> Result<T, serde_json::Error>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(serde_json::to_value(value)?)
}

fn encode_json_value<T>(value: &T) -> Result<JsonValue, PaymentSupervisorError>
where
    T: Serialize,
{
    let value = serde_json::to_value(value).map_err(|source| {
        PaymentSupervisorError::MetadataSerialization {
            message: source.to_string(),
        }
    })?;
    serde_json::from_value(value).map_err(|source| PaymentSupervisorError::MetadataSerialization {
        message: source.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use runx_contracts::{ProofKind, Reference, ReferenceType};

    use super::is_payment_rail_proof_ref;

    #[test]
    fn payment_rail_proof_matching_uses_typed_kind_not_label() {
        let typed_ref = Reference {
            reference_type: ReferenceType::Verification,
            uri: "receipt-proof:mock:typed".to_owned().into(),
            provider: None,
            locator: None,
            label: Some("human display text".to_owned().into()),
            observed_at: None,
            proof_kind: Some(ProofKind::EffectEvidence),
        };
        let label_only_ref = Reference {
            reference_type: ReferenceType::Verification,
            uri: "receipt-proof:mock:label-only".to_owned().into(),
            provider: None,
            locator: None,
            label: Some("payment rail proof".to_owned().into()),
            observed_at: None,
            proof_kind: None,
        };

        assert!(is_payment_rail_proof_ref(&typed_ref));
        assert!(!is_payment_rail_proof_ref(&label_only_ref));
    }
}

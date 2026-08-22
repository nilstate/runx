//! Public, rail-neutral paid-invocation contracts.
//!
//! This module owns inert V1 wire values only. Payment admission, settlement,
//! persistence, execution, recovery, and provider SDKs belong to hosted
//! implementations behind this boundary.

use std::collections::BTreeSet;
use std::num::NonZeroU64;

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::schema::{
    BoundedString, Identity, IsoDateTime, NonEmptyString, Property, RunxSchema,
    any_of_with_identity, const_string, object_schema,
};
use crate::{JsonValue, RECEIPT_CANONICALIZATION, Reference, ReferenceType};

pub const PAID_INVOCATION_SCHEMA: &str = "runx.payment.paid_invocation.v1";
pub const OFFER_REVISION_REF_SCHEMA: &str = "runx.payment.offer_revision_ref.v1";
pub const PARENT_INVOCATION_BINDING_SCHEMA: &str = "runx.payment.parent_invocation_binding.v1";
pub const QUOTE_PAID_INVOCATION_REQUEST_SCHEMA: &str =
    "runx.payment.quote_paid_invocation.request.v1";
pub const QUOTE_PAID_INVOCATION_RESULT_SCHEMA: &str =
    "runx.payment.quote_paid_invocation.result.v1";
pub const EXECUTE_PAID_INVOCATION_REQUEST_SCHEMA: &str =
    "runx.payment.execute_paid_invocation.request.v1";
pub const EXECUTE_PAID_INVOCATION_RESULT_SCHEMA: &str =
    "runx.payment.execute_paid_invocation.result.v1";
pub const GET_PAID_INVOCATION_REQUEST_SCHEMA: &str = "runx.payment.get_paid_invocation.request.v1";
pub const GET_PAID_INVOCATION_RESULT_SCHEMA: &str = "runx.payment.get_paid_invocation.result.v1";
pub const CANCEL_PAID_INVOCATION_REQUEST_SCHEMA: &str =
    "runx.payment.cancel_paid_invocation.request.v1";
pub const CANCEL_PAID_INVOCATION_RESULT_SCHEMA: &str =
    "runx.payment.cancel_paid_invocation.result.v1";

pub const QUOTE_PAID_INVOCATION: &str = "QuotePaidInvocation";
pub const EXECUTE_PAID_INVOCATION: &str = "ExecutePaidInvocation";
pub const GET_PAID_INVOCATION: &str = "GetPaidInvocation";
pub const CANCEL_PAID_INVOCATION: &str = "CancelPaidInvocation";

/// A lowercase, prefixed SHA-256 digest.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(String);

impl Sha256Digest {
    pub fn new(value: impl Into<String>) -> Option<Self> {
        let value = value.into();
        let hex = value.strip_prefix("sha256:")?;
        (hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        .then_some(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).ok_or_else(|| {
            de::Error::custom("digest must be sha256: followed by 64 lowercase hex characters")
        })
    }
}

impl RunxSchema for Sha256Digest {
    fn json_schema() -> Value {
        json!({
            "type": "string",
            "pattern": "^sha256:[0-9a-f]{64}$",
        })
    }
}

/// An ISO 4217-style uppercase three-letter currency code.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct CurrencyCode(String);

impl CurrencyCode {
    pub fn new(value: impl Into<String>) -> Option<Self> {
        let value = value.into();
        (value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase()))
            .then_some(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for CurrencyCode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value)
            .ok_or_else(|| de::Error::custom("currency must be three uppercase ASCII letters"))
    }
}

impl RunxSchema for CurrencyCode {
    fn json_schema() -> Value {
        json!({ "type": "string", "pattern": "^[A-Z]{3}$" })
    }
}

/// A bounded, provider-neutral settlement-family identifier.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct SettlementFamily(String);

impl SettlementFamily {
    pub fn new(value: impl Into<String>) -> Option<Self> {
        let value = value.into();
        let valid = !value.is_empty()
            && value.len() <= 64
            && value.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
            });
        valid.then_some(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SettlementFamily {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).ok_or_else(|| de::Error::custom("invalid settlement family"))
    }
}

impl RunxSchema for SettlementFamily {
    fn json_schema() -> Value {
        json!({
            "type": "string",
            "minLength": 1,
            "maxLength": 64,
            "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$",
        })
    }
}

/// One to sixteen unique settlement-family identifiers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SettlementFamilies(Vec<SettlementFamily>);

impl SettlementFamilies {
    pub fn new(value: Vec<SettlementFamily>) -> Option<Self> {
        let unique = value.iter().collect::<BTreeSet<_>>().len() == value.len();
        (unique && (1..=16).contains(&value.len())).then_some(Self(value))
    }

    pub fn as_slice(&self) -> &[SettlementFamily] {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SettlementFamilies {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Vec::<SettlementFamily>::deserialize(deserializer)?;
        Self::new(value).ok_or_else(|| {
            de::Error::custom("settlement families must contain 1..=16 unique values")
        })
    }
}

impl RunxSchema for SettlementFamilies {
    fn json_schema() -> Value {
        json!({
            "type": "array",
            "items": SettlementFamily::json_schema(),
            "minItems": 1,
            "maxItems": 16,
            "uniqueItems": true,
        })
    }
}

/// A reference proven to identify a principal at deserialization time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct PrincipalReference(Reference);

impl PrincipalReference {
    pub fn new(value: Reference) -> Option<Self> {
        (value.reference_type == ReferenceType::Principal).then_some(Self(value))
    }

    pub fn as_reference(&self) -> &Reference {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PrincipalReference {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Reference::deserialize(deserializer)?;
        Self::new(value).ok_or_else(|| de::Error::custom("reference type must be principal"))
    }
}

impl RunxSchema for PrincipalReference {
    fn json_schema() -> Value {
        let mut schema = Reference::json_schema();
        if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
            properties.insert("type".to_owned(), const_string("principal"));
        }
        schema
    }
}

/// An opaque reference to payment evidence or a hosted payment record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PaymentReference(Reference);

impl PaymentReference {
    pub fn new(value: Reference) -> Self {
        Self(value)
    }

    pub fn as_reference(&self) -> &Reference {
        &self.0
    }
}

impl RunxSchema for PaymentReference {
    fn json_schema() -> Value {
        Reference::json_schema()
    }
}

/// The sole V1 canonicalization identifier for digest-bound inputs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum PaidInvocationCanonicalizerVersion {
    #[serde(rename = "runx.receipt.c14n.v1")]
    ReceiptC14nV1,
}

impl PaidInvocationCanonicalizerVersion {
    pub const fn as_str(self) -> &'static str {
        RECEIPT_CANONICALIZATION
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentIdempotencyBinding {
    pub key: NonEmptyString,
    pub binding_digest: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.payment.offer_revision_ref.v1")]
pub struct OfferRevisionRef {
    pub offer_id: NonEmptyString,
    pub revision: NonEmptyString,
    pub revision_digest: Sha256Digest,
    pub input_schema_digest: Sha256Digest,
    pub output_schema_digest: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.payment.parent_invocation_binding.v1")]
pub struct ParentInvocationBinding {
    pub invocation_id: NonEmptyString,
    pub execution_digest: Sha256Digest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaidInvocationPaymentState {
    Unpaid,
    Settling,
    Settled,
    Refunded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaidInvocationExecutionState {
    Unstarted,
    Queued,
    Running,
    WaitingExternal,
    Cancelling,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaidInvocationOutcomeGate {
    Open,
    FulfilmentWon,
    RefundWon,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.payment.paid_invocation.v1")]
pub struct PaidInvocation {
    pub invocation_id: NonEmptyString,
    pub principal: PrincipalReference,
    pub counterparty: PaymentReference,
    pub offer_revision: OfferRevisionRef,
    pub input_digest: Sha256Digest,
    pub canonicalizer_version: PaidInvocationCanonicalizerVersion,
    pub amount_minor: NonZeroU64,
    pub currency: CurrencyCode,
    pub accepted_settlement_families: SettlementFamilies,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settlement_family: Option<SettlementFamily>,
    pub idempotency: PaymentIdempotencyBinding,
    pub expires_at: IsoDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<ParentInvocationBinding>,
    pub payment_state: PaidInvocationPaymentState,
    pub execution_state: PaidInvocationExecutionState,
    pub outcome_gate: PaidInvocationOutcomeGate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_ref: Option<Reference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_ref: Option<PaymentReference>,
    pub created_at: IsoDateTime,
    pub updated_at: IsoDateTime,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaidInvocationPaymentChallenge {
    pub settlement_family: SettlementFamily,
    pub protocol_version: NonEmptyString,
    pub media_type: NonEmptyString,
    pub payload: JsonValue,
    pub payload_digest: Sha256Digest,
    pub quote_ref: Reference,
    pub quote_expires_at: IsoDateTime,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaidInvocationRefusalCode {
    OfferUnavailable,
    QuoteExpired,
    TermsChanged,
    ReplayConflict,
    PaymentNotAuthorized,
    CapacityUnavailable,
    NotFound,
    CancellationNotAvailable,
}

pub type PaidInvocationRefusalReason = BoundedString<512>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.payment.quote_paid_invocation.request.v1")]
pub struct QuotePaidInvocationRequest {
    pub principal: PrincipalReference,
    pub counterparty: PaymentReference,
    pub offer_revision: OfferRevisionRef,
    pub input_digest: Sha256Digest,
    pub canonicalizer_version: PaidInvocationCanonicalizerVersion,
    pub amount_minor: NonZeroU64,
    pub currency: CurrencyCode,
    pub accepted_settlement_families: SettlementFamilies,
    pub idempotency: PaymentIdempotencyBinding,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<ParentInvocationBinding>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuotePaidInvocationAdmission {
    pub invocation: PaidInvocation,
    pub challenge: PaidInvocationPaymentChallenge,
}

impl RunxSchema for QuotePaidInvocationAdmission {
    fn json_schema() -> Value {
        object_schema(
            vec![
                Property::new("invocation", PaidInvocation::json_schema(), true),
                Property::new(
                    "challenge",
                    json!({ "$ref": "#/$defs/PaidInvocationPaymentChallenge" }),
                    true,
                ),
            ],
            true,
            None,
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum QuotePaidInvocationResult {
    Admitted {
        value: Box<QuotePaidInvocationAdmission>,
    },
    Refused {
        code: PaidInvocationRefusalCode,
        reason: PaidInvocationRefusalReason,
    },
}

impl RunxSchema for QuotePaidInvocationResult {
    fn json_schema() -> Value {
        let admitted = object_schema(
            vec![
                Property::new("status", const_string("admitted"), true),
                Property::new("value", QuotePaidInvocationAdmission::json_schema(), true),
            ],
            true,
            None,
        );
        let refused = refusal_variant_schema();
        let mut schema = any_of_with_identity(
            vec![admitted, refused],
            Some(Identity::Runx {
                logical: QUOTE_PAID_INVOCATION_RESULT_SCHEMA,
                url: None,
            }),
        );
        if let Some(object) = schema.as_object_mut() {
            object.insert(
                "$defs".to_owned(),
                json!({
                    "PaidInvocationPaymentChallenge": PaidInvocationPaymentChallenge::json_schema()
                }),
            );
        }
        schema
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.payment.execute_paid_invocation.request.v1")]
pub struct ExecutePaidInvocationRequest {
    pub invocation_id: NonEmptyString,
    pub settlement_family: SettlementFamily,
    pub payment_ref: PaymentReference,
    pub idempotency: PaymentIdempotencyBinding,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaidInvocationAdmission {
    pub invocation: PaidInvocation,
}

macro_rules! paid_invocation_result {
    ($name:ident, $schema_id:literal) => {
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
        #[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
        #[runx_schema(id = $schema_id)]
        pub enum $name {
            Admitted {
                value: Box<PaidInvocationAdmission>,
            },
            Refused {
                code: PaidInvocationRefusalCode,
                reason: PaidInvocationRefusalReason,
            },
        }
    };
}

paid_invocation_result!(
    ExecutePaidInvocationResult,
    "runx.payment.execute_paid_invocation.result.v1"
);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.payment.get_paid_invocation.request.v1")]
pub struct GetPaidInvocationRequest {
    pub invocation_id: NonEmptyString,
}

paid_invocation_result!(
    GetPaidInvocationResult,
    "runx.payment.get_paid_invocation.result.v1"
);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.payment.cancel_paid_invocation.request.v1")]
pub struct CancelPaidInvocationRequest {
    pub invocation_id: NonEmptyString,
    pub idempotency: PaymentIdempotencyBinding,
}

paid_invocation_result!(
    CancelPaidInvocationResult,
    "runx.payment.cancel_paid_invocation.result.v1"
);

fn refusal_variant_schema() -> Value {
    object_schema(
        vec![
            Property::new("status", const_string("refused"), true),
            Property::new("code", PaidInvocationRefusalCode::json_schema(), true),
            Property::new("reason", PaidInvocationRefusalReason::json_schema(), true),
        ],
        true,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizer_value_is_bound_to_receipt_constant() {
        assert_eq!(
            PaidInvocationCanonicalizerVersion::ReceiptC14nV1.as_str(),
            RECEIPT_CANONICALIZATION
        );
    }

    #[test]
    fn bounded_values_reject_ambiguous_forms() {
        assert!(Sha256Digest::new(format!("sha256:{}", "a".repeat(64))).is_some());
        assert!(Sha256Digest::new(format!("sha256:{}", "A".repeat(64))).is_none());
        assert!(CurrencyCode::new("USD").is_some());
        assert!(CurrencyCode::new("usd").is_none());
        assert!(SettlementFamily::new("hosted.mock-v1").is_some());
        assert!(SettlementFamily::new("Hosted").is_none());
    }
}

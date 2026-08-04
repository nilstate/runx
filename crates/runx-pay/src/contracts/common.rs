use std::num::NonZeroU64;

use runx_contracts::schema::{BoundedString, BoundedVec, IsoDateTime, NonEmptyString, RunxSchema};
use runx_contracts::{JsonObject, Reference};
use serde::{Deserialize, Deserializer, Serialize};

pub(super) type PaymentReference = BoundedString<256>;
pub(super) type SettlementFamily = BoundedString<64>;
pub(super) type CredentialReference = BoundedString<512>;
pub(super) type SettlementFamilies = BoundedVec<SettlementFamily, 1, 10>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct CurrencyCode(String);

impl<'de> Deserialize<'de> for CurrencyCode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase()) {
            Ok(Self(value))
        } else {
            Err(serde::de::Error::custom(
                "currency must be a three-letter uppercase code",
            ))
        }
    }
}

impl RunxSchema for CurrencyCode {
    fn json_schema() -> serde_json::Value {
        serde_json::json!({ "type": "string", "pattern": "^[A-Z]{3}$" })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[runx_schema(
    id = "runx.payment.signal.v1",
    url = "https://schemas.runx.ai/runx/payment/signal/v1.json"
)]
pub struct PaymentSignal {
    pub amount_minor: NonZeroU64,
    pub currency: CurrencyCode,
    pub counterparty: PaymentReference,
    pub operation: PaymentReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rail: Option<SettlementFamily>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realm: Option<BoundedString<64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub challenge_id: Option<PaymentReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal_type: Option<BoundedString<64>>,
    #[serde(flatten)]
    pub extensions: JsonObject,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(
    id = "runx.payment.tool_call.v1",
    url = "https://schemas.runx.ai/runx/payment/tool-call/v1.json"
)]
pub struct PaymentToolCall {
    pub tool: BoundedString<256>,
    pub arguments: JsonObject,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(
    id = "runx.payment.charge_policy.v1",
    url = "https://schemas.runx.ai/runx/payment/charge-policy/v1.json"
)]
pub struct PaymentChargePolicy {
    pub price_minor: NonZeroU64,
    pub currency: CurrencyCode,
    pub accepted_settlement_families: SettlementFamilies,
    pub counterparty: PaymentReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realm: Option<BoundedString<64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_ref: Option<PaymentReference>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(
    id = "runx.payment.credential_reference.v1",
    url = "https://schemas.runx.ai/runx/payment/credential-reference/v1.json"
)]
pub struct PaymentCredentialReference {
    pub family: SettlementFamily,
    pub credential_ref: CredentialReference,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(
    id = "runx.payment.refund_request.v1",
    url = "https://schemas.runx.ai/runx/payment/refund-request/v1.json"
)]
pub struct PaymentRefundRequest {
    pub amount_minor: NonZeroU64,
    pub reason: BoundedString<256>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_counterparty: Option<PaymentReference>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentFinding {
    pub code: BoundedString<256>,
    pub message: BoundedString<4096>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentReadyDecision {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentIdempotencyBinding {
    pub key: NonEmptyString,
    pub replay_policy: PaymentReplayPolicy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentReplayPolicy {
    RecoverOrRefuseDuplicate,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentProviderStatus {
    NotCalled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentReceiptStatus {
    NotSealed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentForwardingStatus {
    NotForwarded,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentApprovalStatus {
    NotRequested,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(String);

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value.strip_prefix("sha256:").is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            Ok(Self(value))
        } else {
            Err(serde::de::Error::custom("value must be a sha256 digest"))
        }
    }
}

impl RunxSchema for Sha256Digest {
    fn json_schema() -> serde_json::Value {
        serde_json::json!({ "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentSpendCapabilityBinding {
    pub child_harness_ref: Reference,
    pub act_id: String,
    pub reservation_decision_id: String,
    pub idempotency_key: String,
    pub amount_minor: u64,
    pub currency: String,
    pub counterparty: String,
    pub rail: String,
}

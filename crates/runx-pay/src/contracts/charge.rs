use std::num::NonZeroU64;

use runx_contracts::schema::{BoundedString, NonEmptyString, RunxSchema};
use runx_contracts::{AuthorityBounds, AuthorityResourceFamily, AuthorityVerb};
use serde::{Deserialize, Serialize};

use super::common::{
    CredentialReference, CurrencyCode, PaymentApprovalStatus, PaymentFinding,
    PaymentForwardingStatus, PaymentIdempotencyBinding, PaymentProviderStatus,
    PaymentReadyDecision, PaymentReceiptStatus, PaymentReference, SettlementFamily, Sha256Digest,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentChargePrice {
    pub decision: PaymentReadyDecision,
    pub price_id: NonEmptyString,
    pub operation: Option<BoundedString<256>>,
    pub amount_minor: Option<NonZeroU64>,
    pub currency: Option<CurrencyCode>,
    pub settlement_families: Vec<SettlementFamily>,
    pub counterparty: Option<PaymentReference>,
    pub realm: NonEmptyString,
    pub expires_at: Option<runx_contracts::schema::IsoDateTime>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentChargeAuthorityRequest {
    pub resource_family: AuthorityResourceFamily,
    pub verbs: Vec<AuthorityVerb>,
    pub bounds: AuthorityBounds,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentChargePriceEvidence {
    pub source_refs: Vec<NonEmptyString>,
    pub arguments_digest: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentChargePolicyMetadata {
    pub provider_realm: NonEmptyString,
    pub direction: ProviderChargeDirection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderChargeDirection {
    ProviderCharge,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(
    id = "runx.payment.charge_price.v1",
    url = "https://schemas.runx.ai/runx/payment/charge-price/v1.json"
)]
pub struct PaymentChargePricePacket {
    pub charge_price: PaymentChargePrice,
    pub requested_payment_authority: PaymentChargeAuthorityRequest,
    pub price_evidence: PaymentChargePriceEvidence,
    pub policy_metadata: PaymentChargePolicyMetadata,
    pub open_questions: Vec<PaymentFinding>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentEffectRequiredSignal {
    pub signal_type: EffectRequiredSignalType,
    pub challenge_id: NonEmptyString,
    pub amount_minor: Option<NonZeroU64>,
    pub currency: Option<CurrencyCode>,
    pub rail: Option<SettlementFamily>,
    pub counterparty: Option<PaymentReference>,
    pub operation: Option<BoundedString<256>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum EffectRequiredSignalType {
    EffectRequired,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentChargeChallenge {
    pub decision: PaymentReadyDecision,
    pub challenge_id: NonEmptyString,
    pub price_id: NonEmptyString,
    pub required_authority: PaymentChargeAuthorityRequest,
    pub receipt_before_forward_required: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(
    id = "runx.payment.charge_challenge.v1",
    url = "https://schemas.runx.ai/runx/payment/charge-challenge/v1.json"
)]
pub struct PaymentChargeChallengePacket {
    pub effect_required_signal: PaymentEffectRequiredSignal,
    pub charge_challenge: PaymentChargeChallenge,
    pub idempotency: PaymentIdempotencyBinding,
    pub accepted_settlement_families: Vec<SettlementFamily>,
    pub open_questions: Vec<PaymentFinding>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentVerificationDecision {
    ReadyForProviderAdapter,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentChargeVerificationAction {
    pub price_id: NonEmptyString,
    pub challenge_id: NonEmptyString,
    pub settlement_family: Option<SettlementFamily>,
    pub credential_ref: Option<CredentialReference>,
    pub verify_capability_ref: Option<CredentialReference>,
    pub idempotency: PaymentIdempotencyBinding,
    pub decision: PaymentVerificationDecision,
    pub request_digest: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentCredentialBinding {
    pub family: Option<SettlementFamily>,
    pub credential_ref: Option<CredentialReference>,
}

/// Provider-neutral verification request produced by the native charge lane.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(
    id = "runx.payment.charge_verification_request.v1",
    url = "https://schemas.runx.ai/runx/payment/charge-verification-request/v1.json"
)]
pub struct PaymentChargeVerificationRequest {
    pub verification_request: PaymentChargeVerificationAction,
    pub credential_binding: PaymentCredentialBinding,
    pub provider_status: PaymentProviderStatus,
    pub receipt_status: PaymentReceiptStatus,
    pub forwarding_status: PaymentForwardingStatus,
    pub open_questions: Vec<PaymentFinding>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentChargePlanDecision {
    ReadyForProviderVerification,
    Blocked,
}

/// Complete provider-neutral plan produced by the native charge lane.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(
    id = "runx.payment.charge_plan.v1",
    url = "https://schemas.runx.ai/runx/payment/charge-plan/v1.json"
)]
pub struct PaymentChargePlan {
    pub schema: PaymentChargePlanSchema,
    pub decision: PaymentChargePlanDecision,
    pub charge_price: PaymentChargePrice,
    pub charge_challenge: PaymentChargeChallenge,
    pub idempotency: PaymentIdempotencyBinding,
    pub verification_request: PaymentChargeVerificationAction,
    pub credential_binding: PaymentCredentialBinding,
    pub provider_status: PaymentProviderStatus,
    pub receipt_status: PaymentReceiptStatus,
    pub forwarding_status: PaymentForwardingStatus,
    pub approval_status: PaymentApprovalStatus,
    pub runtime_forwarding_enabled: bool,
    pub findings: Vec<PaymentFinding>,
    pub plan_digest: Sha256Digest,
    pub next_action: BoundedString<4096>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum PaymentChargePlanSchema {
    #[serde(rename = "runx.payment.charge_plan.v1")]
    V1,
}

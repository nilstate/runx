use std::num::NonZeroU64;

use runx_contracts::EffectFinalityPhase;
use runx_contracts::schema::{BoundedString, NonEmptyString, RunxSchema};
use serde::{Deserialize, Serialize};

use super::common::{
    CurrencyCode, PaymentApprovalStatus, PaymentFinding, PaymentProviderStatus,
    PaymentReceiptStatus, PaymentReference, SettlementFamily, Sha256Digest,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentRefundPlanDecision {
    ReadyForRefundAdapter,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentOriginalCharge {
    pub receipt_ref: NonEmptyString,
    pub money_movement_id: NonEmptyString,
    pub proof_ref: NonEmptyString,
    pub phase: EffectFinalityPhase,
    pub receipt_proof_digest: Sha256Digest,
    pub refund_history_receipt_refs: Vec<NonEmptyString>,
    pub amount_minor: NonZeroU64,
    pub refunded_minor: u64,
    pub currency: CurrencyCode,
    pub settlement_family: SettlementFamily,
    pub payer_ref: PaymentReference,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentRefundPlanRequest {
    pub amount_minor: NonZeroU64,
    pub reason: Option<BoundedString<256>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentRefundableBounds {
    pub remaining_minor: u64,
    pub currency: CurrencyCode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentRefundAuthorityBinding {
    pub parent_term_id: NonEmptyString,
    pub digest: Sha256Digest,
    pub validation: PaymentRefundAuthorityValidation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentRefundAuthorityValidation {
    NativeRefundAuthority,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentRefundIdempotency {
    pub key: NonEmptyString,
    pub recovery_required: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentRefundAdapterHandoff {
    pub settlement_family: SettlementFamily,
    pub original_receipt_ref: NonEmptyString,
    pub original_money_movement_id: NonEmptyString,
    pub original_proof_ref: NonEmptyString,
    pub amount_minor: NonZeroU64,
    pub currency: CurrencyCode,
    pub counterparty: PaymentReference,
    pub idempotency_key: NonEmptyString,
    pub authority_term_id: NonEmptyString,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentRefundStatus {
    NotStarted,
}

/// Complete provider-neutral plan produced by the native refund lane.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(
    id = "runx.payment.refund_plan.v1",
    url = "https://schemas.runx.ai/runx/payment/refund-plan/v1.json"
)]
pub struct PaymentRefundPlan {
    pub schema: PaymentRefundPlanSchema,
    pub decision: PaymentRefundPlanDecision,
    pub original_charge: PaymentOriginalCharge,
    pub refund_request: PaymentRefundPlanRequest,
    pub settlement_family: SettlementFamily,
    pub refundable_bounds: PaymentRefundableBounds,
    pub authority: PaymentRefundAuthorityBinding,
    pub idempotency: PaymentRefundIdempotency,
    pub adapter_handoff: Option<PaymentRefundAdapterHandoff>,
    pub provider_status: PaymentProviderStatus,
    pub refund_status: PaymentRefundStatus,
    pub approval_status: PaymentApprovalStatus,
    pub receipt_status: PaymentReceiptStatus,
    pub money_moved: bool,
    pub findings: Vec<PaymentFinding>,
    pub plan_digest: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum PaymentRefundPlanSchema {
    #[serde(rename = "runx.payment.refund_plan.v1")]
    V1,
}

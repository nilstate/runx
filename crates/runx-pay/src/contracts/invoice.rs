use std::num::NonZeroU64;

use runx_contracts::schema::{NonEmptyString, RunxSchema};
use runx_contracts::{AuthorityTerm, JsonObject};
use serde::{Deserialize, Serialize};

use super::common::{
    CurrencyCode, PaymentFinding, PaymentReference, PaymentSignal, SettlementFamily, Sha256Digest,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentInvoicePlanDecision {
    ReadyForSpend,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentInvoice {
    pub invoice_ref: NonEmptyString,
    pub amount_minor: NonZeroU64,
    pub currency: CurrencyCode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentInvoicePayee {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub party_ref: Option<PaymentReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settlement_ref: Option<PaymentReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settlement_digest: Option<Sha256Digest>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentInvoiceAuthority {
    pub parent_term_id: NonEmptyString,
    pub validation: PaymentInvoiceAuthorityValidation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentInvoiceAuthorityValidation {
    NativePaymentQuote,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentInvoiceDownstreamInputs {
    pub payment_signal: PaymentSignal,
    pub parent_payment_authority: AuthorityTerm,
    pub rail_profile_ref: PaymentReference,
    pub idempotency_seed: NonEmptyString,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realm: Option<runx_contracts::schema::BoundedString<64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_admission: Option<JsonObject>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentInvoiceDownstream {
    pub skill: PaymentSpendSkill,
    pub runner: runx_contracts::schema::BoundedString<64>,
    pub inputs: PaymentInvoiceDownstreamInputs,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PaymentSpendSkill {
    Spend,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentProviderEffect {
    pub status: PaymentEffectStatus,
    pub money_moved: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentEffectStatus {
    NotStarted,
}

/// Complete provider-neutral plan produced by the native invoice lane.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(
    id = "runx.payment.invoice_settlement_plan.v1",
    url = "https://schemas.runx.ai/runx/payment/invoice-settlement-plan/v1.json"
)]
pub struct PaymentInvoiceSettlementPlan {
    pub schema: PaymentInvoiceSettlementPlanSchema,
    pub decision: PaymentInvoicePlanDecision,
    pub invoice: PaymentInvoice,
    pub payee: PaymentInvoicePayee,
    pub rail: SettlementFamily,
    pub authority: PaymentInvoiceAuthority,
    pub payment_signal: PaymentSignal,
    pub idempotency_seed: NonEmptyString,
    pub downstream: Option<PaymentInvoiceDownstream>,
    pub provider_effect: PaymentProviderEffect,
    pub findings: Vec<PaymentFinding>,
    pub plan_digest: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum PaymentInvoiceSettlementPlanSchema {
    #[serde(rename = "runx.payment.invoice_settlement_plan.v1")]
    V1,
}

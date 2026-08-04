use std::num::NonZeroU64;

use runx_contracts::schema::{IsoDateTime, NonEmptyString, RunxSchema};
use runx_contracts::{AuthoritySubsetProof, AuthorityTerm, Decision, Reference};
use serde::{Deserialize, Serialize};

use super::common::{
    CurrencyCode, PaymentFinding, PaymentReference, PaymentSpendCapabilityBinding,
    SettlementFamilies, Sha256Digest,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentQuote {
    pub quote_id: NonEmptyString,
    pub amount_minor: NonZeroU64,
    pub currency: CurrencyCode,
    pub rails: SettlementFamilies,
    pub counterparty: PaymentReference,
    pub operation: PaymentReference,
    pub realm: Option<runx_contracts::schema::BoundedString<64>>,
    pub observed_at: IsoDateTime,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentChallengeEvidence {
    pub source_refs: Vec<NonEmptyString>,
    pub signal_digest: Sha256Digest,
    pub redactions: Vec<NonEmptyString>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(
    id = "runx.payment.quote.v1",
    url = "https://schemas.runx.ai/runx/payment/quote/v1.json"
)]
pub struct PaymentQuotePacket {
    pub payment_quote: PaymentQuote,
    pub requested_payment_authority: AuthorityTerm,
    pub challenge_evidence: PaymentChallengeEvidence,
    pub risk_notes: Vec<PaymentFinding>,
    pub open_questions: Vec<PaymentFinding>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ReservedPaymentAuthority {
    pub parent_authority: AuthorityTerm,
    pub child_authority: AuthorityTerm,
    pub reservation_decision: Decision,
    pub subset_proof: AuthoritySubsetProof,
    pub child_harness_ref: Reference,
    pub spend_capability_binding: PaymentSpendCapabilityBinding,
    pub consumed_spend_capability_refs: Vec<Reference>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentReservationIdempotency {
    pub key: NonEmptyString,
    pub recovery_required: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaymentReservationApprovalStatus {
    Pending,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentReservationApproval {
    pub required: bool,
    pub status: PaymentReservationApprovalStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(
    id = "runx.payment.reservation.v1",
    url = "https://schemas.runx.ai/runx/payment/reservation/v1.json"
)]
pub struct PaymentReservationPacket {
    pub payment_decision: Decision,
    pub reserved_payment_authority: ReservedPaymentAuthority,
    pub spend_capability_ref: Reference,
    pub idempotency: PaymentReservationIdempotency,
    pub approval: PaymentReservationApproval,
    pub core_requirements: Vec<NonEmptyString>,
    pub open_questions: Vec<PaymentFinding>,
}

use runx_contracts::{AuthoritySubsetProof, AuthorityTerm, Decision, Reference};

use crate::authority::PaymentSpendCapabilityBinding;
use crate::effect_state::{
    EffectIdempotencyKey, EffectPeriodSpendReservation, EffectRunSpendReservation,
};

#[derive(Clone, Debug)]
pub(in crate::effect) struct PaymentAdmissionContext {
    pub(in crate::effect) payment: Option<StepPaymentAuthorityContext>,
}

#[derive(Clone, Debug)]
pub(in crate::effect) struct StepPaymentAuthorityContext {
    pub(in crate::effect) idempotency_key: EffectIdempotencyKey,
    pub(in crate::effect) authority_ref: Reference,
    pub(in crate::effect) spend_capability_ref: Reference,
    pub(in crate::effect) rail: String,
    pub(in crate::effect) counterparty: String,
    pub(in crate::effect) amount_minor: u64,
    pub(in crate::effect) currency: String,
    pub(in crate::effect) run_spend: Option<EffectRunSpendReservation>,
    pub(in crate::effect) period_spend: Option<EffectPeriodSpendReservation>,
    pub(in crate::effect) settlement_identity: Option<PaymentSettlementIdentity>,
}

#[derive(Clone, Debug)]
pub(in crate::effect) struct PaymentSettlementIdentity {
    pub(in crate::effect) payment_admission_id: String,
    pub(in crate::effect) money_movement_id: String,
    pub(in crate::effect) kernel_token_digest: String,
}

#[derive(Clone, Debug)]
pub(in crate::effect) struct PaymentReplayContext {
    pub(in crate::effect) rail_proof_ref: String,
    pub(in crate::effect) idempotency_key: EffectIdempotencyKey,
    pub(in crate::effect) authority_ref: Reference,
    pub(in crate::effect) spend_capability_ref: Reference,
    pub(in crate::effect) rail: String,
    pub(in crate::effect) counterparty: String,
    pub(in crate::effect) amount_minor: u64,
    pub(in crate::effect) currency: String,
    pub(in crate::effect) act_id: String,
    pub(in crate::effect) supervisor_proof: crate::supervisor::PaymentSupervisorProof,
}

#[derive(Clone, Debug)]
pub(in crate::effect) struct OwnedStepAuthoritySubmission {
    pub(in crate::effect) parent_authority: AuthorityTerm,
    pub(in crate::effect) child_authority: AuthorityTerm,
    pub(in crate::effect) reservation_decision: Option<Decision>,
    pub(in crate::effect) subset_proof: Option<AuthoritySubsetProof>,
    pub(in crate::effect) child_harness_ref: Reference,
    pub(in crate::effect) spend_capability_binding: Option<PaymentSpendCapabilityBinding>,
    pub(in crate::effect) consumed_spend_capability_refs: Vec<Reference>,
    pub(in crate::effect) spend_capability_ref: Option<Reference>,
    pub(in crate::effect) idempotency_key: Option<String>,
}

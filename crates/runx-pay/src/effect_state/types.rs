use std::collections::BTreeMap;

use runx_contracts::{EffectFinalityPhase, JsonObject};
use serde::{Deserialize, Serialize};

use crate::supervisor::PaymentSupervisorProof;
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectIdempotencyKey {
    pub rail: String,
    pub counterparty: String,
    pub key: String,
}

impl EffectIdempotencyKey {
    pub fn new(
        rail: impl Into<String>,
        counterparty: impl Into<String>,
        key: impl Into<String>,
    ) -> Self {
        Self {
            rail: rail.into(),
            counterparty: counterparty.into(),
            key: key.into(),
        }
    }
}

impl EffectIdempotencyKey {
    pub(super) fn index_key(&self) -> String {
        format!("{}\u{1f}{}\u{1f}{}", self.rail, self.counterparty, self.key)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectIdempotencyEntry {
    pub idempotency_key: EffectIdempotencyKey,
    pub receipt_ref: String,
    pub receipt_created_at: String,
    pub receipt_digest: String,
    pub rail_proof_ref: String,
    pub supervisor_proof: PaymentSupervisorProof,
    pub amount_minor: u64,
    pub currency: String,
    pub outputs: JsonObject,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectCapabilityConsumption {
    pub capability_ref: String,
    pub idempotency_key: EffectIdempotencyKey,
    pub receipt_ref: Option<String>,
    pub recovery_state: Option<EffectRecoveryState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectRecoveryState {
    InFlight,
    Sealed,
    Escalated,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectMutation {
    pub idempotency_key: EffectIdempotencyKey,
    pub rail: String,
    pub amount_minor: u64,
    pub currency: String,
    pub counterparty: String,
    pub status: EffectMutationStatus,
    pub proof_ref: Option<String>,
    pub recovery_state: EffectRecoveryState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectMutationStatus {
    Partial,
    Fulfilled,
    Escalated,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectFinalityIntent {
    pub idempotency_key: EffectIdempotencyKey,
    pub rail: String,
    pub amount_minor: u64,
    pub currency: String,
    pub counterparty: String,
    pub spend_capability_ref: String,
    pub act_id: String,
    pub status: EffectFinalityIntentStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectFinalityRecord {
    pub money_movement_id: String,
    pub rail: String,
    pub phase: EffectFinalityPhase,
    pub confirmation_depth: Option<u64>,
    pub finality_threshold: Option<u64>,
    pub original_receipt_ref: String,
    pub latest_receipt_ref: String,
    pub terminal_reason: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectFinalityEventRecord {
    pub provider_event_id: String,
    pub rail: String,
    pub event_kind: String,
    pub received_at: String,
    pub signature_digest: String,
    pub money_movement_id: String,
    pub result_phase: EffectFinalityPhase,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectFinalityIntentStatus {
    Open,
    Sealed,
    Escalated,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectRunSpendLedgerEntry {
    pub run_id: String,
    pub authority_ref: String,
    pub currency: String,
    pub max_per_run_units: u64,
    pub reserved_minor: u64,
    pub sealed_minor: u64,
    pub entries: BTreeMap<String, EffectRunSpendLedgerItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectRunSpendLedgerItem {
    pub idempotency_key: EffectIdempotencyKey,
    pub amount_minor: u64,
    pub status: EffectRunSpendStatus,
    pub receipt_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectRunSpendStatus {
    Reserved,
    Sealed,
    Escalated,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectRunSpendReservation {
    pub run_id: String,
    pub authority_ref: String,
    pub max_per_run_units: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectPeriodSpendLedgerEntry {
    pub authority_ref: String,
    pub currency: String,
    pub max_per_period_units: u64,
    pub period: String,
    pub window_start: String,
    pub reserved_minor: u64,
    pub sealed_minor: u64,
    pub entries: BTreeMap<String, EffectRunSpendLedgerItem>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectPeriodSpendReservation {
    pub authority_ref: String,
    pub max_per_period_units: u64,
    pub period: String,
    pub window_start: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectStepStateInput {
    pub family: &'static str,
    pub idempotency_key: EffectIdempotencyKey,
    pub spend_capability_ref: String,
    pub rail: String,
    pub counterparty: String,
    pub amount_minor: u64,
    pub currency: String,
    pub act_id: String,
    pub run_spend: Option<EffectRunSpendReservation>,
    pub period_spend: Option<EffectPeriodSpendReservation>,
}

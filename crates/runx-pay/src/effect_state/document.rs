use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::EFFECT_STATE_SCHEMA_VERSION;
use super::types::{
    EffectCapabilityConsumption, EffectFinalityEventRecord, EffectFinalityIntent,
    EffectFinalityRecord, EffectIdempotencyEntry, EffectMutation, EffectPeriodSpendLedgerEntry,
    EffectRunSpendLedgerEntry,
};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EffectStateDocument {
    pub(super) schema_version: String,
    pub(super) families: BTreeMap<String, EffectFamilyState>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EffectFamilyState {
    #[serde(default)]
    pub(super) finality_intents: BTreeMap<String, EffectFinalityIntent>,
    #[serde(default)]
    pub(super) finality_records: BTreeMap<String, EffectFinalityRecord>,
    #[serde(default)]
    pub(super) finality_events: BTreeMap<String, EffectFinalityEventRecord>,
    #[serde(default)]
    pub(super) run_spend_ledger: BTreeMap<String, EffectRunSpendLedgerEntry>,
    // Defaulted so state files written before period ledgers existed still load.
    #[serde(default)]
    pub(super) period_spend_ledger: BTreeMap<String, EffectPeriodSpendLedgerEntry>,
    #[serde(default)]
    pub(super) idempotency_entries: BTreeMap<String, EffectIdempotencyEntry>,
    #[serde(default)]
    pub(super) consumed_spend_capabilities: BTreeMap<String, EffectCapabilityConsumption>,
    #[serde(default)]
    pub(super) rail_mutations: BTreeMap<String, EffectMutation>,
}

impl Default for EffectStateDocument {
    fn default() -> Self {
        Self {
            schema_version: EFFECT_STATE_SCHEMA_VERSION.to_owned(),
            families: BTreeMap::new(),
        }
    }
}

impl EffectStateDocument {
    pub(super) fn family(&self, family: &str) -> Option<&EffectFamilyState> {
        self.families.get(family)
    }

    pub(super) fn family_mut(&mut self, family: &'static str) -> &mut EffectFamilyState {
        self.families.entry(family.to_owned()).or_default()
    }
}

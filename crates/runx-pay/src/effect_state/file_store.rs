use std::path::PathBuf;

use super::document::{EffectFamilyState, EffectStateDocument};
use super::family_ops;
use super::io::{load_effect_state, persist_effect_state};
use super::lock::EffectStateLock;
use super::{
    EffectCapabilityConsumption, EffectFinalityEventRecord, EffectFinalityIntent,
    EffectFinalityRecord, EffectIdempotencyEntry, EffectIdempotencyKey, EffectMutation,
    EffectPeriodSpendReservation, EffectRunSpendReservation, EffectStateError, EffectStateStore,
    EffectStepStateInput,
};

#[derive(Debug)]
pub struct FileBackedEffectStateStore {
    path: PathBuf,
    state: EffectStateDocument,
}

impl FileBackedEffectStateStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, EffectStateError> {
        let path = path.into();
        let state = load_effect_state(&path)?;
        Ok(Self { path, state })
    }

    fn with_locked_family<T>(
        &mut self,
        family: &'static str,
        update: impl FnOnce(&mut EffectFamilyState) -> Result<T, EffectStateError>,
    ) -> Result<T, EffectStateError> {
        self.with_locked_state(|state| update(state.family_mut(family)))
    }

    fn with_locked_state<T>(
        &mut self,
        update: impl FnOnce(&mut EffectStateDocument) -> Result<T, EffectStateError>,
    ) -> Result<T, EffectStateError> {
        let _lock = EffectStateLock::acquire(&self.path)?;
        let mut state = load_effect_state(&self.path)?;
        let result = update(&mut state)?;
        persist_effect_state(&self.path, &state)?;
        self.state = state;
        Ok(result)
    }
}

impl EffectStateStore for FileBackedEffectStateStore {
    fn lookup_idempotency(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectIdempotencyEntry> {
        family_ops::lookup_idempotency(&self.state, family, key)
    }

    fn record_idempotency(
        &mut self,
        family: &'static str,
        entry: EffectIdempotencyEntry,
    ) -> Result<(), EffectStateError> {
        self.with_locked_family(family, |state| family_ops::record_idempotency(state, entry))
    }

    fn lookup_consumed_spend_capability(
        &self,
        family: &str,
        capability_ref: &str,
    ) -> Option<&EffectCapabilityConsumption> {
        family_ops::lookup_consumed_spend_capability(&self.state, family, capability_ref)
    }

    fn consume_spend_capability(
        &mut self,
        family: &'static str,
        consumption: EffectCapabilityConsumption,
    ) -> Result<(), EffectStateError> {
        self.with_locked_family(family, |state| {
            family_ops::consume_spend_capability(state, consumption)
        })
    }

    fn lookup_mutation(&self, family: &str, key: &EffectIdempotencyKey) -> Option<&EffectMutation> {
        family_ops::lookup_mutation(&self.state, family, key)
    }

    fn lookup_finality_intent(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectFinalityIntent> {
        family_ops::lookup_finality_intent(&self.state, family, key)
    }

    fn lookup_finality_record(
        &self,
        family: &str,
        money_movement_id: &str,
    ) -> Option<&EffectFinalityRecord> {
        family_ops::lookup_finality_record(&self.state, family, money_movement_id)
    }

    fn record_finality_record(
        &mut self,
        family: &'static str,
        record: EffectFinalityRecord,
    ) -> Result<(), EffectStateError> {
        self.with_locked_family(family, |state| {
            family_ops::record_finality_record(state, record)
        })
    }

    fn lookup_finality_event(
        &self,
        family: &str,
        rail: &str,
        provider_event_id: &str,
    ) -> Option<&EffectFinalityEventRecord> {
        family_ops::lookup_finality_event(&self.state, family, rail, provider_event_id)
    }

    fn record_finality_event(
        &mut self,
        family: &'static str,
        event: EffectFinalityEventRecord,
    ) -> Result<(), EffectStateError> {
        self.with_locked_family(family, |state| {
            family_ops::record_finality_event(state, event)
        })
    }

    fn record_finality_intent(
        &mut self,
        family: &'static str,
        intent: EffectFinalityIntent,
        run_spend: Option<&EffectRunSpendReservation>,
        period_spend: Option<&EffectPeriodSpendReservation>,
    ) -> Result<(), EffectStateError> {
        self.with_locked_family(family, |state| {
            family_ops::record_finality_intent(state, family, intent, run_spend, period_spend)
        })
    }

    fn seal_run_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError> {
        self.with_locked_family(family, |state| {
            family_ops::seal_run_spend(state, family, input, receipt_ref);
            Ok(())
        })
    }

    fn seal_period_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError> {
        self.with_locked_family(family, |state| {
            family_ops::seal_period_spend(state, family, input, receipt_ref);
            Ok(())
        })
    }

    fn escalate_mutation(
        &mut self,
        family: &'static str,
        key: &EffectIdempotencyKey,
    ) -> Result<Option<EffectMutation>, EffectStateError> {
        self.with_locked_family(family, |state| {
            Ok(family_ops::escalate_mutation(state, key))
        })
    }

    fn record_mutation(
        &mut self,
        family: &'static str,
        mutation: EffectMutation,
    ) -> Result<(), EffectStateError> {
        self.with_locked_family(family, |state| family_ops::record_mutation(state, mutation))
    }
}

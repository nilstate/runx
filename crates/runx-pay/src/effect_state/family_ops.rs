use super::document::{EffectFamilyState, EffectStateDocument};
use super::keys::{finality_event_key, finality_record_conflicts, run_spend_ledger_key};
use super::recovery::finality_intent_status_for_recovery;
use super::spend::{period_spend_ledger_key, reserve_period_spend, reserve_run_spend};
use super::{
    EffectCapabilityConsumption, EffectFinalityEventRecord, EffectFinalityIntent,
    EffectFinalityRecord, EffectIdempotencyEntry, EffectIdempotencyKey, EffectMutation,
    EffectMutationStatus, EffectPeriodSpendReservation, EffectRecoveryState,
    EffectRunSpendReservation, EffectRunSpendStatus, EffectStateError, EffectStepStateInput,
};

pub(super) fn lookup_idempotency<'a>(
    document: &'a EffectStateDocument,
    family: &str,
    key: &EffectIdempotencyKey,
) -> Option<&'a EffectIdempotencyEntry> {
    document
        .family(family)
        .and_then(|state| state.idempotency_entries.get(&key.index_key()))
}

pub(super) fn lookup_consumed_spend_capability<'a>(
    document: &'a EffectStateDocument,
    family: &str,
    capability_ref: &str,
) -> Option<&'a EffectCapabilityConsumption> {
    document
        .family(family)
        .and_then(|state| state.consumed_spend_capabilities.get(capability_ref))
}

pub(super) fn lookup_mutation<'a>(
    document: &'a EffectStateDocument,
    family: &str,
    key: &EffectIdempotencyKey,
) -> Option<&'a EffectMutation> {
    document
        .family(family)
        .and_then(|state| state.rail_mutations.get(&key.index_key()))
}

pub(super) fn lookup_finality_intent<'a>(
    document: &'a EffectStateDocument,
    family: &str,
    key: &EffectIdempotencyKey,
) -> Option<&'a EffectFinalityIntent> {
    document
        .family(family)
        .and_then(|state| state.finality_intents.get(&key.index_key()))
}

pub(super) fn lookup_finality_record<'a>(
    document: &'a EffectStateDocument,
    family: &str,
    money_movement_id: &str,
) -> Option<&'a EffectFinalityRecord> {
    document
        .family(family)
        .and_then(|state| state.finality_records.get(money_movement_id))
}

pub(super) fn lookup_finality_event<'a>(
    document: &'a EffectStateDocument,
    family: &str,
    rail: &str,
    provider_event_id: &str,
) -> Option<&'a EffectFinalityEventRecord> {
    document.family(family).and_then(|state| {
        state
            .finality_events
            .get(&finality_event_key(rail, provider_event_id))
    })
}

pub(super) fn record_idempotency(
    state: &mut EffectFamilyState,
    entry: EffectIdempotencyEntry,
) -> Result<(), EffectStateError> {
    let index_key = entry.idempotency_key.index_key();
    if state.idempotency_entries.contains_key(&index_key) {
        return Err(EffectStateError::IdempotencyAlreadyRecorded {
            idempotency_key: index_key,
        });
    }
    state.idempotency_entries.insert(index_key, entry);
    Ok(())
}

pub(super) fn consume_spend_capability(
    state: &mut EffectFamilyState,
    consumption: EffectCapabilityConsumption,
) -> Result<(), EffectStateError> {
    let capability_ref = consumption.capability_ref.clone();
    if state
        .consumed_spend_capabilities
        .contains_key(&capability_ref)
    {
        return Err(EffectStateError::SpendCapabilityAlreadyConsumed { capability_ref });
    }
    state
        .consumed_spend_capabilities
        .insert(capability_ref, consumption);
    Ok(())
}

pub(super) fn record_finality_record(
    state: &mut EffectFamilyState,
    record: EffectFinalityRecord,
) -> Result<(), EffectStateError> {
    let money_movement_id = record.money_movement_id.clone();
    if let Some(existing) = state.finality_records.get(&money_movement_id)
        && finality_record_conflicts(existing, &record)
    {
        return Err(EffectStateError::FinalityRecordConflict { money_movement_id });
    }
    state.finality_records.insert(money_movement_id, record);
    Ok(())
}

pub(super) fn record_finality_event(
    state: &mut EffectFamilyState,
    event: EffectFinalityEventRecord,
) -> Result<(), EffectStateError> {
    let event_key = finality_event_key(&event.rail, &event.provider_event_id);
    if let Some(existing) = state.finality_events.get(&event_key) {
        if existing == &event {
            return Ok(());
        }
        return Err(EffectStateError::FinalityEventConflict { event_key });
    }
    state.finality_events.insert(event_key, event);
    Ok(())
}

pub(super) fn record_finality_intent(
    state: &mut EffectFamilyState,
    family: &'static str,
    intent: EffectFinalityIntent,
    run_spend: Option<&EffectRunSpendReservation>,
    period_spend: Option<&EffectPeriodSpendReservation>,
) -> Result<(), EffectStateError> {
    let index_key = intent.idempotency_key.index_key();
    if let Some(existing) = state.finality_intents.get(&index_key) {
        if existing == &intent {
            return Ok(());
        }
        return Err(EffectStateError::FinalityIntentConflict {
            idempotency_key: index_key,
        });
    }
    reserve_run_spend(state, family, &intent, run_spend)?;
    reserve_period_spend(state, family, &intent, period_spend)?;
    state.finality_intents.insert(index_key, intent);
    Ok(())
}

pub(super) fn seal_run_spend(
    state: &mut EffectFamilyState,
    family: &'static str,
    input: &EffectStepStateInput,
    receipt_ref: &str,
) {
    let Some(run_spend) = input.run_spend.as_ref() else {
        return;
    };
    let ledger_key = run_spend_ledger_key(family, run_spend, &input.currency);
    seal_spend_entry(
        state.run_spend_ledger.get_mut(&ledger_key),
        &input.idempotency_key,
        receipt_ref,
    );
}

pub(super) fn seal_period_spend(
    state: &mut EffectFamilyState,
    family: &'static str,
    input: &EffectStepStateInput,
    receipt_ref: &str,
) {
    let Some(period_spend) = input.period_spend.as_ref() else {
        return;
    };
    let ledger_key = period_spend_ledger_key(family, period_spend, &input.currency);
    seal_spend_entry(
        state.period_spend_ledger.get_mut(&ledger_key),
        &input.idempotency_key,
        receipt_ref,
    );
}

pub(super) fn escalate_mutation(
    state: &mut EffectFamilyState,
    key: &EffectIdempotencyKey,
) -> Option<EffectMutation> {
    let mutation = state.rail_mutations.get_mut(&key.index_key())?;
    mutation.status = EffectMutationStatus::Escalated;
    mutation.recovery_state = EffectRecoveryState::Escalated;
    Some(mutation.clone())
}

pub(super) fn record_mutation(
    state: &mut EffectFamilyState,
    mutation: EffectMutation,
) -> Result<(), EffectStateError> {
    let index_key = mutation.idempotency_key.index_key();
    if state.rail_mutations.contains_key(&index_key) {
        return Err(EffectStateError::EffectMutationAlreadyRecorded {
            idempotency_key: index_key,
        });
    }
    if let Some(intent) = state.finality_intents.get_mut(&index_key) {
        intent.status = finality_intent_status_for_recovery(&mutation.recovery_state);
    }
    state.rail_mutations.insert(index_key, mutation);
    Ok(())
}

fn seal_spend_entry(
    ledger: Option<&mut impl SpendLedger>,
    key: &EffectIdempotencyKey,
    receipt_ref: &str,
) {
    let Some(ledger) = ledger else {
        return;
    };
    ledger.seal_entry(key, receipt_ref);
}

trait SpendLedger {
    fn seal_entry(&mut self, key: &EffectIdempotencyKey, receipt_ref: &str);
}

impl SpendLedger for super::EffectRunSpendLedgerEntry {
    fn seal_entry(&mut self, key: &EffectIdempotencyKey, receipt_ref: &str) {
        seal_entry_in_ledger(&mut self.entries, &mut self.sealed_minor, key, receipt_ref);
    }
}

impl SpendLedger for super::EffectPeriodSpendLedgerEntry {
    fn seal_entry(&mut self, key: &EffectIdempotencyKey, receipt_ref: &str) {
        seal_entry_in_ledger(&mut self.entries, &mut self.sealed_minor, key, receipt_ref);
    }
}

fn seal_entry_in_ledger(
    entries: &mut std::collections::BTreeMap<String, super::EffectRunSpendLedgerItem>,
    sealed_minor: &mut u64,
    key: &EffectIdempotencyKey,
    receipt_ref: &str,
) {
    let Some(item) = entries.get_mut(&key.index_key()) else {
        return;
    };
    if item.status != EffectRunSpendStatus::Sealed {
        *sealed_minor = sealed_minor.saturating_add(item.amount_minor);
    }
    item.status = EffectRunSpendStatus::Sealed;
    item.receipt_ref = Some(receipt_ref.to_owned());
}

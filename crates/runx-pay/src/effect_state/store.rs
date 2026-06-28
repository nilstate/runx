use super::{
    EffectCapabilityConsumption, EffectFinalityEventRecord, EffectFinalityIntent,
    EffectFinalityRecord, EffectIdempotencyEntry, EffectIdempotencyKey, EffectMutation,
    EffectPeriodSpendReservation, EffectRunSpendReservation, EffectStateError,
    EffectStepStateInput,
};
pub trait EffectStateStore {
    fn lookup_idempotency(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectIdempotencyEntry>;

    fn record_idempotency(
        &mut self,
        family: &'static str,
        entry: EffectIdempotencyEntry,
    ) -> Result<(), EffectStateError>;

    fn lookup_consumed_spend_capability(
        &self,
        family: &str,
        capability_ref: &str,
    ) -> Option<&EffectCapabilityConsumption>;

    fn consume_spend_capability(
        &mut self,
        family: &'static str,
        consumption: EffectCapabilityConsumption,
    ) -> Result<(), EffectStateError>;

    fn lookup_mutation(&self, family: &str, key: &EffectIdempotencyKey) -> Option<&EffectMutation>;

    fn lookup_finality_intent(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectFinalityIntent>;

    fn lookup_finality_record(
        &self,
        family: &str,
        money_movement_id: &str,
    ) -> Option<&EffectFinalityRecord>;

    fn record_finality_record(
        &mut self,
        family: &'static str,
        record: EffectFinalityRecord,
    ) -> Result<(), EffectStateError>;

    fn lookup_finality_event(
        &self,
        family: &str,
        rail: &str,
        provider_event_id: &str,
    ) -> Option<&EffectFinalityEventRecord>;

    fn record_finality_event(
        &mut self,
        family: &'static str,
        event: EffectFinalityEventRecord,
    ) -> Result<(), EffectStateError>;

    fn record_finality_intent(
        &mut self,
        family: &'static str,
        intent: EffectFinalityIntent,
        run_spend: Option<&EffectRunSpendReservation>,
        period_spend: Option<&EffectPeriodSpendReservation>,
    ) -> Result<(), EffectStateError>;

    fn seal_run_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError>;

    fn seal_period_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError>;

    fn escalate_mutation(
        &mut self,
        family: &'static str,
        key: &EffectIdempotencyKey,
    ) -> Result<Option<EffectMutation>, EffectStateError>;

    fn record_mutation(
        &mut self,
        family: &'static str,
        mutation: EffectMutation,
    ) -> Result<(), EffectStateError>;
}

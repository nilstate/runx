mod transport;

use std::collections::BTreeMap;

use serde::Deserialize;

use super::document::{EffectFamilyState, EffectStateDocument};
use super::family_ops;
use super::{
    EffectCapabilityConsumption, EffectFinalityEventRecord, EffectFinalityIntent,
    EffectFinalityRecord, EffectIdempotencyEntry, EffectIdempotencyKey, EffectMutation,
    EffectPeriodSpendReservation, EffectRunSpendReservation, EffectStateError, EffectStateStore,
    EffectStepStateInput, HOSTED_EFFECT_STATE_COMMIT_RETRIES,
};
pub(super) use transport::hosted_transport_missing;
use transport::{HostedCommitOutcome, HostedEffectStateEndpoint};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HostedEffectStateBackend {
    pub(super) kind: String,
    pub(super) tenant_id: String,
    pub(super) store_ref: String,
    #[serde(default)]
    pub(super) endpoint_url: Option<String>,
    #[serde(default)]
    pub(super) bearer_token: Option<String>,
    #[serde(default)]
    pub(super) allowed_families: Vec<String>,
}

#[derive(Debug)]
pub(super) struct HostedEffectStateStore {
    backend: HostedEffectStateBackend,
    endpoint: HostedEffectStateEndpoint,
    state: EffectStateDocument,
    versions: BTreeMap<String, u64>,
}

impl HostedEffectStateStore {
    pub(super) fn open(backend: HostedEffectStateBackend) -> Result<Self, EffectStateError> {
        let endpoint = HostedEffectStateEndpoint::parse(
            backend
                .endpoint_url
                .as_deref()
                .ok_or_else(hosted_transport_missing)?,
        )?;
        let token = backend
            .bearer_token
            .as_deref()
            .ok_or_else(hosted_transport_missing)?;
        if token.trim().is_empty() {
            return Err(hosted_transport_missing());
        }
        if backend.allowed_families.is_empty() {
            return Err(EffectStateError::HostedBackendInvalid {
                message: "allowed_families is required for hosted effect-state transport"
                    .to_owned(),
            });
        }

        let mut store = Self {
            backend,
            endpoint,
            state: EffectStateDocument::default(),
            versions: BTreeMap::new(),
        };
        for family in store.backend.allowed_families.clone() {
            store.refresh_family(&family)?;
        }
        Ok(store)
    }

    fn with_transactional_family<T>(
        &mut self,
        family: &'static str,
        mut update: impl FnMut(&mut EffectFamilyState) -> Result<T, EffectStateError>,
    ) -> Result<T, EffectStateError> {
        self.ensure_family_allowed(family)?;
        for _ in 0..HOSTED_EFFECT_STATE_COMMIT_RETRIES {
            let expected_version = self.versions.get(family).copied().unwrap_or(0);
            let mut next_family = self.state.family(family).cloned().unwrap_or_default();
            let result = update(&mut next_family)?;
            match self.commit_family(family, expected_version, &next_family)? {
                HostedCommitOutcome::Committed(response) => {
                    self.state
                        .families
                        .insert(family.to_owned(), response.state);
                    self.versions.insert(family.to_owned(), response.version);
                    return Ok(result);
                }
                HostedCommitOutcome::Conflict(response) => {
                    self.state
                        .families
                        .insert(family.to_owned(), response.state);
                    self.versions.insert(family.to_owned(), response.version);
                }
            }
        }
        Err(EffectStateError::HostedBackendTransport {
            message: format!(
                "hosted effect-state commit for family {family} stayed stale after {HOSTED_EFFECT_STATE_COMMIT_RETRIES} retries"
            ),
        })
    }
}

impl EffectStateStore for HostedEffectStateStore {
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
        self.with_transactional_family(family, |state| {
            family_ops::record_idempotency(state, entry.clone())
        })
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
        self.with_transactional_family(family, |state| {
            family_ops::consume_spend_capability(state, consumption.clone())
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
        self.with_transactional_family(family, |state| {
            family_ops::record_finality_record(state, record.clone())
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
        self.with_transactional_family(family, |state| {
            family_ops::record_finality_event(state, event.clone())
        })
    }

    fn record_finality_intent(
        &mut self,
        family: &'static str,
        intent: EffectFinalityIntent,
        run_spend: Option<&EffectRunSpendReservation>,
        period_spend: Option<&EffectPeriodSpendReservation>,
    ) -> Result<(), EffectStateError> {
        let run_spend = run_spend.cloned();
        let period_spend = period_spend.cloned();
        self.with_transactional_family(family, |state| {
            family_ops::record_finality_intent(
                state,
                family,
                intent.clone(),
                run_spend.as_ref(),
                period_spend.as_ref(),
            )
        })
    }

    fn seal_run_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError> {
        self.with_transactional_family(family, |state| {
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
        self.with_transactional_family(family, |state| {
            family_ops::seal_period_spend(state, family, input, receipt_ref);
            Ok(())
        })
    }

    fn escalate_mutation(
        &mut self,
        family: &'static str,
        key: &EffectIdempotencyKey,
    ) -> Result<Option<EffectMutation>, EffectStateError> {
        self.with_transactional_family(family, |state| {
            Ok(family_ops::escalate_mutation(state, key))
        })
    }

    fn record_mutation(
        &mut self,
        family: &'static str,
        mutation: EffectMutation,
    ) -> Result<(), EffectStateError> {
        self.with_transactional_family(family, |state| {
            family_ops::record_mutation(state, mutation.clone())
        })
    }
}

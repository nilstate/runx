mod document;
mod error;
mod family_ops;
mod file_store;
mod hosted_store;
mod io;
mod keys;
mod lock;
mod operations;
mod recovery;
mod resolver;
mod spend;
mod store;
mod types;

pub use error::EffectStateError;
pub use file_store::FileBackedEffectStateStore;
pub use operations::{
    consumed_spend_capability_recorded, consumed_spend_capability_recorded_in_store,
    escalate_effect_mutation, escalate_effect_mutation_in_store, lookup_effect_idempotency_entry,
    lookup_effect_idempotency_entry_in_store, lookup_effect_mutation,
    lookup_effect_mutation_in_store, persist_effect_step_state, persist_effect_step_state_in_store,
    record_effect_finality_intent, record_effect_finality_intent_in_store,
};
pub use resolver::{hosted_effect_state_backend_is_supported, resolve_effect_state_path};
pub use spend::period_window_start;
pub use store::EffectStateStore;
pub use types::{
    EffectCapabilityConsumption, EffectFinalityEventRecord, EffectFinalityIntent,
    EffectFinalityIntentStatus, EffectFinalityRecord, EffectIdempotencyEntry, EffectIdempotencyKey,
    EffectMutation, EffectMutationStatus, EffectPeriodSpendLedgerEntry,
    EffectPeriodSpendReservation, EffectRecoveryState, EffectRunSpendLedgerEntry,
    EffectRunSpendLedgerItem, EffectRunSpendReservation, EffectRunSpendStatus,
    EffectStepStateInput,
};

pub const EFFECT_STATE_SCHEMA_VERSION: &str = "runx.effect_state.v1";
pub const RUNX_EFFECT_STATE_PATH_ENV: &str = "RUNX_EFFECT_STATE_PATH";
pub const RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV: &str = "RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON";
const HOSTED_TRANSACTIONAL_BACKEND_KIND: &str = "hosted_transactional";
const HOSTED_EFFECT_STATE_STORE_REF: &str = "runx:hosted-effect-state";
const HOSTED_EFFECT_STATE_COMMIT_RETRIES: usize = 5;

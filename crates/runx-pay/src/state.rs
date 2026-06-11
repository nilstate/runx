// rust-style-allow: large-file because effect state owns persisted idempotency,
// capability consumption, mutation recovery, and the step-persistence transaction
// at the runtime trust boundary.
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use runx_contracts::{EffectFinalityPhase, JsonObject, JsonValue};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::packets::{PaymentPacketError, PaymentRailPacket, read_effect_evidence_packet};
use crate::supervisor::{
    PaymentSupervisorProof, PaymentSupervisorProofMatch, validate_payment_supervisor_proof,
};

pub const EFFECT_STATE_SCHEMA_VERSION: &str = "runx.effect_state.v1";
pub const RUNX_EFFECT_STATE_PATH_ENV: &str = "RUNX_EFFECT_STATE_PATH";
pub const RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV: &str = "RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON";
const EFFECT_STATE_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const EFFECT_STATE_LOCK_RETRY: Duration = Duration::from_millis(10);
const HOSTED_TRANSACTIONAL_BACKEND_KIND: &str = "hosted_transactional";
const HOSTED_EFFECT_STATE_STORE_REF: &str = "runx:hosted-effect-state";
const HOSTED_EFFECT_STATE_COMMIT_RETRIES: usize = 5;

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
    fn index_key(&self) -> String {
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

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HostedEffectStateBackend {
    kind: String,
    tenant_id: String,
    store_ref: String,
    #[serde(default)]
    endpoint_url: Option<String>,
    #[serde(default)]
    bearer_token: Option<String>,
    #[serde(default)]
    allowed_families: Vec<String>,
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

#[derive(Debug)]
pub struct FileBackedEffectStateStore {
    path: PathBuf,
    state: EffectStateDocument,
}

#[derive(Debug)]
struct HostedEffectStateStore {
    backend: HostedEffectStateBackend,
    endpoint: HostedEffectStateEndpoint,
    state: EffectStateDocument,
    versions: BTreeMap<String, u64>,
}

#[derive(Clone, Debug)]
struct HostedEffectStateEndpoint {
    host: String,
    port: u16,
    base_path: String,
}

#[derive(Debug)]
enum HostedCommitOutcome {
    Committed(HostedFamilyResponse),
    Conflict(HostedFamilyResponse),
}

#[derive(Debug)]
struct EffectStateLock {
    path: PathBuf,
    _file: File,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EffectStateDocument {
    schema_version: String,
    families: BTreeMap<String, EffectFamilyState>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EffectFamilyState {
    #[serde(default)]
    finality_intents: BTreeMap<String, EffectFinalityIntent>,
    #[serde(default)]
    finality_records: BTreeMap<String, EffectFinalityRecord>,
    #[serde(default)]
    finality_events: BTreeMap<String, EffectFinalityEventRecord>,
    #[serde(default)]
    run_spend_ledger: BTreeMap<String, EffectRunSpendLedgerEntry>,
    // Defaulted so state files written before period ledgers existed still load.
    #[serde(default)]
    period_spend_ledger: BTreeMap<String, EffectPeriodSpendLedgerEntry>,
    #[serde(default)]
    idempotency_entries: BTreeMap<String, EffectIdempotencyEntry>,
    #[serde(default)]
    consumed_spend_capabilities: BTreeMap<String, EffectCapabilityConsumption>,
    #[serde(default)]
    rail_mutations: BTreeMap<String, EffectMutation>,
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
    fn family(&self, family: &str) -> Option<&EffectFamilyState> {
        self.families.get(family)
    }

    fn family_mut(&mut self, family: &'static str) -> &mut EffectFamilyState {
        self.families.entry(family.to_owned()).or_default()
    }
}

#[derive(Debug, Error)]
pub enum EffectStateError {
    #[error("effect state path {path} has no parent directory")]
    MissingParent { path: PathBuf },
    #[error("failed to read effect state {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse effect state {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("effect state {path} has unsupported schema version {version}")]
    UnsupportedSchemaVersion { path: PathBuf, version: String },
    #[error("failed to create effect state directory {path}: {source}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to write effect state {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to lock effect state {path}: {message}")]
    Lock { path: PathBuf, message: String },
    #[error("failed to serialize effect state {path}: {source}")]
    Serialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("idempotency key {idempotency_key} was already recorded")]
    IdempotencyAlreadyRecorded { idempotency_key: String },
    #[error("rail mutation for idempotency key {idempotency_key} was already recorded")]
    EffectMutationAlreadyRecorded { idempotency_key: String },
    #[error(
        "finality intent for idempotency key {idempotency_key} conflicts with an existing intent"
    )]
    FinalityIntentConflict { idempotency_key: String },
    #[error(
        "run {run_id} would exceed max_per_run_units for {authority_ref}/{currency}: attempted {attempted_minor}, max {max_per_run_units}"
    )]
    RunSpendCapExceeded {
        run_id: String,
        authority_ref: String,
        currency: String,
        attempted_minor: u64,
        max_per_run_units: u64,
    },
    #[error("run spend ledger key {ledger_key} conflicts with existing run spend state")]
    RunSpendLedgerConflict { ledger_key: String },
    #[error(
        "period window {window_start} ({period}) would exceed max_per_period_units for {authority_ref}/{currency}: attempted {attempted_minor}, max {max_per_period_units}"
    )]
    PeriodSpendCapExceeded {
        period: String,
        window_start: String,
        authority_ref: String,
        currency: String,
        attempted_minor: u64,
        max_per_period_units: u64,
    },
    #[error("period spend ledger key {ledger_key} conflicts with existing period spend state")]
    PeriodSpendLedgerConflict { ledger_key: String },
    #[error(
        "payment authority period {period} is not supported; expected daily, weekly, or monthly"
    )]
    UnsupportedSpendPeriod { period: String },
    #[error("finality record for {money_movement_id} conflicts with existing finality state")]
    FinalityRecordConflict { money_movement_id: String },
    #[error("finality event {event_key} conflicts with existing event state")]
    FinalityEventConflict { event_key: String },
    #[error("spend capability {capability_ref} was already consumed")]
    SpendCapabilityAlreadyConsumed { capability_ref: String },
    #[error("failed to serialize replay-safe payment outputs: {source}")]
    ReplayOutputSerialize {
        #[source]
        source: serde_json::Error,
    },
    #[error("payment supervisor proof is required before sealing rail proof {proof_ref}")]
    MissingSupervisorProof { proof_ref: String },
    #[error("payment supervisor proof mismatch: {message}")]
    SupervisorProof { message: String },
    #[error("hosted effect state backend config is invalid: {message}")]
    HostedBackendInvalid { message: String },
    #[error("hosted effect state backend is not supported by native runtime: {message}")]
    HostedBackendUnsupported { message: String },
    #[error("hosted effect state transport failed: {message}")]
    HostedBackendTransport { message: String },
    #[error(transparent)]
    PaymentPacket(#[from] PaymentPacketError),
}

impl FileBackedEffectStateStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, EffectStateError> {
        let path = path.into();
        let state = load_effect_state(&path)?;
        Ok(Self { path, state })
    }

    pub fn lookup_idempotency(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectIdempotencyEntry> {
        self.state
            .family(family)
            .and_then(|state| state.idempotency_entries.get(&key.index_key()))
    }

    pub fn record_idempotency(
        &mut self,
        family: &'static str,
        entry: EffectIdempotencyEntry,
    ) -> Result<(), EffectStateError> {
        let index_key = entry.idempotency_key.index_key();
        if self
            .state
            .family(family)
            .is_some_and(|state| state.idempotency_entries.contains_key(&index_key))
        {
            return Err(EffectStateError::IdempotencyAlreadyRecorded {
                idempotency_key: index_key,
            });
        }
        self.with_locked_state(|state| {
            let state = state.family_mut(family);
            if state.idempotency_entries.contains_key(&index_key) {
                return Err(EffectStateError::IdempotencyAlreadyRecorded {
                    idempotency_key: index_key.clone(),
                });
            }
            state.idempotency_entries.insert(index_key, entry);
            Ok(())
        })
    }

    pub fn lookup_consumed_spend_capability(
        &self,
        family: &str,
        capability_ref: &str,
    ) -> Option<&EffectCapabilityConsumption> {
        self.state
            .family(family)
            .and_then(|state| state.consumed_spend_capabilities.get(capability_ref))
    }

    pub fn consume_spend_capability(
        &mut self,
        family: &'static str,
        consumption: EffectCapabilityConsumption,
    ) -> Result<(), EffectStateError> {
        let capability_ref = consumption.capability_ref.clone();
        if self.state.family(family).is_some_and(|state| {
            state
                .consumed_spend_capabilities
                .contains_key(&capability_ref)
        }) {
            return Err(EffectStateError::SpendCapabilityAlreadyConsumed { capability_ref });
        }
        self.with_locked_state(|state| {
            let state = state.family_mut(family);
            if state
                .consumed_spend_capabilities
                .contains_key(&capability_ref)
            {
                return Err(EffectStateError::SpendCapabilityAlreadyConsumed {
                    capability_ref: capability_ref.clone(),
                });
            }
            state
                .consumed_spend_capabilities
                .insert(capability_ref, consumption);
            Ok(())
        })
    }

    pub fn lookup_mutation(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectMutation> {
        self.state
            .family(family)
            .and_then(|state| state.rail_mutations.get(&key.index_key()))
    }

    pub fn lookup_finality_intent(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectFinalityIntent> {
        self.state
            .family(family)
            .and_then(|state| state.finality_intents.get(&key.index_key()))
    }

    pub fn lookup_finality_record(
        &self,
        family: &str,
        money_movement_id: &str,
    ) -> Option<&EffectFinalityRecord> {
        self.state
            .family(family)
            .and_then(|state| state.finality_records.get(money_movement_id))
    }

    pub fn record_finality_record(
        &mut self,
        family: &'static str,
        record: EffectFinalityRecord,
    ) -> Result<(), EffectStateError> {
        let money_movement_id = record.money_movement_id.clone();
        if let Some(existing) = self
            .state
            .family(family)
            .and_then(|state| state.finality_records.get(&money_movement_id))
            && finality_record_conflicts(existing, &record)
        {
            return Err(EffectStateError::FinalityRecordConflict { money_movement_id });
        }
        self.with_locked_state(|state| {
            let state = state.family_mut(family);
            if let Some(existing) = state.finality_records.get(&money_movement_id)
                && finality_record_conflicts(existing, &record)
            {
                return Err(EffectStateError::FinalityRecordConflict {
                    money_movement_id: money_movement_id.clone(),
                });
            }
            state.finality_records.insert(money_movement_id, record);
            Ok(())
        })
    }

    pub fn lookup_finality_event(
        &self,
        family: &str,
        rail: &str,
        provider_event_id: &str,
    ) -> Option<&EffectFinalityEventRecord> {
        self.state.family(family).and_then(|state| {
            state
                .finality_events
                .get(&finality_event_key(rail, provider_event_id))
        })
    }

    pub fn record_finality_event(
        &mut self,
        family: &'static str,
        event: EffectFinalityEventRecord,
    ) -> Result<(), EffectStateError> {
        let event_key = finality_event_key(&event.rail, &event.provider_event_id);
        if let Some(existing) = self
            .state
            .family(family)
            .and_then(|state| state.finality_events.get(&event_key))
        {
            if existing == &event {
                return Ok(());
            }
            return Err(EffectStateError::FinalityEventConflict { event_key });
        }
        self.with_locked_state(|state| {
            let state = state.family_mut(family);
            if let Some(existing) = state.finality_events.get(&event_key) {
                if existing == &event {
                    return Ok(());
                }
                return Err(EffectStateError::FinalityEventConflict {
                    event_key: event_key.clone(),
                });
            }
            state.finality_events.insert(event_key, event);
            Ok(())
        })
    }

    pub fn record_finality_intent(
        &mut self,
        family: &'static str,
        intent: EffectFinalityIntent,
        run_spend: Option<&EffectRunSpendReservation>,
        period_spend: Option<&EffectPeriodSpendReservation>,
    ) -> Result<(), EffectStateError> {
        let index_key = intent.idempotency_key.index_key();
        if let Some(existing) = self
            .state
            .family(family)
            .and_then(|state| state.finality_intents.get(&index_key))
        {
            if existing == &intent {
                return Ok(());
            }
            return Err(EffectStateError::FinalityIntentConflict {
                idempotency_key: index_key,
            });
        }
        self.with_locked_state(|state| {
            let state = state.family_mut(family);
            if let Some(existing) = state.finality_intents.get(&index_key) {
                if existing == &intent {
                    return Ok(());
                }
                return Err(EffectStateError::FinalityIntentConflict {
                    idempotency_key: index_key.clone(),
                });
            }
            reserve_run_spend(state, family, &intent, run_spend)?;
            reserve_period_spend(state, family, &intent, period_spend)?;
            state.finality_intents.insert(index_key, intent);
            Ok(())
        })
    }

    pub fn seal_run_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError> {
        let Some(run_spend) = input.run_spend.as_ref() else {
            return Ok(());
        };
        let ledger_key = run_spend_ledger_key(family, run_spend, &input.currency);
        let entry_key = input.idempotency_key.index_key();
        self.with_locked_state(|state| {
            let Some(ledger) = state
                .family_mut(family)
                .run_spend_ledger
                .get_mut(&ledger_key)
            else {
                return Ok(());
            };
            let Some(item) = ledger.entries.get_mut(&entry_key) else {
                return Ok(());
            };
            if item.status != EffectRunSpendStatus::Sealed {
                ledger.sealed_minor = ledger.sealed_minor.saturating_add(item.amount_minor);
            }
            item.status = EffectRunSpendStatus::Sealed;
            item.receipt_ref = Some(receipt_ref.to_owned());
            Ok(())
        })
    }

    pub fn seal_period_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError> {
        let Some(period_spend) = input.period_spend.as_ref() else {
            return Ok(());
        };
        let ledger_key = period_spend_ledger_key(family, period_spend, &input.currency);
        let entry_key = input.idempotency_key.index_key();
        self.with_locked_state(|state| {
            let Some(ledger) = state
                .family_mut(family)
                .period_spend_ledger
                .get_mut(&ledger_key)
            else {
                return Ok(());
            };
            let Some(item) = ledger.entries.get_mut(&entry_key) else {
                return Ok(());
            };
            if item.status != EffectRunSpendStatus::Sealed {
                ledger.sealed_minor = ledger.sealed_minor.saturating_add(item.amount_minor);
            }
            item.status = EffectRunSpendStatus::Sealed;
            item.receipt_ref = Some(receipt_ref.to_owned());
            Ok(())
        })
    }

    pub fn escalate_mutation(
        &mut self,
        family: &'static str,
        key: &EffectIdempotencyKey,
    ) -> Result<Option<EffectMutation>, EffectStateError> {
        if !self
            .state
            .family(family)
            .is_some_and(|state| state.rail_mutations.contains_key(&key.index_key()))
        {
            return Ok(None);
        }
        self.with_locked_state(|state| {
            let state = state.family_mut(family);
            let Some(mutation) = state.rail_mutations.get_mut(&key.index_key()) else {
                return Ok(None);
            };
            mutation.status = EffectMutationStatus::Escalated;
            mutation.recovery_state = EffectRecoveryState::Escalated;
            Ok(Some(mutation.clone()))
        })
    }

    pub fn record_mutation(
        &mut self,
        family: &'static str,
        mutation: EffectMutation,
    ) -> Result<(), EffectStateError> {
        let index_key = mutation.idempotency_key.index_key();
        if self
            .state
            .family(family)
            .is_some_and(|state| state.rail_mutations.contains_key(&index_key))
        {
            return Err(EffectStateError::EffectMutationAlreadyRecorded {
                idempotency_key: index_key,
            });
        }
        self.with_locked_state(|state| {
            let state = state.family_mut(family);
            if state.rail_mutations.contains_key(&index_key) {
                return Err(EffectStateError::EffectMutationAlreadyRecorded {
                    idempotency_key: index_key.clone(),
                });
            }
            if let Some(intent) = state.finality_intents.get_mut(&index_key) {
                intent.status = finality_intent_status_for_recovery(&mutation.recovery_state);
            }
            state.rail_mutations.insert(index_key, mutation);
            Ok(())
        })
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

impl HostedEffectStateStore {
    fn open(backend: HostedEffectStateBackend) -> Result<Self, EffectStateError> {
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
        let families = store.backend.allowed_families.clone();
        for family in families {
            store.refresh_family(&family)?;
        }
        Ok(store)
    }

    fn lookup_idempotency(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectIdempotencyEntry> {
        self.state
            .family(family)
            .and_then(|state| state.idempotency_entries.get(&key.index_key()))
    }

    fn record_idempotency(
        &mut self,
        family: &'static str,
        entry: EffectIdempotencyEntry,
    ) -> Result<(), EffectStateError> {
        let index_key = entry.idempotency_key.index_key();
        if self
            .state
            .family(family)
            .is_some_and(|state| state.idempotency_entries.contains_key(&index_key))
        {
            return Err(EffectStateError::IdempotencyAlreadyRecorded {
                idempotency_key: index_key,
            });
        }
        self.with_transactional_family(family, move |state| {
            if state.idempotency_entries.contains_key(&index_key) {
                return Err(EffectStateError::IdempotencyAlreadyRecorded {
                    idempotency_key: index_key.clone(),
                });
            }
            state
                .idempotency_entries
                .insert(index_key.clone(), entry.clone());
            Ok(())
        })
    }

    fn lookup_consumed_spend_capability(
        &self,
        family: &str,
        capability_ref: &str,
    ) -> Option<&EffectCapabilityConsumption> {
        self.state
            .family(family)
            .and_then(|state| state.consumed_spend_capabilities.get(capability_ref))
    }

    fn consume_spend_capability(
        &mut self,
        family: &'static str,
        consumption: EffectCapabilityConsumption,
    ) -> Result<(), EffectStateError> {
        let capability_ref = consumption.capability_ref.clone();
        if self.state.family(family).is_some_and(|state| {
            state
                .consumed_spend_capabilities
                .contains_key(&capability_ref)
        }) {
            return Err(EffectStateError::SpendCapabilityAlreadyConsumed { capability_ref });
        }
        self.with_transactional_family(family, move |state| {
            if state
                .consumed_spend_capabilities
                .contains_key(&capability_ref)
            {
                return Err(EffectStateError::SpendCapabilityAlreadyConsumed {
                    capability_ref: capability_ref.clone(),
                });
            }
            state
                .consumed_spend_capabilities
                .insert(capability_ref.clone(), consumption.clone());
            Ok(())
        })
    }

    fn lookup_mutation(&self, family: &str, key: &EffectIdempotencyKey) -> Option<&EffectMutation> {
        self.state
            .family(family)
            .and_then(|state| state.rail_mutations.get(&key.index_key()))
    }

    fn lookup_finality_intent(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectFinalityIntent> {
        self.state
            .family(family)
            .and_then(|state| state.finality_intents.get(&key.index_key()))
    }

    fn lookup_finality_record(
        &self,
        family: &str,
        money_movement_id: &str,
    ) -> Option<&EffectFinalityRecord> {
        self.state
            .family(family)
            .and_then(|state| state.finality_records.get(money_movement_id))
    }

    fn record_finality_record(
        &mut self,
        family: &'static str,
        record: EffectFinalityRecord,
    ) -> Result<(), EffectStateError> {
        let money_movement_id = record.money_movement_id.clone();
        if let Some(existing) = self
            .state
            .family(family)
            .and_then(|state| state.finality_records.get(&money_movement_id))
            && finality_record_conflicts(existing, &record)
        {
            return Err(EffectStateError::FinalityRecordConflict { money_movement_id });
        }
        self.with_transactional_family(family, move |state| {
            if let Some(existing) = state.finality_records.get(&money_movement_id)
                && finality_record_conflicts(existing, &record)
            {
                return Err(EffectStateError::FinalityRecordConflict {
                    money_movement_id: money_movement_id.clone(),
                });
            }
            state
                .finality_records
                .insert(money_movement_id.clone(), record.clone());
            Ok(())
        })
    }

    fn lookup_finality_event(
        &self,
        family: &str,
        rail: &str,
        provider_event_id: &str,
    ) -> Option<&EffectFinalityEventRecord> {
        self.state.family(family).and_then(|state| {
            state
                .finality_events
                .get(&finality_event_key(rail, provider_event_id))
        })
    }

    fn record_finality_event(
        &mut self,
        family: &'static str,
        event: EffectFinalityEventRecord,
    ) -> Result<(), EffectStateError> {
        let event_key = finality_event_key(&event.rail, &event.provider_event_id);
        if let Some(existing) = self
            .state
            .family(family)
            .and_then(|state| state.finality_events.get(&event_key))
        {
            if existing == &event {
                return Ok(());
            }
            return Err(EffectStateError::FinalityEventConflict { event_key });
        }
        self.with_transactional_family(family, move |state| {
            if let Some(existing) = state.finality_events.get(&event_key) {
                if existing == &event {
                    return Ok(());
                }
                return Err(EffectStateError::FinalityEventConflict {
                    event_key: event_key.clone(),
                });
            }
            state
                .finality_events
                .insert(event_key.clone(), event.clone());
            Ok(())
        })
    }

    fn record_finality_intent(
        &mut self,
        family: &'static str,
        intent: EffectFinalityIntent,
        run_spend: Option<&EffectRunSpendReservation>,
        period_spend: Option<&EffectPeriodSpendReservation>,
    ) -> Result<(), EffectStateError> {
        let index_key = intent.idempotency_key.index_key();
        if let Some(existing) = self
            .state
            .family(family)
            .and_then(|state| state.finality_intents.get(&index_key))
        {
            if existing == &intent {
                return Ok(());
            }
            return Err(EffectStateError::FinalityIntentConflict {
                idempotency_key: index_key,
            });
        }
        let run_spend = run_spend.cloned();
        let period_spend = period_spend.cloned();
        self.with_transactional_family(family, move |state| {
            if let Some(existing) = state.finality_intents.get(&index_key) {
                if existing == &intent {
                    return Ok(());
                }
                return Err(EffectStateError::FinalityIntentConflict {
                    idempotency_key: index_key.clone(),
                });
            }
            reserve_run_spend(state, family, &intent, run_spend.as_ref())?;
            reserve_period_spend(state, family, &intent, period_spend.as_ref())?;
            state
                .finality_intents
                .insert(index_key.clone(), intent.clone());
            Ok(())
        })
    }

    fn seal_run_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError> {
        let Some(run_spend) = input.run_spend.as_ref() else {
            return Ok(());
        };
        let ledger_key = run_spend_ledger_key(family, run_spend, &input.currency);
        let entry_key = input.idempotency_key.index_key();
        let receipt_ref = receipt_ref.to_owned();
        self.with_transactional_family(family, move |state| {
            let Some(ledger) = state.run_spend_ledger.get_mut(&ledger_key) else {
                return Ok(());
            };
            let Some(item) = ledger.entries.get_mut(&entry_key) else {
                return Ok(());
            };
            if item.status != EffectRunSpendStatus::Sealed {
                ledger.sealed_minor = ledger.sealed_minor.saturating_add(item.amount_minor);
            }
            item.status = EffectRunSpendStatus::Sealed;
            item.receipt_ref = Some(receipt_ref.clone());
            Ok(())
        })
    }

    fn seal_period_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError> {
        let Some(period_spend) = input.period_spend.as_ref() else {
            return Ok(());
        };
        let ledger_key = period_spend_ledger_key(family, period_spend, &input.currency);
        let entry_key = input.idempotency_key.index_key();
        let receipt_ref = receipt_ref.to_owned();
        self.with_transactional_family(family, move |state| {
            let Some(ledger) = state.period_spend_ledger.get_mut(&ledger_key) else {
                return Ok(());
            };
            let Some(item) = ledger.entries.get_mut(&entry_key) else {
                return Ok(());
            };
            if item.status != EffectRunSpendStatus::Sealed {
                ledger.sealed_minor = ledger.sealed_minor.saturating_add(item.amount_minor);
            }
            item.status = EffectRunSpendStatus::Sealed;
            item.receipt_ref = Some(receipt_ref.clone());
            Ok(())
        })
    }

    fn escalate_mutation(
        &mut self,
        family: &'static str,
        key: &EffectIdempotencyKey,
    ) -> Result<Option<EffectMutation>, EffectStateError> {
        if !self
            .state
            .family(family)
            .is_some_and(|state| state.rail_mutations.contains_key(&key.index_key()))
        {
            return Ok(None);
        }
        let index_key = key.index_key();
        self.with_transactional_family(family, move |state| {
            let Some(mutation) = state.rail_mutations.get_mut(&index_key) else {
                return Ok(None);
            };
            mutation.status = EffectMutationStatus::Escalated;
            mutation.recovery_state = EffectRecoveryState::Escalated;
            Ok(Some(mutation.clone()))
        })
    }

    fn record_mutation(
        &mut self,
        family: &'static str,
        mutation: EffectMutation,
    ) -> Result<(), EffectStateError> {
        let index_key = mutation.idempotency_key.index_key();
        if self
            .state
            .family(family)
            .is_some_and(|state| state.rail_mutations.contains_key(&index_key))
        {
            return Err(EffectStateError::EffectMutationAlreadyRecorded {
                idempotency_key: index_key,
            });
        }
        self.with_transactional_family(family, move |state| {
            if state.rail_mutations.contains_key(&index_key) {
                return Err(EffectStateError::EffectMutationAlreadyRecorded {
                    idempotency_key: index_key.clone(),
                });
            }
            if let Some(intent) = state.finality_intents.get_mut(&index_key) {
                intent.status = finality_intent_status_for_recovery(&mutation.recovery_state);
            }
            state
                .rail_mutations
                .insert(index_key.clone(), mutation.clone());
            Ok(())
        })
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

    fn refresh_family(&mut self, family: &str) -> Result<(), EffectStateError> {
        self.ensure_family_allowed(family)?;
        let response = self.request_family("GET", family, None)?;
        self.state
            .families
            .insert(family.to_owned(), response.state);
        self.versions.insert(family.to_owned(), response.version);
        Ok(())
    }

    fn commit_family(
        &self,
        family: &str,
        expected_version: u64,
        state: &EffectFamilyState,
    ) -> Result<HostedCommitOutcome, EffectStateError> {
        let body = serde_json::to_string(&HostedFamilyCommitRequest {
            expected_version,
            state,
        })
        .map_err(|source| EffectStateError::HostedBackendTransport {
            message: format!("failed to serialize hosted effect-state commit: {source}"),
        })?;
        match self.request_family_with_status("PUT", family, Some(&body))? {
            (200, response) => Ok(HostedCommitOutcome::Committed(response)),
            (409, response) => Ok(HostedCommitOutcome::Conflict(response)),
            (status, _) => Err(EffectStateError::HostedBackendTransport {
                message: format!("unexpected hosted effect-state status {status}"),
            }),
        }
    }

    fn request_family(
        &self,
        method: &str,
        family: &str,
        body: Option<&str>,
    ) -> Result<HostedFamilyResponse, EffectStateError> {
        let (status, response) = self.request_family_with_status(method, family, body)?;
        if status == 200 {
            Ok(response)
        } else {
            Err(EffectStateError::HostedBackendTransport {
                message: format!("unexpected hosted effect-state status {status}"),
            })
        }
    }

    fn request_family_with_status(
        &self,
        method: &str,
        family: &str,
        body: Option<&str>,
    ) -> Result<(u16, HostedFamilyResponse), EffectStateError> {
        self.ensure_family_allowed(family)?;
        let token = self
            .backend
            .bearer_token
            .as_deref()
            .ok_or_else(hosted_transport_missing)?;
        let path = format!("{}/families/{family}", self.endpoint.base_path);
        let body = body.unwrap_or("");
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.endpoint.host,
            body.len(),
        );
        let mut stream = TcpStream::connect((self.endpoint.host.as_str(), self.endpoint.port))
            .map_err(|source| EffectStateError::HostedBackendTransport {
                message: format!("failed to connect to hosted effect-state transport: {source}"),
            })?;
        stream.write_all(request.as_bytes()).map_err(|source| {
            EffectStateError::HostedBackendTransport {
                message: format!("failed to write hosted effect-state request: {source}"),
            }
        })?;
        let mut response = String::new();
        stream.read_to_string(&mut response).map_err(|source| {
            EffectStateError::HostedBackendTransport {
                message: format!("failed to read hosted effect-state response: {source}"),
            }
        })?;
        parse_hosted_response(&response)
    }

    fn ensure_family_allowed(&self, family: &str) -> Result<(), EffectStateError> {
        if !hosted_family_name_is_safe(family) {
            return Err(EffectStateError::HostedBackendInvalid {
                message: format!("invalid hosted effect-state family {family}"),
            });
        }
        if self
            .backend
            .allowed_families
            .iter()
            .any(|allowed| allowed == family)
        {
            return Ok(());
        }
        Err(EffectStateError::HostedBackendInvalid {
            message: format!("hosted effect-state family {family} is not allowed"),
        })
    }
}

impl EffectStateStore for HostedEffectStateStore {
    fn lookup_idempotency(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectIdempotencyEntry> {
        HostedEffectStateStore::lookup_idempotency(self, family, key)
    }

    fn record_idempotency(
        &mut self,
        family: &'static str,
        entry: EffectIdempotencyEntry,
    ) -> Result<(), EffectStateError> {
        HostedEffectStateStore::record_idempotency(self, family, entry)
    }

    fn lookup_consumed_spend_capability(
        &self,
        family: &str,
        capability_ref: &str,
    ) -> Option<&EffectCapabilityConsumption> {
        HostedEffectStateStore::lookup_consumed_spend_capability(self, family, capability_ref)
    }

    fn consume_spend_capability(
        &mut self,
        family: &'static str,
        consumption: EffectCapabilityConsumption,
    ) -> Result<(), EffectStateError> {
        HostedEffectStateStore::consume_spend_capability(self, family, consumption)
    }

    fn lookup_mutation(&self, family: &str, key: &EffectIdempotencyKey) -> Option<&EffectMutation> {
        HostedEffectStateStore::lookup_mutation(self, family, key)
    }

    fn lookup_finality_intent(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectFinalityIntent> {
        HostedEffectStateStore::lookup_finality_intent(self, family, key)
    }

    fn lookup_finality_record(
        &self,
        family: &str,
        money_movement_id: &str,
    ) -> Option<&EffectFinalityRecord> {
        HostedEffectStateStore::lookup_finality_record(self, family, money_movement_id)
    }

    fn record_finality_record(
        &mut self,
        family: &'static str,
        record: EffectFinalityRecord,
    ) -> Result<(), EffectStateError> {
        HostedEffectStateStore::record_finality_record(self, family, record)
    }

    fn lookup_finality_event(
        &self,
        family: &str,
        rail: &str,
        provider_event_id: &str,
    ) -> Option<&EffectFinalityEventRecord> {
        HostedEffectStateStore::lookup_finality_event(self, family, rail, provider_event_id)
    }

    fn record_finality_event(
        &mut self,
        family: &'static str,
        event: EffectFinalityEventRecord,
    ) -> Result<(), EffectStateError> {
        HostedEffectStateStore::record_finality_event(self, family, event)
    }

    fn record_finality_intent(
        &mut self,
        family: &'static str,
        intent: EffectFinalityIntent,
        run_spend: Option<&EffectRunSpendReservation>,
        period_spend: Option<&EffectPeriodSpendReservation>,
    ) -> Result<(), EffectStateError> {
        HostedEffectStateStore::record_finality_intent(
            self,
            family,
            intent,
            run_spend,
            period_spend,
        )
    }

    fn seal_run_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError> {
        HostedEffectStateStore::seal_run_spend(self, family, input, receipt_ref)
    }

    fn seal_period_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError> {
        HostedEffectStateStore::seal_period_spend(self, family, input, receipt_ref)
    }

    fn escalate_mutation(
        &mut self,
        family: &'static str,
        key: &EffectIdempotencyKey,
    ) -> Result<Option<EffectMutation>, EffectStateError> {
        HostedEffectStateStore::escalate_mutation(self, family, key)
    }

    fn record_mutation(
        &mut self,
        family: &'static str,
        mutation: EffectMutation,
    ) -> Result<(), EffectStateError> {
        HostedEffectStateStore::record_mutation(self, family, mutation)
    }
}

impl EffectStateStore for FileBackedEffectStateStore {
    fn lookup_idempotency(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectIdempotencyEntry> {
        FileBackedEffectStateStore::lookup_idempotency(self, family, key)
    }

    fn record_idempotency(
        &mut self,
        family: &'static str,
        entry: EffectIdempotencyEntry,
    ) -> Result<(), EffectStateError> {
        FileBackedEffectStateStore::record_idempotency(self, family, entry)
    }

    fn lookup_consumed_spend_capability(
        &self,
        family: &str,
        capability_ref: &str,
    ) -> Option<&EffectCapabilityConsumption> {
        FileBackedEffectStateStore::lookup_consumed_spend_capability(self, family, capability_ref)
    }

    fn consume_spend_capability(
        &mut self,
        family: &'static str,
        consumption: EffectCapabilityConsumption,
    ) -> Result<(), EffectStateError> {
        FileBackedEffectStateStore::consume_spend_capability(self, family, consumption)
    }

    fn lookup_mutation(&self, family: &str, key: &EffectIdempotencyKey) -> Option<&EffectMutation> {
        FileBackedEffectStateStore::lookup_mutation(self, family, key)
    }

    fn lookup_finality_intent(
        &self,
        family: &str,
        key: &EffectIdempotencyKey,
    ) -> Option<&EffectFinalityIntent> {
        FileBackedEffectStateStore::lookup_finality_intent(self, family, key)
    }

    fn lookup_finality_record(
        &self,
        family: &str,
        money_movement_id: &str,
    ) -> Option<&EffectFinalityRecord> {
        FileBackedEffectStateStore::lookup_finality_record(self, family, money_movement_id)
    }

    fn record_finality_record(
        &mut self,
        family: &'static str,
        record: EffectFinalityRecord,
    ) -> Result<(), EffectStateError> {
        FileBackedEffectStateStore::record_finality_record(self, family, record)
    }

    fn lookup_finality_event(
        &self,
        family: &str,
        rail: &str,
        provider_event_id: &str,
    ) -> Option<&EffectFinalityEventRecord> {
        FileBackedEffectStateStore::lookup_finality_event(self, family, rail, provider_event_id)
    }

    fn record_finality_event(
        &mut self,
        family: &'static str,
        event: EffectFinalityEventRecord,
    ) -> Result<(), EffectStateError> {
        FileBackedEffectStateStore::record_finality_event(self, family, event)
    }

    fn record_finality_intent(
        &mut self,
        family: &'static str,
        intent: EffectFinalityIntent,
        run_spend: Option<&EffectRunSpendReservation>,
        period_spend: Option<&EffectPeriodSpendReservation>,
    ) -> Result<(), EffectStateError> {
        FileBackedEffectStateStore::record_finality_intent(
            self,
            family,
            intent,
            run_spend,
            period_spend,
        )
    }

    fn seal_run_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError> {
        FileBackedEffectStateStore::seal_run_spend(self, family, input, receipt_ref)
    }

    fn seal_period_spend(
        &mut self,
        family: &'static str,
        input: &EffectStepStateInput,
        receipt_ref: &str,
    ) -> Result<(), EffectStateError> {
        FileBackedEffectStateStore::seal_period_spend(self, family, input, receipt_ref)
    }

    fn escalate_mutation(
        &mut self,
        family: &'static str,
        key: &EffectIdempotencyKey,
    ) -> Result<Option<EffectMutation>, EffectStateError> {
        FileBackedEffectStateStore::escalate_mutation(self, family, key)
    }

    fn record_mutation(
        &mut self,
        family: &'static str,
        mutation: EffectMutation,
    ) -> Result<(), EffectStateError> {
        FileBackedEffectStateStore::record_mutation(self, family, mutation)
    }
}

impl EffectStateLock {
    fn acquire(path: &Path) -> Result<Self, EffectStateError> {
        let parent = path
            .parent()
            .ok_or_else(|| EffectStateError::MissingParent {
                path: path.to_path_buf(),
            })?;
        fs::create_dir_all(parent).map_err(|source| EffectStateError::CreateDirectory {
            path: parent.to_path_buf(),
            source,
        })?;
        let lock_path = effect_state_lock_path(path);
        let started = Instant::now();
        loop {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(file) => {
                    return Ok(Self {
                        path: lock_path,
                        _file: file,
                    });
                }
                Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
                    if started.elapsed() >= EFFECT_STATE_LOCK_TIMEOUT {
                        return Err(EffectStateError::Lock {
                            path: path.to_path_buf(),
                            message: format!("timed out waiting for lock {}", lock_path.display()),
                        });
                    }
                    thread::sleep(EFFECT_STATE_LOCK_RETRY);
                }
                Err(source) => {
                    return Err(EffectStateError::Lock {
                        path: path.to_path_buf(),
                        message: source.to_string(),
                    });
                }
            }
        }
    }
}

impl Drop for EffectStateLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

// rust-style-allow: long-function because run-spend reservation enforces the
// per-run cap through a single sequence of cap, ledger, and tally checks that
// must remain linear so the spend invariant stays verifiable in one place.
fn reserve_run_spend(
    state: &mut EffectFamilyState,
    family: &'static str,
    intent: &EffectFinalityIntent,
    reservation: Option<&EffectRunSpendReservation>,
) -> Result<(), EffectStateError> {
    let Some(reservation) = reservation else {
        return Ok(());
    };
    let ledger_key = run_spend_ledger_key(family, reservation, &intent.currency);
    let entry_key = intent.idempotency_key.index_key();
    let ledger = state
        .run_spend_ledger
        .entry(ledger_key.clone())
        .or_insert_with(|| EffectRunSpendLedgerEntry {
            run_id: reservation.run_id.clone(),
            authority_ref: reservation.authority_ref.clone(),
            currency: intent.currency.clone(),
            max_per_run_units: reservation.max_per_run_units,
            reserved_minor: 0,
            sealed_minor: 0,
            entries: BTreeMap::new(),
        });

    if ledger.run_id != reservation.run_id
        || ledger.authority_ref != reservation.authority_ref
        || ledger.currency != intent.currency
        || ledger.max_per_run_units != reservation.max_per_run_units
    {
        return Err(EffectStateError::RunSpendLedgerConflict { ledger_key });
    }

    if let Some(existing) = ledger.entries.get(&entry_key) {
        if existing.amount_minor == intent.amount_minor {
            return Ok(());
        }
        return Err(EffectStateError::RunSpendLedgerConflict { ledger_key });
    }

    let attempted_minor = ledger.reserved_minor.saturating_add(intent.amount_minor);
    if attempted_minor > ledger.max_per_run_units {
        return Err(EffectStateError::RunSpendCapExceeded {
            run_id: ledger.run_id.clone(),
            authority_ref: ledger.authority_ref.clone(),
            currency: ledger.currency.clone(),
            attempted_minor,
            max_per_run_units: ledger.max_per_run_units,
        });
    }

    ledger.reserved_minor = attempted_minor;
    ledger.entries.insert(
        entry_key,
        EffectRunSpendLedgerItem {
            idempotency_key: intent.idempotency_key.clone(),
            amount_minor: intent.amount_minor,
            status: EffectRunSpendStatus::Reserved,
            receipt_ref: None,
        },
    );
    Ok(())
}

fn finality_record_conflicts(existing: &EffectFinalityRecord, next: &EffectFinalityRecord) -> bool {
    existing.money_movement_id != next.money_movement_id
        || existing.rail != next.rail
        || existing.finality_threshold != next.finality_threshold
        || existing.original_receipt_ref != next.original_receipt_ref
}

fn finality_event_key(rail: &str, provider_event_id: &str) -> String {
    format!("{rail}\u{1f}{provider_event_id}")
}

fn run_spend_ledger_key(
    family: &'static str,
    reservation: &EffectRunSpendReservation,
    currency: &str,
) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}",
        family, reservation.run_id, reservation.authority_ref, currency
    )
}

// rust-style-allow: long-function because period spend reservation enforces the
// per-period cap through a single sequence of cap, ledger, and tally checks
// that must remain linear so the spend invariant stays verifiable in one place.
fn reserve_period_spend(
    state: &mut EffectFamilyState,
    family: &'static str,
    intent: &EffectFinalityIntent,
    reservation: Option<&EffectPeriodSpendReservation>,
) -> Result<(), EffectStateError> {
    let Some(reservation) = reservation else {
        return Ok(());
    };
    let ledger_key = period_spend_ledger_key(family, reservation, &intent.currency);
    let entry_key = intent.idempotency_key.index_key();
    {
        let ledger = state
            .period_spend_ledger
            .entry(ledger_key.clone())
            .or_insert_with(|| EffectPeriodSpendLedgerEntry {
                authority_ref: reservation.authority_ref.clone(),
                currency: intent.currency.clone(),
                max_per_period_units: reservation.max_per_period_units,
                period: reservation.period.clone(),
                window_start: reservation.window_start.clone(),
                reserved_minor: 0,
                sealed_minor: 0,
                entries: BTreeMap::new(),
            });

        if ledger.authority_ref != reservation.authority_ref
            || ledger.currency != intent.currency
            || ledger.max_per_period_units != reservation.max_per_period_units
            || ledger.period != reservation.period
            || ledger.window_start != reservation.window_start
        {
            return Err(EffectStateError::PeriodSpendLedgerConflict { ledger_key });
        }

        if let Some(existing) = ledger.entries.get(&entry_key) {
            if existing.amount_minor == intent.amount_minor {
                return Ok(());
            }
            return Err(EffectStateError::PeriodSpendLedgerConflict { ledger_key });
        }

        let attempted_minor = ledger.reserved_minor.saturating_add(intent.amount_minor);
        if attempted_minor > ledger.max_per_period_units {
            return Err(EffectStateError::PeriodSpendCapExceeded {
                period: ledger.period.clone(),
                window_start: ledger.window_start.clone(),
                authority_ref: ledger.authority_ref.clone(),
                currency: ledger.currency.clone(),
                attempted_minor,
                max_per_period_units: ledger.max_per_period_units,
            });
        }

        ledger.reserved_minor = attempted_minor;
        ledger.entries.insert(
            entry_key,
            EffectRunSpendLedgerItem {
                idempotency_key: intent.idempotency_key.clone(),
                amount_minor: intent.amount_minor,
                status: EffectRunSpendStatus::Reserved,
                receipt_ref: None,
            },
        );
    }
    prune_period_spend_ledgers(state, family, reservation, &intent.currency);
    Ok(())
}

fn prune_period_spend_ledgers(
    state: &mut EffectFamilyState,
    family: &'static str,
    reservation: &EffectPeriodSpendReservation,
    currency: &str,
) {
    let Some(retention_floor) =
        previous_period_window_start(&reservation.period, &reservation.window_start)
    else {
        return;
    };
    let prefix = format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}",
        family, reservation.authority_ref, currency, reservation.period
    );
    state
        .period_spend_ledger
        .retain(|key, ledger| !key.starts_with(&prefix) || ledger.window_start >= retention_floor);
}

fn previous_period_window_start(period: &str, window_start: &str) -> Option<String> {
    let (year, month, day) = parse_civil_date(window_start)?;
    match period {
        "daily" => Some(civil_date_string(days_from_civil(year, month, day) - 1)),
        "weekly" => Some(civil_date_string(days_from_civil(year, month, day) - 7)),
        "monthly" => {
            if month == 1 {
                Some(format!("{:04}-12-01", year - 1))
            } else {
                Some(format!("{year:04}-{:02}-01", month - 1))
            }
        }
        _ => None,
    }
}

fn parse_civil_date(value: &str) -> Option<(i64, u32, u32)> {
    let mut parts = value.split('-');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

fn period_spend_ledger_key(
    family: &'static str,
    reservation: &EffectPeriodSpendReservation,
    currency: &str,
) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        family, reservation.authority_ref, currency, reservation.period, reservation.window_start
    )
}

/// Compute the UTC calendar window a spend falls into for a declared period.
/// Periods are deliberately a closed vocabulary; an unrecognized period fails
/// closed instead of being treated as an unenforced annotation.
pub fn period_window_start(period: &str, unix_seconds: u64) -> Result<String, EffectStateError> {
    let days = (unix_seconds / 86_400) as i64;
    match period {
        "daily" => Ok(civil_date_string(days)),
        "weekly" => {
            // 1970-01-01 was a Thursday; weeks are Monday-aligned.
            let days_from_monday = (days + 3).rem_euclid(7);
            Ok(civil_date_string(days - days_from_monday))
        }
        "monthly" => {
            let (year, month, _day) = civil_from_days(days);
            Ok(format!("{year:04}-{month:02}-01"))
        }
        other => Err(EffectStateError::UnsupportedSpendPeriod {
            period: other.to_owned(),
        }),
    }
}

fn civil_date_string(days: i64) -> String {
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

// Days-from-epoch to proleptic Gregorian civil date (Howard Hinnant's
// `civil_from_days` algorithm), so the window math needs no time crate.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = i64::from(month);
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn load_effect_state(path: &Path) -> Result<EffectStateDocument, EffectStateError> {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|source| EffectStateError::Parse {
                path: path.to_path_buf(),
                source,
            })
            .and_then(|state: EffectStateDocument| {
                if state.schema_version == EFFECT_STATE_SCHEMA_VERSION {
                    Ok(state)
                } else {
                    Err(EffectStateError::UnsupportedSchemaVersion {
                        path: path.to_path_buf(),
                        version: state.schema_version,
                    })
                }
            }),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            Ok(EffectStateDocument::default())
        }
        Err(source) => Err(EffectStateError::Read {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn persist_effect_state(path: &Path, state: &EffectStateDocument) -> Result<(), EffectStateError> {
    let parent = path
        .parent()
        .ok_or_else(|| EffectStateError::MissingParent {
            path: path.to_path_buf(),
        })?;
    fs::create_dir_all(parent).map_err(|source| EffectStateError::CreateDirectory {
        path: parent.to_path_buf(),
        source,
    })?;
    write_json_atomically(path, state)
}

fn effect_state_lock_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("effect-state.json");
    path.with_file_name(format!(".{file_name}.lock"))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HostedFamilyResponse {
    state: EffectFamilyState,
    version: u64,
}

#[derive(Serialize)]
struct HostedFamilyCommitRequest<'a> {
    expected_version: u64,
    state: &'a EffectFamilyState,
}

impl HostedEffectStateEndpoint {
    fn parse(raw: &str) -> Result<Self, EffectStateError> {
        let Some(rest) = raw.strip_prefix("http://") else {
            return Err(EffectStateError::HostedBackendInvalid {
                message: "hosted effect-state endpoint must use http:// loopback".to_owned(),
            });
        };
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let (host, port) =
            authority
                .rsplit_once(':')
                .ok_or_else(|| EffectStateError::HostedBackendInvalid {
                    message: "hosted effect-state endpoint must include a loopback port".to_owned(),
                })?;
        if host != "127.0.0.1" && host != "localhost" {
            return Err(EffectStateError::HostedBackendInvalid {
                message: "hosted effect-state endpoint must be loopback".to_owned(),
            });
        }
        let port =
            port.parse::<u16>()
                .map_err(|source| EffectStateError::HostedBackendInvalid {
                    message: format!("hosted effect-state endpoint port is invalid: {source}"),
                })?;
        let mut base_path = format!("/{path}");
        while base_path.ends_with('/') && base_path.len() > 1 {
            base_path.pop();
        }
        Ok(Self {
            host: host.to_owned(),
            port,
            base_path,
        })
    }
}

fn parse_hosted_response(response: &str) -> Result<(u16, HostedFamilyResponse), EffectStateError> {
    let (head, body) = response.split_once("\r\n\r\n").ok_or_else(|| {
        EffectStateError::HostedBackendTransport {
            message: "hosted effect-state response is missing an HTTP body".to_owned(),
        }
    })?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| EffectStateError::HostedBackendTransport {
            message: "hosted effect-state response is missing a status code".to_owned(),
        })?
        .parse::<u16>()
        .map_err(|source| EffectStateError::HostedBackendTransport {
            message: format!("hosted effect-state status code is invalid: {source}"),
        })?;
    let body = body.trim();
    if body.is_empty() {
        return Err(EffectStateError::HostedBackendTransport {
            message: format!("hosted effect-state status {status} returned no response body"),
        });
    }
    let family =
        serde_json::from_str(body).map_err(|source| EffectStateError::HostedBackendTransport {
            message: format!("hosted effect-state response JSON is invalid: {source}"),
        })?;
    Ok((status, family))
}

fn hosted_family_name_is_safe(family: &str) -> bool {
    !family.is_empty()
        && family
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn hosted_transport_missing() -> EffectStateError {
    EffectStateError::HostedBackendUnsupported {
        message: format!(
            "{RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV} requests {HOSTED_TRANSACTIONAL_BACKEND_KIND}, but this native runtime did not receive a complete hosted effect-state transport"
        ),
    }
}

pub fn consumed_spend_capability_recorded(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    family: &'static str,
    capability_ref: &str,
) -> Result<bool, EffectStateError> {
    let Some(store) = open_supported_effect_state_store(env, cwd)? else {
        return Ok(false);
    };
    Ok(consumed_spend_capability_recorded_in_store(
        store.as_ref(),
        family,
        capability_ref,
    ))
}

pub fn consumed_spend_capability_recorded_in_store(
    store: &(impl EffectStateStore + ?Sized),
    family: &'static str,
    capability_ref: &str,
) -> bool {
    store
        .lookup_consumed_spend_capability(family, capability_ref)
        .is_some()
}

pub fn lookup_effect_idempotency_entry(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    family: &'static str,
    key: &EffectIdempotencyKey,
) -> Result<Option<EffectIdempotencyEntry>, EffectStateError> {
    let Some(store) = open_supported_effect_state_store(env, cwd)? else {
        return Ok(None);
    };
    Ok(lookup_effect_idempotency_entry_in_store(
        store.as_ref(),
        family,
        key,
    ))
}

pub fn lookup_effect_idempotency_entry_in_store(
    store: &(impl EffectStateStore + ?Sized),
    family: &'static str,
    key: &EffectIdempotencyKey,
) -> Option<EffectIdempotencyEntry> {
    store.lookup_idempotency(family, key).cloned()
}

pub fn lookup_effect_mutation(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    family: &'static str,
    key: &EffectIdempotencyKey,
) -> Result<Option<EffectMutation>, EffectStateError> {
    let Some(store) = open_supported_effect_state_store(env, cwd)? else {
        return Ok(None);
    };
    Ok(lookup_effect_mutation_in_store(store.as_ref(), family, key))
}

pub fn lookup_effect_mutation_in_store(
    store: &(impl EffectStateStore + ?Sized),
    family: &'static str,
    key: &EffectIdempotencyKey,
) -> Option<EffectMutation> {
    store.lookup_mutation(family, key).cloned()
}

pub fn record_effect_finality_intent(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    input: &EffectStepStateInput,
) -> Result<(), EffectStateError> {
    let Some(mut store) = open_supported_effect_state_store(env, cwd)? else {
        return Ok(());
    };
    record_effect_finality_intent_in_store(store.as_mut(), input)
}

pub fn record_effect_finality_intent_in_store(
    store: &mut (impl EffectStateStore + ?Sized),
    input: &EffectStepStateInput,
) -> Result<(), EffectStateError> {
    store.record_finality_intent(
        input.family,
        EffectFinalityIntent {
            idempotency_key: input.idempotency_key.clone(),
            rail: input.rail.clone(),
            amount_minor: input.amount_minor,
            currency: input.currency.clone(),
            counterparty: input.counterparty.clone(),
            spend_capability_ref: input.spend_capability_ref.clone(),
            act_id: input.act_id.clone(),
            status: EffectFinalityIntentStatus::Open,
        },
        input.run_spend.as_ref(),
        input.period_spend.as_ref(),
    )
}

pub fn escalate_effect_mutation(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    family: &'static str,
    key: &EffectIdempotencyKey,
) -> Result<Option<EffectMutation>, EffectStateError> {
    let Some(mut store) = open_supported_effect_state_store(env, cwd)? else {
        return Ok(None);
    };
    escalate_effect_mutation_in_store(store.as_mut(), family, key)
}

pub fn escalate_effect_mutation_in_store(
    store: &mut (impl EffectStateStore + ?Sized),
    family: &'static str,
    key: &EffectIdempotencyKey,
) -> Result<Option<EffectMutation>, EffectStateError> {
    store.escalate_mutation(family, key)
}

// rust-style-allow: long-function because effect state persistence binds
// authority, output, receipt, and recovery-state invariants in one transaction.
pub fn persist_effect_step_state(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    input: &EffectStepStateInput,
    outputs: &JsonObject,
    receipt: &runx_contracts::Receipt,
    supervisor_proof: Option<&PaymentSupervisorProof>,
) -> Result<(), EffectStateError> {
    let Some(mut store) = open_supported_effect_state_store(env, cwd)? else {
        return Ok(());
    };
    persist_effect_step_state_in_store(store.as_mut(), input, outputs, receipt, supervisor_proof)
}

// rust-style-allow: long-function because effect state persistence binds
// authority, output, receipt, and recovery-state invariants in one transaction.
pub fn persist_effect_step_state_in_store(
    store: &mut (impl EffectStateStore + ?Sized),
    input: &EffectStepStateInput,
    outputs: &JsonObject,
    receipt: &runx_contracts::Receipt,
    supervisor_proof: Option<&PaymentSupervisorProof>,
) -> Result<(), EffectStateError> {
    let rail_packet = read_effect_evidence_packet(outputs)?;
    let recovery_state = payment_recovery_state(rail_packet.as_ref());
    let rail_touched = rail_packet
        .as_ref()
        .and_then(|packet| packet.result.as_ref())
        .and_then(|result| result.status.as_deref())
        .is_some();

    if rail_touched
        && store
            .lookup_consumed_spend_capability(input.family, &input.spend_capability_ref)
            .is_none()
    {
        store.consume_spend_capability(
            input.family,
            EffectCapabilityConsumption {
                capability_ref: input.spend_capability_ref.clone(),
                idempotency_key: input.idempotency_key.clone(),
                receipt_ref: Some(receipt.id.to_string()),
                recovery_state: Some(recovery_state.clone()),
            },
        )?;
    }

    let proof_ref = rail_packet
        .as_ref()
        .and_then(|packet| packet.proof.as_ref())
        .map(|proof| proof.proof_ref.as_str());

    if let Some(proof_ref) = proof_ref
        && store
            .lookup_idempotency(input.family, &input.idempotency_key)
            .is_none()
    {
        // Validate the supervisor proof only when sealing a new record. A
        // duplicate persist for an already-sealed idempotency key keeps the
        // first record; the sealed-replay path is the guard against forged
        // replays of an existing key.
        let supervisor_proof =
            validate_sealed_supervisor_proof(input, receipt, proof_ref, supervisor_proof)?;
        let result = rail_packet
            .as_ref()
            .and_then(|packet| packet.result.as_ref());
        store.record_idempotency(
            input.family,
            EffectIdempotencyEntry {
                idempotency_key: input.idempotency_key.clone(),
                receipt_ref: receipt.id.to_string(),
                receipt_created_at: receipt.created_at.to_string(),
                receipt_digest: receipt.digest.to_string(),
                rail_proof_ref: proof_ref.to_owned(),
                supervisor_proof: supervisor_proof.clone(),
                amount_minor: result
                    .and_then(|result| result.amount_minor)
                    .unwrap_or(input.amount_minor),
                currency: result
                    .and_then(|result| result.currency.as_deref())
                    .unwrap_or(&input.currency)
                    .to_owned(),
                outputs: replay_safe_outputs(outputs)?,
            },
        )?;
        store.seal_run_spend(input.family, input, &receipt.id)?;
        store.seal_period_spend(input.family, input, &receipt.id)?;
    }

    if rail_touched
        && store
            .lookup_mutation(input.family, &input.idempotency_key)
            .is_none()
    {
        let result = rail_packet
            .as_ref()
            .and_then(|packet| packet.result.as_ref());
        store.record_mutation(
            input.family,
            EffectMutation {
                idempotency_key: input.idempotency_key.clone(),
                rail: result
                    .and_then(|result| result.rail.as_deref())
                    .unwrap_or(&input.rail)
                    .to_owned(),
                amount_minor: result
                    .and_then(|result| result.amount_minor)
                    .unwrap_or(input.amount_minor),
                currency: result
                    .and_then(|result| result.currency.as_deref())
                    .unwrap_or(&input.currency)
                    .to_owned(),
                counterparty: result
                    .and_then(|result| result.counterparty.as_deref())
                    .unwrap_or(&input.counterparty)
                    .to_owned(),
                status: rail_mutation_status(&recovery_state),
                proof_ref: proof_ref.map(str::to_owned),
                recovery_state,
            },
        )?;
    }

    Ok(())
}

fn validate_sealed_supervisor_proof<'a>(
    input: &EffectStepStateInput,
    receipt: &runx_contracts::Receipt,
    proof_ref: &str,
    supervisor_proof: Option<&'a PaymentSupervisorProof>,
) -> Result<&'a PaymentSupervisorProof, EffectStateError> {
    let proof = supervisor_proof.ok_or_else(|| EffectStateError::MissingSupervisorProof {
        proof_ref: proof_ref.to_owned(),
    })?;
    validate_payment_supervisor_proof(
        proof,
        PaymentSupervisorProofMatch {
            proof_ref,
            rail: &input.rail,
            counterparty: &input.counterparty,
            amount_minor: input.amount_minor,
            currency: &input.currency,
            idempotency_key: &input.idempotency_key.key,
            spend_capability_ref: &input.spend_capability_ref,
            act_id: &input.act_id,
            receipt_ref: &receipt.id,
            receipt_digest: &receipt.digest,
        },
    )
    .map_err(|source| EffectStateError::SupervisorProof {
        message: source.to_string(),
    })?;
    Ok(proof)
}

fn replay_safe_outputs(outputs: &JsonObject) -> Result<JsonObject, EffectStateError> {
    let mut safe_outputs = outputs.clone();
    sanitize_replay_payload(&mut safe_outputs);

    let mut stdout_payload = safe_outputs.clone();
    stdout_payload.remove("stdout");
    stdout_payload.remove("stderr");
    stdout_payload.remove("status");
    sanitize_replay_payload(&mut stdout_payload);

    let stdout = serde_json::to_string(&JsonValue::Object(stdout_payload))
        .map_err(|source| EffectStateError::ReplayOutputSerialize { source })?;
    safe_outputs.insert("stdout".to_owned(), JsonValue::String(stdout));
    safe_outputs
        .entry("stderr".to_owned())
        .or_insert_with(|| JsonValue::String(String::new()));
    safe_outputs
        .entry("status".to_owned())
        .or_insert_with(|| JsonValue::String("success".to_owned()));
    Ok(safe_outputs)
}

fn sanitize_replay_payload(payload: &mut JsonObject) {
    let Some(JsonValue::Object(packet)) = payload.get_mut("effect_evidence_packet") else {
        return;
    };
    let Some(JsonValue::Object(data)) = packet.get_mut("data") else {
        return;
    };
    if let Some(JsonValue::Object(proof)) = data.get_mut("rail_proof") {
        proof.remove("rail_session_material_ref");
    }
}

fn payment_recovery_state(packet: Option<&PaymentRailPacket>) -> EffectRecoveryState {
    match packet {
        Some(PaymentRailPacket {
            recovery_status: Some(status),
            ..
        }) if status == "sealed" => EffectRecoveryState::Sealed,
        Some(PaymentRailPacket {
            recovery_status: Some(status),
            ..
        }) if status == "terminal_decline" || status == "escalated" => {
            EffectRecoveryState::Escalated
        }
        Some(PaymentRailPacket {
            recovery_status: Some(status),
            ..
        }) if status == "recoverable_timeout" || status == "partial" || status == "in_flight" => {
            EffectRecoveryState::InFlight
        }
        Some(PaymentRailPacket { proof: Some(_), .. }) => EffectRecoveryState::Sealed,
        _ => EffectRecoveryState::InFlight,
    }
}

fn rail_mutation_status(recovery_state: &EffectRecoveryState) -> EffectMutationStatus {
    match recovery_state {
        EffectRecoveryState::Sealed => EffectMutationStatus::Fulfilled,
        EffectRecoveryState::Escalated => EffectMutationStatus::Escalated,
        EffectRecoveryState::InFlight => EffectMutationStatus::Partial,
    }
}

fn finality_intent_status_for_recovery(
    recovery_state: &EffectRecoveryState,
) -> EffectFinalityIntentStatus {
    match recovery_state {
        EffectRecoveryState::Sealed => EffectFinalityIntentStatus::Sealed,
        EffectRecoveryState::Escalated => EffectFinalityIntentStatus::Escalated,
        EffectRecoveryState::InFlight => EffectFinalityIntentStatus::Open,
    }
}

pub fn resolve_effect_state_path(env: &BTreeMap<String, String>, cwd: &Path) -> Option<PathBuf> {
    env.get(RUNX_EFFECT_STATE_PATH_ENV)
        .filter(|value| !value.trim().is_empty())
        .map(|value| resolve_path(Path::new(value), cwd))
        .or_else(|| {
            env.get(runx_runtime::RUNX_RECEIPT_DIR_ENV)
                .filter(|value| !value.trim().is_empty())
                .map(|value| resolve_path(Path::new(value), cwd).join("effect-state.json"))
        })
}

pub fn hosted_effect_state_backend_is_supported(
    env: &BTreeMap<String, String>,
) -> Result<bool, EffectStateError> {
    resolve_hosted_effect_state_backend(env).map(|backend| backend.is_some())
}

fn open_supported_effect_state_store(
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<Option<Box<dyn EffectStateStore>>, EffectStateError> {
    if let Some(backend) = resolve_hosted_effect_state_backend(env)? {
        return Ok(Some(Box::new(HostedEffectStateStore::open(backend)?)));
    }
    let Some(path) = resolve_effect_state_path(env, cwd) else {
        return Ok(None);
    };
    Ok(Some(Box::new(FileBackedEffectStateStore::open(path)?)))
}

fn resolve_hosted_effect_state_backend(
    env: &BTreeMap<String, String>,
) -> Result<Option<HostedEffectStateBackend>, EffectStateError> {
    let Some(raw) = env
        .get(RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV)
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };

    let backend: HostedEffectStateBackend =
        serde_json::from_str(raw).map_err(|source| EffectStateError::HostedBackendInvalid {
            message: source.to_string(),
        })?;

    if backend.kind != HOSTED_TRANSACTIONAL_BACKEND_KIND {
        return Err(EffectStateError::HostedBackendInvalid {
            message: format!("unsupported backend kind {}", backend.kind),
        });
    }
    if backend.store_ref != HOSTED_EFFECT_STATE_STORE_REF {
        return Err(EffectStateError::HostedBackendInvalid {
            message: format!("unsupported store_ref {}", backend.store_ref),
        });
    }
    if backend.tenant_id.trim().is_empty() {
        return Err(EffectStateError::HostedBackendInvalid {
            message: "tenant_id is required".to_owned(),
        });
    }
    if backend.endpoint_url.is_none() || backend.bearer_token.is_none() {
        return Err(hosted_transport_missing());
    }
    if backend.allowed_families.is_empty() {
        return Err(EffectStateError::HostedBackendInvalid {
            message: "allowed_families is required for hosted effect-state transport".to_owned(),
        });
    }

    Ok(Some(backend))
}

fn resolve_path(path: &Path, cwd: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), EffectStateError> {
    let parent = path
        .parent()
        .ok_or_else(|| EffectStateError::MissingParent {
            path: path.to_path_buf(),
        })?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("effect-state.json");
    let temp_path = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        monotonicish_nanos()
    ));

    let write_result = (|| {
        let mut file = File::create(&temp_path).map_err(|source| EffectStateError::Write {
            path: temp_path.clone(),
            source,
        })?;
        serde_json::to_writer_pretty(&mut file, value).map_err(|source| {
            EffectStateError::Serialize {
                path: temp_path.clone(),
                source,
            }
        })?;
        file.write_all(b"\n")
            .map_err(|source| EffectStateError::Write {
                path: temp_path.clone(),
                source,
            })?;
        file.sync_all().map_err(|source| EffectStateError::Write {
            path: temp_path.clone(),
            source,
        })?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    fs::rename(&temp_path, path).map_err(|source| {
        let _ = fs::remove_file(&temp_path);
        EffectStateError::Write {
            path: path.to_path_buf(),
            source,
        }
    })
}

fn monotonicish_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

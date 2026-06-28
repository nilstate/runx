use std::path::PathBuf;

use thiserror::Error;

use crate::packets::PaymentPacketError;
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

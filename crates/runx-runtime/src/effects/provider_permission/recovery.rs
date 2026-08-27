use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use runx_contracts::{JsonObject, sha256_prefixed};
use serde::{Deserialize, Serialize};

use super::{PROVIDER_PERMISSION_EFFECT_FAMILY, ProviderPermissionAdmission};
#[cfg(feature = "catalog")]
use crate::effects::ProviderEffectUnknown;
use crate::effects::{
    EffectReceiptRequest, EffectStepRequest, ProviderEffectAttempt, ProviderEffectClass,
    ProviderEffectResolved, RuntimeEffectError,
};
use crate::receipts::paths::{ReceiptPathInputs, resolve_receipt_path};
use crate::receipts::store::{LocalReceiptStore, ReceiptStoreError};

const PROVIDER_EFFECT_STATE_SCHEMA: &str = "runx.provider_effect_state.v1";

#[derive(Clone, Debug, PartialEq)]
pub(super) struct ProviderRecoveryContext {
    store_root: PathBuf,
    state_key: String,
    previous_attempt: Option<u32>,
    cached_readback: Option<JsonObject>,
    approval_key: Option<String>,
    approval_actor: Option<String>,
}

impl ProviderRecoveryContext {
    pub(super) fn previous_attempt(&self) -> Option<u32> {
        self.previous_attempt
    }

    #[cfg(any(feature = "catalog", test))]
    pub(super) fn cached_readback(&self) -> Option<&JsonObject> {
        self.cached_readback.as_ref()
    }

    pub(super) fn approval_key(&self) -> Option<&str> {
        self.approval_key.as_deref()
    }

    pub(super) fn approval_actor(&self) -> Option<&str> {
        self.approval_actor.as_deref()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderEffectStateDocument {
    schema: String,
    entries: BTreeMap<String, ProviderEffectStateEntry>,
}

impl Default for ProviderEffectStateDocument {
    fn default() -> Self {
        Self {
            schema: PROVIDER_EFFECT_STATE_SCHEMA.to_owned(),
            entries: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderEffectStateEntry {
    plan_digest: String,
    idempotency_key: String,
    provider: String,
    operation: String,
    target: String,
    attempt: u32,
    phase: ProviderEffectRecoveryPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    readback: Option<JsonObject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval_key: Option<String>,
    approval_actor: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProviderEffectRecoveryPhase {
    Attempting,
    Unknown,
}

pub(super) fn recover_pending_provider_effect(
    request: EffectStepRequest<'_>,
) -> Result<(), RuntimeEffectError> {
    let store_root = provider_effect_store_root(request.env, request.graph_dir);
    let state_key = provider_effect_state_key(&request);
    let Some(state) = read_state(&store_root)? else {
        return Ok(());
    };
    validate_document(&state)?;
    if let Some(entry) = state.entries.get(&state_key) {
        validate_entry_shape(entry)?;
    }
    Ok(())
}

pub(super) fn provider_recovery_context(
    request: &EffectStepRequest<'_>,
    resolved: Option<&ProviderEffectResolved>,
) -> Result<Option<ProviderRecoveryContext>, RuntimeEffectError> {
    let Some(resolved) = resolved else {
        return Ok(None);
    };
    if resolved.intent().class() != ProviderEffectClass::Mutation {
        return Ok(None);
    }
    let store_root = provider_effect_store_root(request.env, request.graph_dir);
    let state_key = provider_effect_state_key(request);
    let previous_entry = read_state(&store_root)?
        .and_then(|state| state.entries.get(&state_key).cloned())
        .map(|entry| {
            validate_entry_for_plan(&entry, resolved)?;
            Ok(entry)
        })
        .transpose()?;
    Ok(Some(ProviderRecoveryContext {
        store_root,
        state_key,
        previous_attempt: previous_entry.as_ref().map(|entry| entry.attempt),
        cached_readback: previous_entry
            .as_ref()
            .and_then(|entry| entry.readback.clone()),
        approval_key: previous_entry
            .as_ref()
            .and_then(|entry| entry.approval_key.clone()),
        approval_actor: previous_entry.and_then(|entry| entry.approval_actor),
    }))
}

#[cfg(any(feature = "catalog", test))]
pub(super) fn persist_provider_attempt(
    admission: &ProviderPermissionAdmission,
    attempt: &ProviderEffectAttempt,
) -> Result<(), RuntimeEffectError> {
    persist_attempt_phase(admission, attempt, ProviderEffectRecoveryPhase::Attempting)
}

#[cfg(feature = "catalog")]
pub(super) fn persist_provider_unknown(
    admission: &ProviderPermissionAdmission,
    unknown: &ProviderEffectUnknown,
) -> Result<(), RuntimeEffectError> {
    persist_attempt_phase(
        admission,
        unknown.attempt(),
        ProviderEffectRecoveryPhase::Unknown,
    )
}

#[cfg(any(feature = "catalog", test))]
pub(super) fn persist_provider_readback(
    admission: &ProviderPermissionAdmission,
    attempt: &ProviderEffectAttempt,
    readback: &JsonObject,
) -> Result<(), RuntimeEffectError> {
    let recovery = admission
        .recovery
        .as_ref()
        .ok_or_else(|| state_error("provider mutation recovery context is missing"))?;
    LocalReceiptStore::new(&recovery.store_root)
        .update_provider_effect_state::<ProviderEffectStateDocument, _>(|state| {
            validate_document_store(state)?;
            let entry = state.entries.get_mut(&recovery.state_key).ok_or_else(|| {
                ReceiptStoreError::MalformedEffectState {
                    path: recovery.store_root.join("provider-effects.json"),
                    message: "provider mutation attempt disappeared before readback persistence"
                        .to_owned(),
                }
            })?;
            validate_entry_for_attempt_store(entry, attempt, &recovery.store_root)?;
            entry.readback = Some(readback.clone());
            Ok(())
        })
        .map_err(receipt_state_error)
}

pub(super) fn persist_provider_finality(
    request: EffectReceiptRequest<'_>,
) -> Result<(), RuntimeEffectError> {
    if !request.output.succeeded() {
        return Ok(());
    }
    let admission = request
        .admission
        .context::<ProviderPermissionAdmission>()
        .ok_or_else(|| state_error("provider admission context is missing"))?;
    let Some(recovery) = admission.recovery.as_ref() else {
        return Ok(());
    };
    let attempt = admission
        .attempt
        .as_ref()
        .ok_or_else(|| state_error("provider mutation attempt is missing"))?;
    let store = LocalReceiptStore::new(&recovery.store_root);
    let state = read_state(&recovery.store_root)?
        .ok_or_else(|| state_error("provider mutation state disappeared before finality"))?;
    let entry = state
        .entries
        .get(&recovery.state_key)
        .ok_or_else(|| state_error("provider mutation state disappeared before finality"))?;
    validate_entry_for_attempt(entry, attempt)?;

    store
        .write_receipt_with_policy(request.receipt, request.signature_policy)
        .map_err(receipt_state_error)?;
    store
        .update_provider_effect_state::<ProviderEffectStateDocument, _>(|state| {
            validate_document_store(state)?;
            let current = state.entries.get(&recovery.state_key).ok_or_else(|| {
                ReceiptStoreError::MalformedEffectState {
                    path: recovery.store_root.join("provider-effects.json"),
                    message: "provider mutation state disappeared before cleanup".to_owned(),
                }
            })?;
            validate_entry_for_attempt_store(current, attempt, &recovery.store_root)?;
            state.entries.remove(&recovery.state_key);
            Ok(())
        })
        .map_err(receipt_state_error)
}

#[cfg(any(feature = "catalog", test))]
fn persist_attempt_phase(
    admission: &ProviderPermissionAdmission,
    attempt: &ProviderEffectAttempt,
    phase: ProviderEffectRecoveryPhase,
) -> Result<(), RuntimeEffectError> {
    let recovery = admission
        .recovery
        .as_ref()
        .ok_or_else(|| state_error("provider mutation recovery context is missing"))?;
    let entry = entry_from_attempt(attempt, phase);
    LocalReceiptStore::new(&recovery.store_root)
        .update_provider_effect_state::<ProviderEffectStateDocument, _>(|state| {
            validate_document_store(state)?;
            if let Some(current) = state.entries.get(&recovery.state_key)
                && current.plan_digest != entry.plan_digest
            {
                return Err(ReceiptStoreError::MalformedEffectState {
                    path: recovery.store_root.join("provider-effects.json"),
                    message: "pending provider mutation belongs to a different approved plan"
                        .to_owned(),
                });
            }
            if let Some(current) = state.entries.get(&recovery.state_key)
                && current.approval_key.is_some()
                && (current.approval_key != entry.approval_key
                    || current.approval_actor != entry.approval_actor)
            {
                return Err(ReceiptStoreError::MalformedEffectState {
                    path: recovery.store_root.join("provider-effects.json"),
                    message: "pending provider mutation approval changed during recovery"
                        .to_owned(),
                });
            }
            let mut entry = entry;
            if let Some(current) = state.entries.get(&recovery.state_key) {
                entry.readback.clone_from(&current.readback);
            }
            state.entries.insert(recovery.state_key.clone(), entry);
            Ok(())
        })
        .map_err(receipt_state_error)
}

#[cfg(any(feature = "catalog", test))]
fn entry_from_attempt(
    attempt: &ProviderEffectAttempt,
    phase: ProviderEffectRecoveryPhase,
) -> ProviderEffectStateEntry {
    let intent = attempt.resolved().intent();
    ProviderEffectStateEntry {
        plan_digest: attempt.resolved().plan_digest().to_owned(),
        idempotency_key: attempt.idempotency_key().to_owned(),
        provider: intent.provider().to_owned(),
        operation: intent.operation().to_owned(),
        target: intent.target().to_owned(),
        attempt: attempt.attempt(),
        phase,
        readback: None,
        approval_key: attempt.approval_key().map(str::to_owned),
        approval_actor: attempt.approval_actor().map(str::to_owned),
    }
}

fn validate_entry_for_plan(
    entry: &ProviderEffectStateEntry,
    resolved: &ProviderEffectResolved,
) -> Result<(), RuntimeEffectError> {
    validate_entry_shape(entry)?;
    let expected_idempotency = format!("runx:{}", resolved.plan_digest());
    let intent = resolved.intent();
    if entry.plan_digest != resolved.plan_digest()
        || entry.idempotency_key != expected_idempotency
        || entry.provider != intent.provider()
        || entry.operation != intent.operation()
        || entry.target != intent.target()
    {
        return Err(state_error(
            "pending provider mutation does not match the currently resolved authority and plan",
        ));
    }
    let has_approval = entry.approval_key.is_some() && entry.approval_actor.is_some();
    if has_approval != resolved.intent().requires_approval() {
        return Err(state_error(
            "pending provider mutation approval does not match the current plan",
        ));
    }
    Ok(())
}

fn validate_entry_for_attempt(
    entry: &ProviderEffectStateEntry,
    attempt: &ProviderEffectAttempt,
) -> Result<(), RuntimeEffectError> {
    validate_entry_for_plan(entry, attempt.resolved())?;
    if entry.attempt != attempt.attempt()
        || entry.approval_key.as_deref() != attempt.approval_key()
        || entry.approval_actor.as_deref() != attempt.approval_actor()
    {
        return Err(state_error(
            "pending provider mutation attempt or authority changed before finality",
        ));
    }
    Ok(())
}

fn validate_entry_for_attempt_store(
    entry: &ProviderEffectStateEntry,
    attempt: &ProviderEffectAttempt,
    store_root: &Path,
) -> Result<(), ReceiptStoreError> {
    validate_entry_for_attempt(entry, attempt).map_err(|error| {
        ReceiptStoreError::MalformedEffectState {
            path: store_root.join("provider-effects.json"),
            message: error.to_string(),
        }
    })
}

fn validate_entry_shape(entry: &ProviderEffectStateEntry) -> Result<(), RuntimeEffectError> {
    let approval_complete = match (&entry.approval_key, &entry.approval_actor) {
        (None, None) => true,
        (Some(key), Some(actor)) => !key.trim().is_empty() && !actor.trim().is_empty(),
        _ => false,
    };
    if entry.attempt == 0
        || entry.plan_digest.trim().is_empty()
        || entry.idempotency_key.trim().is_empty()
        || entry.provider.trim().is_empty()
        || entry.operation.trim().is_empty()
        || entry.target.trim().is_empty()
        || !approval_complete
    {
        return Err(state_error("pending provider mutation state is incomplete"));
    }
    Ok(())
}

fn read_state(
    store_root: &Path,
) -> Result<Option<ProviderEffectStateDocument>, RuntimeEffectError> {
    LocalReceiptStore::new(store_root)
        .read_provider_effect_state()
        .map_err(receipt_state_error)
        .and_then(|state| {
            if let Some(state) = state.as_ref() {
                validate_document(state)?;
            }
            Ok(state)
        })
}

fn validate_document(state: &ProviderEffectStateDocument) -> Result<(), RuntimeEffectError> {
    if state.schema != PROVIDER_EFFECT_STATE_SCHEMA {
        return Err(state_error(format!(
            "provider effect state schema mismatch: expected {PROVIDER_EFFECT_STATE_SCHEMA}, got {}",
            state.schema
        )));
    }
    Ok(())
}

fn validate_document_store(state: &ProviderEffectStateDocument) -> Result<(), ReceiptStoreError> {
    if state.schema == PROVIDER_EFFECT_STATE_SCHEMA {
        Ok(())
    } else {
        Err(ReceiptStoreError::MalformedEffectState {
            path: PathBuf::from("provider-effects.json"),
            message: format!(
                "expected {PROVIDER_EFFECT_STATE_SCHEMA}, got {}",
                state.schema
            ),
        })
    }
}

fn provider_effect_store_root(env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    resolve_receipt_path(ReceiptPathInputs {
        explicit_dir: None,
        runtime_config: None,
        env,
        cwd,
    })
    .path
}

fn provider_effect_state_key(request: &EffectStepRequest<'_>) -> String {
    let run_id = request
        .env
        .get(crate::execution::runner::RUNX_RUN_ID_ENV)
        .map(String::as_str)
        .unwrap_or("local");
    sha256_prefixed(
        format!(
            "{PROVIDER_PERMISSION_EFFECT_FAMILY}\u{0}{run_id}\u{0}{}\u{0}{}",
            request.graph_dir.to_string_lossy(),
            request.step.id
        )
        .as_bytes(),
    )
}

fn receipt_state_error(error: ReceiptStoreError) -> RuntimeEffectError {
    state_error(error.to_string())
}

fn state_error(message: impl Into<String>) -> RuntimeEffectError {
    RuntimeEffectError::Failed {
        family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
        operation: "provider effect state recovery",
        message: message.into(),
    }
}

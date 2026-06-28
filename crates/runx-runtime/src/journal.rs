// rust-style-allow: large-file because the initial journal projection slice
// keeps history filtering and receipt-backed rows together until CLI wiring
// decides the permanent module boundary.
use std::collections::BTreeSet;
use std::fs;
use std::io::ErrorKind;
use std::io::Write;
use std::path::Path;

use runx_contracts::schema::NonEmptyString;
use runx_contracts::{ClosureDisposition, ExecutionEvent, Receipt, ReferenceType};
use runx_receipts::{
    ReceiptFindingCode, ReceiptProofContextProvider, signed_display_identity, verify_receipt_proof,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::lifecycle::receipt_lifecycle_records;
use crate::receipts::paths::safe_receipt_store_label;
use crate::receipts::store::{LocalReceiptStore, ReceiptStoreError};
use crate::receipts::{RuntimeReceiptProofContextProvider, RuntimeReceiptSignaturePolicy};

pub const JOURNAL_PROJECTION_SCHEMA: &str = "runx.journal_projection.v1";
pub const JOURNAL_PROJECTOR_ID: &str = "runx-runtime.local-journal.v1";
pub const HISTORY_PROJECTOR_ID: &str = "runx-runtime.local-history.v1";
pub const RECEIPT_REF_PREFIX: &str = "runx:receipt:";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JournalEntry {
    pub event: ExecutionEvent,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ExecutionJournal {
    entries: Vec<JournalEntry>,
}

impl ExecutionJournal {
    pub fn push(&mut self, event: ExecutionEvent) {
        self.entries.push(JournalEntry { event });
    }

    #[must_use]
    pub fn entries(&self) -> &[JournalEntry] {
        &self.entries
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HistoryFilter {
    pub query: Option<String>,
    pub skill: Option<String>,
    pub status: Option<String>,
    pub source: Option<String>,
    pub actor: Option<String>,
    pub artifact_type: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalHistoryProjection {
    pub projector_id: String,
    pub store_label: String,
    pub receipts: Vec<LocalHistoryReceipt>,
    #[serde(rename = "pendingRuns")]
    pub pending_runs: Vec<PausedRunSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalHistoryReceipt {
    pub id: String,
    pub receipt_ref: String,
    pub name: String,
    pub status: String,
    pub created_at: String,
    pub harness_id: String,
    pub harness_state: String,
    pub summary: String,
    pub source_type: Option<String>,
    pub actors: Vec<String>,
    pub artifact_types: Vec<String>,
    pub verification: ReceiptVerificationProjection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptVerificationProjection {
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PausedRunSummary {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_skill_ref: Option<String>,
    pub selected_runner: Option<String>,
    pub step_ids: Vec<String>,
    pub step_labels: Vec<String>,
    pub ledger_verification: Option<LedgerVerificationProjection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerVerificationProjection {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PausedRunCheckpoint {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub started_at: Option<String>,
    pub resume_skill_ref: Option<String>,
    pub selected_runner: Option<String>,
    pub step_ids: Vec<String>,
    pub step_labels: Vec<String>,
}

pub fn append_paused_run_checkpoint(
    receipt_dir: &Path,
    checkpoint: &PausedRunCheckpoint,
) -> Result<(), std::io::Error> {
    let ledgers_dir = receipt_dir.join("ledgers");
    fs::create_dir_all(&ledgers_dir)?;
    let ledger_path = ledgers_dir.join(format!("{}.jsonl", checkpoint.id));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(ledger_path)?;
    let entry = LedgerEntry {
        entry_type: "run_event".to_owned(),
        data: LedgerEventData {
            kind: "resolution_requested".to_owned(),
            detail: LedgerEventDetail {
                resume_skill_ref: checkpoint.resume_skill_ref.clone(),
                selected_runner: checkpoint.selected_runner.clone(),
                step_ids: checkpoint.step_ids.clone(),
                step_labels: checkpoint.step_labels.clone(),
            },
        },
        meta: LedgerEventMeta {
            created_at: checkpoint.started_at.clone(),
            producer: Some(LedgerEventProducer {
                skill: Some(checkpoint.name.clone()),
                runner: checkpoint.selected_runner.clone(),
            }),
        },
    };
    serde_json::to_writer(&mut file, &entry)?;
    file.write_all(b"\n")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalProjection {
    pub schema: String,
    pub projector_id: String,
    pub receipt_ref: String,
    pub watermark: String,
    pub rows: Vec<JournalProjectionRow>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalProjectionRow {
    pub schema: String,
    pub entry_id: String,
    pub recorded_at: String,
    pub projector_id: String,
    pub source_refs: Vec<String>,
    pub watermark: String,
    pub event_kind: String,
    pub summary: String,
    pub receipt_ref: Option<String>,
    pub harness_ref: Option<String>,
    pub act_ref: Option<String>,
    pub decision_ref: Option<String>,
    pub artifact_refs: Vec<String>,
    pub status: Option<String>,
    pub verification: Option<ReceiptVerificationProjection>,
}

#[derive(Debug, Error)]
pub enum JournalProjectionError {
    #[error(transparent)]
    ReceiptStore(#[from] ReceiptStoreError),
    #[error("invalid {field} timestamp '{value}': expected RFC 3339 timestamp")]
    InvalidTimestamp { field: &'static str, value: String },
    #[error("failed to read local run ledgers")]
    LedgerStoreUnreadable,
}

pub fn list_local_history(
    store: &LocalReceiptStore,
    workspace_base: &Path,
    project_runx_dir: &Path,
    filter: &HistoryFilter,
) -> Result<LocalHistoryProjection, JournalProjectionError> {
    list_local_history_with_policy(
        store,
        workspace_base,
        project_runx_dir,
        filter,
        RuntimeReceiptSignaturePolicy::local_development(),
    )
}

pub fn list_local_history_with_policy(
    store: &LocalReceiptStore,
    workspace_base: &Path,
    project_runx_dir: &Path,
    filter: &HistoryFilter,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<LocalHistoryProjection, JournalProjectionError> {
    list_local_history_with_checkpoints_and_policy(
        store,
        workspace_base,
        project_runx_dir,
        filter,
        &[],
        signature_policy,
    )
}

pub fn list_local_history_with_checkpoints(
    store: &LocalReceiptStore,
    workspace_base: &Path,
    project_runx_dir: &Path,
    filter: &HistoryFilter,
    checkpoints: &[PausedRunCheckpoint],
) -> Result<LocalHistoryProjection, JournalProjectionError> {
    list_local_history_with_checkpoints_and_policy(
        store,
        workspace_base,
        project_runx_dir,
        filter,
        checkpoints,
        RuntimeReceiptSignaturePolicy::local_development(),
    )
}

pub fn list_local_history_with_checkpoints_and_policy(
    store: &LocalReceiptStore,
    workspace_base: &Path,
    project_runx_dir: &Path,
    filter: &HistoryFilter,
    checkpoints: &[PausedRunCheckpoint],
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<LocalHistoryProjection, JournalProjectionError> {
    let label = safe_receipt_store_label(store.root(), workspace_base, project_runx_dir);
    let filter = ResolvedHistoryFilter::parse(filter)?;
    let all_rows = match store.list_without_proof_for_history() {
        Ok(receipts) => receipts
            .iter()
            .map(|receipt| history_row_with_policy(receipt, signature_policy))
            .collect::<Vec<_>>(),
        Err(ReceiptStoreError::MissingStore { .. }) => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    let terminal_ids = all_rows
        .iter()
        .flat_map(|row| [row.id.clone(), row.harness_id.clone()])
        .collect::<BTreeSet<_>>();
    let mut rows = all_rows
        .into_iter()
        .filter(|row| matches_history_filter(row, &filter))
        .collect::<Vec<_>>();
    let mut pending_runs = list_paused_runs(store.root(), &terminal_ids, checkpoints)?
        .into_iter()
        .filter(|row| matches_paused_history_filter(row, &filter))
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    pending_runs.sort_by(|left, right| {
        compare_optional_timestamp_desc(&left.started_at, &right.started_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    if let Some(limit) = filter.limit {
        rows.truncate(limit);
    }
    Ok(LocalHistoryProjection {
        projector_id: HISTORY_PROJECTOR_ID.to_owned(),
        store_label: label.as_str().to_owned(),
        receipts: rows,
        pending_runs,
    })
}

pub fn project_journal_for_receipt(
    store: &LocalReceiptStore,
    receipt_reference: &str,
) -> Result<JournalProjection, JournalProjectionError> {
    let receipt_id = exact_receipt_id(receipt_reference);
    let receipt = store.read_exact(&receipt_id)?;
    Ok(project_receipt_journal(&receipt))
}

#[must_use]
// rust-style-allow: long-function because this projection assembles one sealed
// receipt into a deterministic row set; splitting it before CLI and
// paused-run sources land would obscure the ordering invariants.
pub fn project_receipt_journal(receipt: &Receipt) -> JournalProjection {
    project_receipt_journal_with_policy(receipt, RuntimeReceiptSignaturePolicy::local_development())
}

#[must_use]
// rust-style-allow: long-function because this projection assembles one sealed
// receipt into a deterministic row set; splitting it before CLI and
// paused-run sources land would obscure the ordering invariants.
pub fn project_receipt_journal_with_policy(
    receipt: &Receipt,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> JournalProjection {
    let watermark = receipt_watermark(receipt);
    let receipt_ref = receipt_uri(&receipt.id);
    let harness_ref = receipt.subject.reference.uri.clone().into_string();
    let verification = ReceiptVerificationProjection {
        status: verification_status(receipt, signature_policy),
    };
    let mut rows = receipt_lifecycle_records(
        receipt,
        &receipt_ref,
        &harness_ref,
        closure_status(&receipt.seal.disposition),
    )
    .into_iter()
    .map(|record| JournalProjectionRow {
        schema: JOURNAL_PROJECTION_SCHEMA.to_owned(),
        entry_id: format!("journal:{}:{}", receipt.id, record.entry_key),
        recorded_at: receipt.created_at.to_string(),
        projector_id: JOURNAL_PROJECTOR_ID.to_owned(),
        source_refs: record.source_refs,
        watermark: watermark.clone(),
        event_kind: record.event_kind.to_owned(),
        summary: record.summary,
        receipt_ref: Some(receipt_ref.clone()),
        harness_ref: record.harness_ref,
        act_ref: record.act_ref,
        decision_ref: record.decision_ref,
        artifact_refs: record.artifact_refs,
        status: record.status,
        verification: record.include_verification.then_some(verification.clone()),
    })
    .collect::<Vec<_>>();

    rows.sort_by(|left, right| {
        left.recorded_at
            .cmp(&right.recorded_at)
            .then_with(|| left.entry_id.cmp(&right.entry_id))
    });
    JournalProjection {
        schema: JOURNAL_PROJECTION_SCHEMA.to_owned(),
        projector_id: JOURNAL_PROJECTOR_ID.to_owned(),
        receipt_ref,
        watermark,
        rows,
    }
}

#[must_use]
pub fn receipt_uri(receipt_id: &str) -> String {
    format!("{RECEIPT_REF_PREFIX}{receipt_id}")
}

#[must_use]
pub fn exact_receipt_id(reference: &str) -> String {
    reference
        .strip_prefix(RECEIPT_REF_PREFIX)
        .unwrap_or(reference)
        .to_owned()
}

fn history_row_with_policy(
    receipt: &Receipt,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> LocalHistoryReceipt {
    let identity = signed_display_identity(receipt);
    LocalHistoryReceipt {
        id: receipt.id.to_string(),
        receipt_ref: receipt_uri(&receipt.id),
        name: identity.subject_ref.clone(),
        status: closure_status(&receipt.seal.disposition),
        created_at: receipt.created_at.to_string(),
        harness_id: identity.subject_ref,
        harness_state: subject_state(&receipt.subject.kind, &receipt.seal.disposition),
        summary: receipt.seal.summary.to_string(),
        source_type: Some(identity.source_type),
        actors: identity.actors,
        artifact_types: artifact_types(receipt),
        verification: ReceiptVerificationProjection {
            status: verification_status(receipt, signature_policy),
        },
    }
}

fn matches_history_filter(row: &LocalHistoryReceipt, filter: &ResolvedHistoryFilter) -> bool {
    filter.query.as_ref().is_none_or(|query| {
        row.name.to_lowercase().contains(query)
            || row.id.to_lowercase().contains(query)
            || row
                .source_type
                .as_ref()
                .is_some_and(|source| source.to_lowercase().contains(query))
            || row
                .actors
                .iter()
                .any(|actor| actor.to_lowercase().contains(query))
            || row
                .artifact_types
                .iter()
                .any(|artifact_type| artifact_type.to_lowercase().contains(query))
    }) && filter
        .skill
        .as_ref()
        .is_none_or(|skill| row.name.to_lowercase().contains(skill))
        && filter
            .status
            .as_ref()
            .is_none_or(|status| row.status.to_lowercase() == *status)
        && filter.source.as_ref().is_none_or(|source| {
            row.source_type
                .as_ref()
                .is_some_and(|candidate| candidate.to_lowercase() == *source)
        })
        && filter.actor.as_ref().is_none_or(|actor| {
            row.actors
                .iter()
                .any(|candidate| candidate.to_lowercase() == *actor)
        })
        && filter.artifact_type.as_ref().is_none_or(|artifact_type| {
            row.artifact_types
                .iter()
                .any(|candidate| candidate.to_lowercase() == *artifact_type)
        })
        && matches_timestamp_filter(row.created_at.as_str(), filter)
}

fn matches_paused_history_filter(row: &PausedRunSummary, filter: &ResolvedHistoryFilter) -> bool {
    filter.query.as_ref().is_none_or(|query| {
        row.name.to_lowercase().contains(query)
            || row.id.to_lowercase().contains(query)
            || row
                .selected_runner
                .as_ref()
                .is_some_and(|runner| runner.to_lowercase().contains(query))
    }) && filter
        .skill
        .as_ref()
        .is_none_or(|skill| row.name.to_lowercase().contains(skill))
        && filter
            .status
            .as_ref()
            .is_none_or(|status| row.status.to_lowercase() == *status)
        && filter.source.is_none()
        && filter.actor.is_none()
        && filter.artifact_type.is_none()
        && row.started_at.as_deref().map_or(
            filter.since.is_none() && filter.until.is_none(),
            |started_at| matches_timestamp_filter(started_at, filter),
        )
}

fn matches_timestamp_filter(timestamp: &str, filter: &ResolvedHistoryFilter) -> bool {
    let Some(parsed) = Timestamp::parse(timestamp) else {
        return filter.since.is_none() && filter.until.is_none();
    };
    filter.since.is_none_or(|since| parsed >= since)
        && filter.until.is_none_or(|until| parsed <= until)
}

fn normalized(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|entry| entry.trim().to_lowercase())
        .filter(|entry| !entry.is_empty())
}

fn verification_status(
    receipt: &Receipt,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> String {
    let proof_contexts = RuntimeReceiptProofContextProvider::new(signature_policy);
    let context = proof_contexts.proof_context(receipt);
    let verification = verify_receipt_proof(receipt, &context);
    // The decision -> act-id integrity property is checked inline against
    // `acts[]` by `verify_receipt`; no journal indirection remains.
    if verification.findings.is_empty() {
        if signature_policy.can_report_production_verified() {
            "verified".to_owned()
        } else {
            "unverified".to_owned()
        }
    } else if verification
        .findings
        .iter()
        .all(|finding| matches!(finding.code, ReceiptFindingCode::SignatureVerifierMissing))
    {
        "unverified".to_owned()
    } else {
        "invalid".to_owned()
    }
}

fn receipt_watermark(receipt: &Receipt) -> String {
    format!("{}@{}", receipt_uri(&receipt.id), receipt.created_at)
}

fn artifact_types(receipt: &Receipt) -> Vec<String> {
    let mut types = BTreeSet::new();
    for reference in receipt.acts.iter().flat_map(|act| act.artifact_refs.iter()) {
        if reference.reference_type == ReferenceType::Artifact {
            if let Some(label) = reference.label.as_ref().filter(|label| !label.is_empty()) {
                types.insert(label.clone());
            } else {
                types.insert("artifact".to_owned().into());
            }
        }
    }
    types.into_iter().map(|label| label.into_string()).collect()
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ResolvedHistoryFilter {
    query: Option<String>,
    skill: Option<String>,
    status: Option<String>,
    source: Option<String>,
    actor: Option<String>,
    artifact_type: Option<String>,
    since: Option<Timestamp>,
    until: Option<Timestamp>,
    limit: Option<usize>,
}

impl ResolvedHistoryFilter {
    fn parse(filter: &HistoryFilter) -> Result<Self, JournalProjectionError> {
        Ok(Self {
            query: normalized(&filter.query),
            skill: normalized(&filter.skill),
            status: normalized(&filter.status),
            source: normalized(&filter.source),
            actor: normalized(&filter.actor),
            artifact_type: normalized(&filter.artifact_type),
            since: parse_date_filter("since", &filter.since)?,
            until: parse_date_filter("until", &filter.until)?,
            limit: filter.limit,
        })
    }
}

fn parse_date_filter(
    field: &'static str,
    value: &Option<String>,
) -> Result<Option<Timestamp>, JournalProjectionError> {
    let Some(value) = value
        .as_ref()
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
    else {
        return Ok(None);
    };
    Timestamp::parse(value)
        .map(Some)
        .ok_or_else(|| JournalProjectionError::InvalidTimestamp {
            field,
            value: value.to_owned(),
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Timestamp {
    epoch_seconds: i64,
    nanos: u32,
}

impl Timestamp {
    fn parse(value: &str) -> Option<Self> {
        let (date, time_and_zone) = value.split_once('T')?;
        let (year, month, day) = parse_date(date)?;
        let (time, offset_seconds) = parse_time_and_offset(time_and_zone)?;
        let (hour, minute, second, nanos) = parse_time(time)?;
        let days = days_from_civil(year, month, day)?;
        let local_seconds = days
            .checked_mul(86_400)?
            .checked_add(i64::from(hour) * 3_600)?
            .checked_add(i64::from(minute) * 60)?
            .checked_add(i64::from(second))?;
        Some(Self {
            epoch_seconds: local_seconds.checked_sub(i64::from(offset_seconds))?,
            nanos,
        })
    }
}

fn parse_date(value: &str) -> Option<(i32, u32, u32)> {
    let mut parts = value.split('-');
    let year = parse_i32(parts.next()?)?;
    let month = parse_u32(parts.next()?)?;
    let day = parse_u32(parts.next()?)?;
    if parts.next().is_some()
        || !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
    {
        return None;
    }
    Some((year, month, day))
}

fn parse_time_and_offset(value: &str) -> Option<(&str, i32)> {
    if let Some(time) = value.strip_suffix('Z') {
        return Some((time, 0));
    }
    let offset_index = value
        .char_indices()
        .skip(1)
        .find_map(|(index, character)| matches!(character, '+' | '-').then_some(index))?;
    let time = &value[..offset_index];
    let offset = &value[offset_index..];
    let sign = if offset.starts_with('+') { 1 } else { -1 };
    let mut parts = offset[1..].split(':');
    let hours = parse_i32(parts.next()?)?;
    let minutes = parse_i32(parts.next()?)?;
    if parts.next().is_some() || !(0..=23).contains(&hours) || !(0..=59).contains(&minutes) {
        return None;
    }
    Some((time, sign * ((hours * 3_600) + (minutes * 60))))
}

fn parse_time(value: &str) -> Option<(u32, u32, u32, u32)> {
    let mut parts = value.split(':');
    let hour = parse_u32(parts.next()?)?;
    let minute = parse_u32(parts.next()?)?;
    let seconds = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let (second_text, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    let second = parse_u32(second_text)?;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    Some((hour, minute, second, parse_nanos(fraction)?))
}

fn parse_nanos(value: &str) -> Option<u32> {
    if value.is_empty() {
        return Some(0);
    }
    if value.len() > 9 || !value.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let mut nanos = parse_u32(value)?;
    for _ in value.len()..9 {
        nanos = nanos.checked_mul(10)?;
    }
    Some(nanos)
}

fn parse_i32(value: &str) -> Option<i32> {
    if value.is_empty() {
        return None;
    }
    value.parse().ok()
}

fn parse_u32(value: &str) -> Option<u32> {
    if value.is_empty() || !value.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    let year = i64::from(year) - i64::from((month <= 2) as i32);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day = i64::from(day);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era.checked_mul(146_097)?
        .checked_add(day_of_era)?
        .checked_sub(719_468)
}

fn list_paused_runs(
    receipt_dir: &Path,
    terminal_ids: &BTreeSet<String>,
    checkpoints: &[PausedRunCheckpoint],
) -> Result<Vec<PausedRunSummary>, JournalProjectionError> {
    let mut summaries = Vec::new();
    summaries.extend(
        checkpoints
            .iter()
            .filter(|checkpoint| !terminal_ids.contains(checkpoint.id.as_str()))
            .map(paused_run_from_checkpoint),
    );
    let ledgers_dir = receipt_dir.join("ledgers");
    let entries = match fs::read_dir(&ledgers_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(summaries),
        Err(_) => return Err(JournalProjectionError::LedgerStoreUnreadable),
    };
    for entry in entries {
        let entry = entry.map_err(|_| JournalProjectionError::LedgerStoreUnreadable)?;
        let path = entry.path();
        let Some(run_id) = ledger_run_id(&path) else {
            continue;
        };
        if terminal_ids.contains(run_id.as_str())
            || summaries.iter().any(|summary| summary.id == run_id)
        {
            continue;
        }
        if let Some(summary) = paused_run_from_ledger(&run_id, &path)? {
            summaries.push(summary);
        }
    }
    Ok(summaries)
}

fn paused_run_from_checkpoint(checkpoint: &PausedRunCheckpoint) -> PausedRunSummary {
    PausedRunSummary {
        id: checkpoint.id.clone(),
        name: checkpoint.name.clone(),
        kind: checkpoint.kind.clone(),
        status: "paused".to_owned(),
        started_at: checkpoint.started_at.clone(),
        resume_skill_ref: checkpoint.resume_skill_ref.clone(),
        selected_runner: checkpoint.selected_runner.clone(),
        step_ids: checkpoint.step_ids.clone(),
        step_labels: checkpoint.step_labels.clone(),
        ledger_verification: None,
    }
}

fn ledger_run_id(path: &Path) -> Option<String> {
    if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return None;
    }
    let run_id = path.file_stem()?.to_str()?;
    if !(run_id.starts_with("rx_") || run_id.starts_with("gx_") || run_id.starts_with("run_"))
        || !run_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return None;
    }
    Some(run_id.to_owned())
}

fn paused_run_from_ledger(
    run_id: &str,
    path: &Path,
) -> Result<Option<PausedRunSummary>, JournalProjectionError> {
    let contents =
        fs::read_to_string(path).map_err(|_| JournalProjectionError::LedgerStoreUnreadable)?;
    let mut events = Vec::new();
    for (index, line) in contents.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value = match serde_json::from_str::<LedgerLine>(line) {
            Ok(value) => value,
            Err(error) => {
                return Ok(Some(invalid_paused_run(
                    run_id,
                    format!("line {} is not valid JSON: {error}", index + 1),
                )));
            }
        };
        if let Some(event) = ledger_event(value) {
            events.push(event);
        }
    }
    Ok(paused_run_from_events(run_id, &events))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum LedgerLine {
    Wrapped { entry: LedgerEntry },
    Entry(LedgerEntry),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct LedgerEntry {
    #[serde(rename = "type")]
    entry_type: String,
    data: LedgerEventData,
    meta: LedgerEventMeta,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct LedgerEventData {
    kind: String,
    #[serde(default)]
    detail: LedgerEventDetail,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct LedgerEventDetail {
    #[serde(default)]
    resume_skill_ref: Option<String>,
    #[serde(default)]
    selected_runner: Option<String>,
    #[serde(default)]
    step_ids: Vec<String>,
    #[serde(default)]
    step_labels: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct LedgerEventMeta {
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    producer: Option<LedgerEventProducer>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct LedgerEventProducer {
    #[serde(default)]
    skill: Option<String>,
    #[serde(default)]
    runner: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LedgerRunEvent {
    kind: String,
    created_at: Option<String>,
    skill_name: Option<String>,
    runner: Option<String>,
    resume_skill_ref: Option<String>,
    selected_runner: Option<String>,
    step_ids: Vec<String>,
    step_labels: Vec<String>,
}

fn ledger_event(value: LedgerLine) -> Option<LedgerRunEvent> {
    let entry = match value {
        LedgerLine::Wrapped { entry } | LedgerLine::Entry(entry) => entry,
    };
    if entry.entry_type != "run_event" {
        return None;
    }
    let producer = entry.meta.producer;
    Some(LedgerRunEvent {
        kind: entry.data.kind,
        created_at: entry.meta.created_at,
        skill_name: producer.as_ref().and_then(|value| value.skill.clone()),
        runner: producer.and_then(|value| value.runner),
        resume_skill_ref: entry.data.detail.resume_skill_ref,
        selected_runner: entry.data.detail.selected_runner,
        step_ids: clean_string_array(entry.data.detail.step_ids),
        step_labels: clean_string_array(entry.data.detail.step_labels),
    })
}

fn paused_run_from_events(run_id: &str, events: &[LedgerRunEvent]) -> Option<PausedRunSummary> {
    let mut started_at = None;
    for event in events {
        if event.kind == "run_started" {
            started_at = event.created_at.clone();
        }
    }
    for event in events.iter().rev() {
        if matches!(
            event.kind.as_str(),
            "run_completed" | "run_failed" | "graph_completed"
        ) {
            return None;
        }
        if matches!(
            event.kind.as_str(),
            "resolution_requested" | "step_waiting_resolution"
        ) {
            return Some(PausedRunSummary {
                id: run_id.to_owned(),
                name: event
                    .skill_name
                    .clone()
                    .unwrap_or_else(|| run_id.to_owned()),
                kind: RUN_KIND.to_owned(),
                status: "paused".to_owned(),
                started_at: started_at.or_else(|| event.created_at.clone()),
                resume_skill_ref: event.resume_skill_ref.clone(),
                selected_runner: event
                    .selected_runner
                    .clone()
                    .or_else(|| event.runner.clone()),
                step_ids: event.step_ids.clone(),
                step_labels: event.step_labels.clone(),
                ledger_verification: Some(LedgerVerificationProjection {
                    status: "valid".to_owned(),
                    reason: None,
                }),
            });
        }
    }
    None
}

fn invalid_paused_run(run_id: &str, reason: String) -> PausedRunSummary {
    PausedRunSummary {
        id: run_id.to_owned(),
        name: run_id.to_owned(),
        kind: RUN_KIND.to_owned(),
        status: "paused".to_owned(),
        started_at: None,
        resume_skill_ref: None,
        selected_runner: None,
        step_ids: Vec::new(),
        step_labels: Vec::new(),
        ledger_verification: Some(LedgerVerificationProjection {
            status: "invalid".to_owned(),
            reason: Some(reason),
        }),
    }
}

const RUN_KIND: &str = "runx.receipt.v1";

fn clean_string_array(items: Vec<String>) -> Vec<String> {
    items
        .into_iter()
        .filter(|item| !item.trim().is_empty())
        .collect()
}

fn compare_optional_timestamp_desc(
    left: &Option<String>,
    right: &Option<String>,
) -> std::cmp::Ordering {
    match (
        left.as_deref().and_then(Timestamp::parse),
        right.as_deref().and_then(Timestamp::parse),
    ) {
        (Some(left), Some(right)) => right.cmp(&left),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn subject_state(_kind: &NonEmptyString, disposition: &ClosureDisposition) -> String {
    if matches!(disposition, ClosureDisposition::Closed) {
        return "sealed".to_owned();
    }
    closure_status(disposition)
}

fn closure_status(disposition: &ClosureDisposition) -> String {
    disposition.label().to_owned()
}

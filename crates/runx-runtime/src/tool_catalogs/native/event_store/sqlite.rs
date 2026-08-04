use runx_contracts::{JsonObject, JsonValue};
use rusqlite::{Transaction, TransactionBehavior};

use crate::RuntimeError;

use super::input::{
    AppendInput, AppendRequest, ListHeadsInput, ListHeadsRequest, ReadEventsInput,
    ReadEventsRequest, ReadProjectionInput, SourceIdentity,
};
use super::model;
use super::{
    APPEND_TOOL, LIST_HEADS_TOOL, NativeInvocation, READ_EVENTS_TOOL, READ_PROJECTION_TOOL,
    invalid_input,
};

mod migration;
mod queries;
mod schema;

pub(super) use migration::migrate_event_store_database;

pub(super) fn append(
    invocation: &NativeInvocation<'_, AppendInput>,
    binding: &JsonObject,
    request: AppendRequest<'_>,
) -> Result<JsonValue, RuntimeError> {
    let mut connection = schema::connection(APPEND_TOOL, invocation, binding)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error(APPEND_TOOL, "starting append transaction", error))?;
    let committed_at = request.observed_at.unwrap_or(invocation.observed_at);
    append_in_transaction(transaction, request, committed_at)
}

fn append_in_transaction(
    transaction: Transaction<'_>,
    request: AppendRequest<'_>,
    committed_at: &str,
) -> Result<JsonValue, RuntimeError> {
    let current_projection = queries::projection(&transaction, request.source, APPEND_TOOL)?;
    let current = current_projection.version;
    let next_version = current
        .checked_add(1)
        .ok_or_else(|| invalid_input(APPEND_TOOL, "stream version exceeds supported range"))?;
    let proposed = model::record(
        request.source,
        next_version,
        request.idempotency_key,
        request.event,
        committed_at,
    )?;
    if let Some(existing) = queries::existing_event(
        &transaction,
        request.source,
        request.idempotency_key,
        APPEND_TOOL,
    )? {
        return finish_replay(
            transaction,
            request,
            current,
            current_projection.projection_digest,
            existing,
            &proposed.event_digest,
        );
    }
    if current != request.expected_version {
        return finish_version_conflict(
            transaction,
            request,
            current,
            current_projection.projection_digest,
            &proposed.event_digest,
        );
    }
    commit_append(transaction, request.source, current_projection, proposed)
}

fn finish_replay(
    transaction: Transaction<'_>,
    request: AppendRequest<'_>,
    current: u64,
    projection_digest: String,
    existing: model::EventRecord,
    proposed_digest: &str,
) -> Result<JsonValue, RuntimeError> {
    transaction
        .commit()
        .map_err(|error| database_error(APPEND_TOOL, "closing replay transaction", error))?;
    if existing.event_digest != proposed_digest {
        return model::conflict_result(
            request.source,
            current,
            request.idempotency_key,
            proposed_digest,
            "idempotency key was reused with different event content".to_owned(),
            projection_digest,
        );
    }
    model::append_result(
        request.source,
        "idempotent_replay",
        current,
        current,
        &existing,
        projection_digest,
    )
}

fn finish_version_conflict(
    transaction: Transaction<'_>,
    request: AppendRequest<'_>,
    current: u64,
    projection_digest: String,
    event_digest: &str,
) -> Result<JsonValue, RuntimeError> {
    transaction
        .commit()
        .map_err(|error| database_error(APPEND_TOOL, "closing conflict transaction", error))?;
    model::conflict_result(
        request.source,
        current,
        request.idempotency_key,
        event_digest,
        format!(
            "expected version {}, got {current}",
            request.expected_version
        ),
        projection_digest,
    )
}

fn commit_append(
    transaction: Transaction<'_>,
    source: SourceIdentity<'_>,
    current_projection: model::Projection,
    proposed: model::EventRecord,
) -> Result<JsonValue, RuntimeError> {
    let current = current_projection.version;
    let next_projection = model::advance_projection(&current_projection, &proposed)?;
    queries::insert_event(&transaction, source, &proposed)?;
    queries::upsert_head(
        &transaction,
        source,
        &proposed,
        &next_projection.projection_digest,
    )?;
    let projection_digest = next_projection.projection_digest;
    transaction
        .commit()
        .map_err(|error| database_error(APPEND_TOOL, "committing event append", error))?;
    model::append_result(
        source,
        "committed",
        current,
        proposed.version,
        &proposed,
        projection_digest,
    )
}

pub(super) fn read_events(
    invocation: &NativeInvocation<'_, ReadEventsInput>,
    binding: &JsonObject,
    request: ReadEventsRequest<'_>,
) -> Result<JsonValue, RuntimeError> {
    let connection = schema::connection(READ_EVENTS_TOOL, invocation, binding)?;
    let projection = queries::projection(&connection, request.source, READ_EVENTS_TOOL)?;
    let current = projection.version;
    let (events, has_more) = queries::read_event_page(&connection, &request)?;
    let next_after_version = events
        .last()
        .map(|event| event.version)
        .unwrap_or_else(|| request.after_version.unwrap_or(current));
    model::events_result(
        request.source,
        current,
        &events,
        request.limit,
        next_after_version,
        has_more,
        projection.projection_digest,
    )
}

pub(super) fn read_projection(
    invocation: &NativeInvocation<'_, ReadProjectionInput>,
    binding: &JsonObject,
    source: SourceIdentity<'_>,
) -> Result<JsonValue, RuntimeError> {
    let connection = schema::connection(READ_PROJECTION_TOOL, invocation, binding)?;
    let projection = queries::projection(&connection, source, READ_PROJECTION_TOOL)?;
    model::projection_result(source, &projection)
}

pub(super) fn list_heads(
    invocation: &NativeInvocation<'_, ListHeadsInput>,
    binding: &JsonObject,
    request: ListHeadsRequest<'_>,
) -> Result<JsonValue, RuntimeError> {
    let connection = schema::connection(LIST_HEADS_TOOL, invocation, binding)?;
    let mut heads = queries::read_heads(&connection, &request)?;
    let has_more = heads.len() > request.limit;
    heads.truncate(request.limit);
    model::heads_result(
        request.data_source_ref,
        request.resource,
        request.limit,
        &heads,
        has_more,
    )
}

pub(super) fn sql_i64(tool: &str, field: &str, value: u64) -> Result<i64, RuntimeError> {
    i64::try_from(value).map_err(|_| invalid_input(tool, format!("{field} exceeds SQLite limits")))
}

pub(super) fn database_error(tool: &str, operation: &str, error: rusqlite::Error) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: tool.to_owned(),
        message: format!("SQLite event store failed while {operation}: {error}"),
    }
}

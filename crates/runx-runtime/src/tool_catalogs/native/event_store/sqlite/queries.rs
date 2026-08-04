use runx_contracts::JsonObject;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::RuntimeError;

use super::super::input::{ListHeadsRequest, ReadEventsRequest, SourceIdentity};
use super::super::model::{self, EventRecord, Projection, StreamHead};
use super::super::{APPEND_TOOL, LIST_HEADS_TOOL, READ_EVENTS_TOOL};
use super::{database_error, sql_i64};

pub(super) fn existing_event(
    connection: &Connection,
    source: SourceIdentity<'_>,
    idempotency_key: &str,
    tool: &str,
) -> Result<Option<EventRecord>, RuntimeError> {
    connection
        .query_row(
            "SELECT event_ref, version, event_type, event_digest, idempotency_key, committed_at, event_json FROM runx_events WHERE data_source_ref = ?1 AND resource = ?2 AND aggregate_id = ?3 AND idempotency_key = ?4 LIMIT 1",
            params![source.data_source_ref, source.resource, source.aggregate_id, idempotency_key],
            event_record,
        )
        .optional()
        .map_err(|error| database_error(tool, "reading idempotent event", error))
}

pub(super) fn insert_event(
    connection: &Connection,
    source: SourceIdentity<'_>,
    record: &EventRecord,
) -> Result<(), RuntimeError> {
    let event_json = serde_json::to_string(&record.event)
        .map_err(|error| RuntimeError::json("serializing event for SQLite", error))?;
    connection
        .execute(
            "INSERT INTO runx_events (data_source_ref, resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                source.data_source_ref,
                source.resource,
                source.aggregate_id,
                sql_i64(APPEND_TOOL, "event version", record.version)?,
                record.idempotency_key,
                record.event_ref,
                record.event_type,
                record.event_digest,
                event_json,
                record.committed_at,
            ],
        )
        .map_err(|error| database_error(APPEND_TOOL, "inserting event", error))?;
    Ok(())
}

pub(super) fn upsert_head(
    connection: &Connection,
    source: SourceIdentity<'_>,
    record: &EventRecord,
    projection_digest: &str,
) -> Result<(), RuntimeError> {
    let event_json = serde_json::to_string(&record.event)
        .map_err(|error| RuntimeError::json("serializing stream head for SQLite", error))?;
    connection
        .execute(
            "INSERT INTO runx_stream_heads (data_source_ref, resource, aggregate_id, version, event_ref, event_type, event_digest, idempotency_key, event_json, committed_at, projection_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT (data_source_ref, resource, aggregate_id) DO UPDATE SET version = excluded.version, event_ref = excluded.event_ref, event_type = excluded.event_type, event_digest = excluded.event_digest, idempotency_key = excluded.idempotency_key, event_json = excluded.event_json, committed_at = excluded.committed_at, projection_digest = excluded.projection_digest",
            params![
                source.data_source_ref,
                source.resource,
                source.aggregate_id,
                sql_i64(APPEND_TOOL, "head version", record.version)?,
                record.event_ref,
                record.event_type,
                record.event_digest,
                record.idempotency_key,
                event_json,
                record.committed_at,
                projection_digest,
            ],
        )
        .map_err(|error| database_error(APPEND_TOOL, "updating stream head", error))?;
    Ok(())
}

pub(super) fn read_event_page(
    connection: &Connection,
    request: &ReadEventsRequest<'_>,
) -> Result<(Vec<EventRecord>, bool), RuntimeError> {
    let query_limit = if request.after_version.is_some() {
        request.limit + 1
    } else {
        request.limit
    };
    let limit = sql_i64(READ_EVENTS_TOOL, "event limit", query_limit as u64)?;
    let mut events = if let Some(after) = request.after_version {
        let mut statement = connection
            .prepare(
                "SELECT event_ref, version, event_type, event_digest, idempotency_key, committed_at, event_json FROM runx_events WHERE data_source_ref = ?1 AND resource = ?2 AND aggregate_id = ?3 AND version > ?4 ORDER BY version ASC LIMIT ?5",
            )
            .map_err(|error| database_error(READ_EVENTS_TOOL, "preparing forward event read", error))?;
        collect_events(
            &mut statement,
            params![
                request.source.data_source_ref,
                request.source.resource,
                request.source.aggregate_id,
                sql_i64(READ_EVENTS_TOOL, "after_version", after)?,
                limit
            ],
        )?
    } else {
        let mut statement = connection
            .prepare(
                "SELECT event_ref, version, event_type, event_digest, idempotency_key, committed_at, event_json FROM runx_events WHERE data_source_ref = ?1 AND resource = ?2 AND aggregate_id = ?3 ORDER BY version DESC LIMIT ?4",
            )
            .map_err(|error| database_error(READ_EVENTS_TOOL, "preparing latest event read", error))?;
        let mut events = collect_events(
            &mut statement,
            params![
                request.source.data_source_ref,
                request.source.resource,
                request.source.aggregate_id,
                limit
            ],
        )?;
        events.reverse();
        events
    };
    let has_more = request.after_version.is_some() && events.len() > request.limit;
    events.truncate(request.limit);
    events.shrink_to_fit();
    Ok((events, has_more))
}

pub(super) fn projection(
    connection: &Connection,
    source: SourceIdentity<'_>,
    tool: &str,
) -> Result<Projection, RuntimeError> {
    connection
        .query_row(
            "SELECT version, event_ref, event_type, event_digest, projection_digest FROM runx_stream_heads WHERE data_source_ref = ?1 AND resource = ?2 AND aggregate_id = ?3",
            params![source.data_source_ref, source.resource, source.aggregate_id],
            |row| {
                let version = row.get::<_, i64>(0)?;
                let version = u64::try_from(version).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Integer,
                        Box::new(error),
                    )
                })?;
                Ok(Projection {
                    aggregate_id: source.aggregate_id.to_owned(),
                    resource: source.resource.to_owned(),
                    version,
                    event_count: version,
                    last_event_ref: Some(row.get(1)?),
                    last_event_type: Some(row.get(2)?),
                    last_event_digest: Some(row.get(3)?),
                    projection_digest: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| database_error(tool, "reading stream projection", error))?
        .map_or_else(|| model::empty_projection(source), Ok)
}

pub(super) fn read_heads(
    connection: &Connection,
    request: &ListHeadsRequest<'_>,
) -> Result<Vec<StreamHead>, RuntimeError> {
    let cursor = model::decode_cursor(request.cursor)?;
    let mut query = String::from(
        "SELECT aggregate_id, event_ref, version, event_type, event_digest, idempotency_key, committed_at, event_json FROM runx_stream_heads WHERE data_source_ref = ? AND resource = ?",
    );
    let mut parameters = vec![
        SqlValue::Text(request.data_source_ref.to_owned()),
        SqlValue::Text(request.resource.to_owned()),
    ];
    if !request.event_types.is_empty() {
        query.push_str(" AND event_type IN (");
        query.push_str(&vec!["?"; request.event_types.len()].join(","));
        query.push(')');
        parameters.extend(
            request
                .event_types
                .iter()
                .map(|value| SqlValue::Text((*value).to_owned())),
        );
    }
    if let Some(cursor) = cursor {
        query.push_str(" AND (committed_at < ? OR (committed_at = ? AND aggregate_id > ?))");
        parameters.push(SqlValue::Text(cursor.committed_at.clone()));
        parameters.push(SqlValue::Text(cursor.committed_at));
        parameters.push(SqlValue::Text(cursor.aggregate_id));
    }
    query.push_str(" ORDER BY committed_at DESC, aggregate_id ASC LIMIT ?");
    parameters.push(SqlValue::Integer(sql_i64(
        LIST_HEADS_TOOL,
        "stream-head limit",
        (request.limit + 1) as u64,
    )?));

    let mut statement = connection
        .prepare(&query)
        .map_err(|error| database_error(LIST_HEADS_TOOL, "preparing stream-head read", error))?;
    statement
        .query_map(params_from_iter(parameters.iter()), |row| {
            Ok(StreamHead {
                aggregate_id: row.get(0)?,
                event: event_record_from_offset(row, 1)?,
            })
        })
        .map_err(|error| database_error(LIST_HEADS_TOOL, "reading stream heads", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| database_error(LIST_HEADS_TOOL, "decoding stream heads", error))
}

fn collect_events<P>(
    statement: &mut rusqlite::Statement<'_>,
    parameters: P,
) -> Result<Vec<EventRecord>, RuntimeError>
where
    P: rusqlite::Params,
{
    statement
        .query_map(parameters, event_record)
        .map_err(|error| database_error(READ_EVENTS_TOOL, "reading events", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| database_error(READ_EVENTS_TOOL, "decoding events", error))
}

fn event_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventRecord> {
    event_record_from_offset(row, 0)
}

fn event_record_from_offset(
    row: &rusqlite::Row<'_>,
    offset: usize,
) -> rusqlite::Result<EventRecord> {
    let version = row.get::<_, i64>(offset + 1)?;
    let event_json = row.get::<_, String>(offset + 6)?;
    let event = serde_json::from_str::<JsonObject>(&event_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            offset + 6,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(EventRecord {
        event_ref: row.get(offset)?,
        version: u64::try_from(version).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                offset + 1,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })?,
        event_type: row.get(offset + 2)?,
        event_digest: row.get(offset + 3)?,
        idempotency_key: row.get(offset + 4)?,
        committed_at: row.get(offset + 5)?,
        event,
    })
}

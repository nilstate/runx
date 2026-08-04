use rusqlite::{Connection, OptionalExtension, params};

use crate::RuntimeError;

use super::snapshot::{
    StoredEvent, advance_projection_digest, decode_event, empty_projection_digest, validate_event,
};
use super::{OPERATION, database_error, invalid};

pub(super) fn rebuild_stream_heads(connection: &Connection) -> Result<(), RuntimeError> {
    let mut cursor: Option<(String, String, String)> = None;
    while let Some(key) = next_stream_key(connection, cursor.as_ref())? {
        let (head, projection_digest) = read_stream(connection, &key)?;
        insert_stream_head(connection, &head, &projection_digest)?;
        cursor = Some(key);
    }
    Ok(())
}

fn next_stream_key(
    connection: &Connection,
    after: Option<&(String, String, String)>,
) -> Result<Option<(String, String, String)>, RuntimeError> {
    let row = if let Some((source, resource, aggregate_id)) = after {
        connection
            .query_row(
                "SELECT data_source_ref, resource, aggregate_id FROM runx_events
                 WHERE (data_source_ref, resource, aggregate_id) > (?1, ?2, ?3)
                 ORDER BY data_source_ref, resource, aggregate_id LIMIT 1",
                params![source, resource, aggregate_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
    } else {
        connection
            .query_row(
                "SELECT data_source_ref, resource, aggregate_id FROM runx_events
                 ORDER BY data_source_ref, resource, aggregate_id LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
    };
    row.map_err(|error| database_error(OPERATION, "paging migrated stream identities", error))
}

fn read_stream(
    connection: &Connection,
    key: &(String, String, String),
) -> Result<(StoredEvent, String), RuntimeError> {
    let mut statement = connection
        .prepare(
            "SELECT data_source_ref, resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at
             FROM runx_events WHERE data_source_ref = ?1 AND resource = ?2 AND aggregate_id = ?3
             ORDER BY version",
        )
        .map_err(|error| database_error(OPERATION, "preparing migrated stream", error))?;
    let mut rows = statement
        .query(params![key.0, key.1, key.2])
        .map_err(|error| database_error(OPERATION, "reading migrated stream", error))?;
    let mut projection_digest = empty_projection_digest()?;
    let mut previous_version = 0_u64;
    let mut head = None;
    while let Some(row) = rows
        .next()
        .map_err(|error| database_error(OPERATION, "iterating migrated stream", error))?
    {
        let event = decode_event(row)?;
        validate_event(&event)?;
        if event.version != previous_version.saturating_add(1) {
            return Err(invalid("event stream versions are not contiguous"));
        }
        projection_digest =
            advance_projection_digest(event.version, &projection_digest, &event.event_digest)?;
        previous_version = event.version;
        head = Some(event);
    }
    head.map(|head| (head, projection_digest))
        .ok_or_else(|| invalid("migrated stream identity had no events"))
}

fn insert_stream_head(
    connection: &Connection,
    event: &StoredEvent,
    projection_digest: &str,
) -> Result<(), RuntimeError> {
    connection
        .execute(
            "INSERT INTO runx_stream_heads (data_source_ref, resource, aggregate_id, version, event_ref, event_type, event_digest, idempotency_key, event_json, committed_at, projection_digest)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                event.data_source_ref,
                event.resource,
                event.aggregate_id,
                i64::try_from(event.version)
                    .map_err(|_| invalid("event version exceeds SQLite limits"))?,
                event.event_ref,
                event.event_type,
                event.event_digest,
                event.idempotency_key,
                event.event_json,
                event.committed_at,
                projection_digest,
            ],
        )
        .map(|_| ())
        .map_err(|error| database_error(OPERATION, "rebuilding SQLite stream head", error))
}

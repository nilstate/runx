use runx_contracts::{JsonValue, MAX_PORTABLE_INTEGER, hex_lower};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::RuntimeError;

use super::super::super::{input, model};
use super::super::schema;
use super::{OPERATION, database_error, invalid};

#[derive(Clone, Copy)]
pub(super) enum Layout {
    Current,
    Legacy(schema::EventSchemaV0),
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct Snapshot {
    pub(super) digest: String,
    pub(super) event_count: u64,
    pub(super) stream_count: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct StoredEvent {
    pub(super) data_source_ref: String,
    pub(super) resource: String,
    pub(super) aggregate_id: String,
    pub(super) version: u64,
    pub(super) idempotency_key: String,
    pub(super) event_ref: String,
    pub(super) event_type: String,
    pub(super) event_digest: String,
    pub(super) event_json: String,
    pub(super) committed_at: String,
}

pub(super) fn snapshot(
    connection: &Connection,
    layout: Layout,
    default_source: &str,
    verify_heads: bool,
) -> Result<Snapshot, RuntimeError> {
    let sql = match layout {
        Layout::Legacy(schema::EventSchemaV0::Unscoped) => {
            "SELECT ?1, resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at FROM runx_events ORDER BY resource, aggregate_id, version"
        }
        Layout::Legacy(schema::EventSchemaV0::Scoped) => {
            "SELECT CASE WHEN trim(data_source_ref) = '' THEN ?1 ELSE data_source_ref END, resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at FROM runx_events ORDER BY 1, resource, aggregate_id, version"
        }
        Layout::Current => {
            "SELECT data_source_ref, resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at FROM runx_events ORDER BY data_source_ref, resource, aggregate_id, version"
        }
    };
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| database_error(OPERATION, "preparing migration verification", error))?;
    let mut rows = match layout {
        Layout::Current => statement.query([]),
        Layout::Legacy(_) => statement.query(params![default_source]),
    }
    .map_err(|error| database_error(OPERATION, "reading migration verification rows", error))?;
    let mut digest = Sha256::new();
    digest.update(b"runx.event-store.content.v1\0");
    let mut event_count = 0_u64;
    let mut stream_count = 0_u64;
    let mut current_key: Option<(String, String, String)> = None;
    let mut previous_version = 0_u64;
    let mut projection_digest = empty_projection_digest()?;
    let mut head: Option<StoredEvent> = None;

    while let Some(row) = rows
        .next()
        .map_err(|error| database_error(OPERATION, "iterating migration verification", error))?
    {
        let event = decode_event(row)?;
        validate_event(&event)?;
        let key = event.stream_key();
        if current_key.as_ref() != Some(&key) {
            if verify_heads {
                verify_head(connection, head.as_ref(), &projection_digest)?;
            }
            current_key = Some(key);
            previous_version = 0;
            projection_digest = empty_projection_digest()?;
            stream_count = stream_count.saturating_add(1);
        }
        if event.version != previous_version.saturating_add(1) {
            return Err(invalid("event stream versions are not contiguous"));
        }
        projection_digest =
            advance_projection_digest(event.version, &projection_digest, &event.event_digest)?;
        previous_version = event.version;
        event_count = event_count.saturating_add(1);
        hash_event(&mut digest, &event)?;
        head = Some(event);
    }
    drop(rows);
    drop(statement);
    if verify_heads {
        verify_head(connection, head.as_ref(), &projection_digest)?;
        let head_count = connection
            .query_row("SELECT COUNT(*) FROM runx_stream_heads", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| database_error(OPERATION, "counting verified stream heads", error))?;
        if u64::try_from(head_count).ok() != Some(stream_count) {
            return Err(invalid("stream-head count differs from the event streams"));
        }
    }
    Ok(Snapshot {
        digest: format!("sha256:{}", hex_lower(&digest.finalize())),
        event_count,
        stream_count,
    })
}

pub(super) fn decode_event(row: &rusqlite::Row<'_>) -> Result<StoredEvent, RuntimeError> {
    let version = row
        .get::<_, i64>(3)
        .map_err(|error| database_error(OPERATION, "decoding event version", error))?;
    Ok(StoredEvent {
        data_source_ref: row.get(0).map_err(decode_error)?,
        resource: row.get(1).map_err(decode_error)?,
        aggregate_id: row.get(2).map_err(decode_error)?,
        version: u64::try_from(version).map_err(|_| invalid("event version is negative"))?,
        idempotency_key: row.get(4).map_err(decode_error)?,
        event_ref: row.get(5).map_err(decode_error)?,
        event_type: row.get(6).map_err(decode_error)?,
        event_digest: row.get(7).map_err(decode_error)?,
        event_json: row.get(8).map_err(decode_error)?,
        committed_at: row.get(9).map_err(decode_error)?,
    })
}

fn decode_error(error: rusqlite::Error) -> RuntimeError {
    database_error(OPERATION, "decoding event-store row", error)
}

pub(super) fn validate_event(event: &StoredEvent) -> Result<(), RuntimeError> {
    input::ReadProjectionInput {
        data_source_ref: event.data_source_ref.clone(),
        resource: event.resource.clone(),
        aggregate_id: event.aggregate_id.clone(),
    }
    .validate()?;
    input::validate_event_type(OPERATION, &event.event_type)?;
    if event.version == 0 || event.version > MAX_PORTABLE_INTEGER {
        return Err(invalid("event version is outside the portable range"));
    }
    if event.event_ref
        != format!(
            "{}:{}:{}",
            event.resource, event.aggregate_id, event.version
        )
        || event.idempotency_key.trim().is_empty()
        || event.idempotency_key.len() > 256
        || event.idempotency_key.chars().any(char::is_control)
    {
        return Err(invalid("event identity is invalid"));
    }
    let body: JsonValue = serde_json::from_str(&event.event_json)
        .map_err(|source| RuntimeError::json("decoding migrated event JSON", source))?;
    let object = body
        .as_object()
        .ok_or_else(|| invalid("event JSON must be an object"))?;
    if model::event_type(object) != event.event_type || model::digest(&body)? != event.event_digest
    {
        return Err(invalid(
            "event type or digest does not match its canonical JSON",
        ));
    }
    if model::normalize_time(&event.committed_at)? != event.committed_at {
        return Err(invalid("event commit time is not canonical RFC 3339"));
    }
    Ok(())
}

fn hash_event(digest: &mut Sha256, event: &StoredEvent) -> Result<(), RuntimeError> {
    for bytes in [
        event.data_source_ref.as_bytes(),
        event.resource.as_bytes(),
        event.aggregate_id.as_bytes(),
        &event.version.to_be_bytes(),
        event.idempotency_key.as_bytes(),
        event.event_ref.as_bytes(),
        event.event_type.as_bytes(),
        event.event_digest.as_bytes(),
        event.committed_at.as_bytes(),
    ] {
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
    }
    let body: JsonValue = serde_json::from_str(&event.event_json)
        .map_err(|source| RuntimeError::json("canonicalizing migrated event JSON", source))?;
    let bytes = serde_json::to_vec(&body)
        .map_err(|source| RuntimeError::json("serializing migrated event JSON", source))?;
    digest.update((bytes.len() as u64).to_be_bytes());
    digest.update(bytes);
    Ok(())
}

fn verify_head(
    connection: &Connection,
    event: Option<&StoredEvent>,
    projection_digest: &str,
) -> Result<(), RuntimeError> {
    let Some(event) = event else {
        return Ok(());
    };
    let actual = connection
        .query_row(
            "SELECT data_source_ref, resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at, projection_digest FROM runx_stream_heads WHERE data_source_ref = ?1 AND resource = ?2 AND aggregate_id = ?3",
            params![event.data_source_ref, event.resource, event.aggregate_id],
            |row| {
                let stored = decode_head_event(row)?;
                let digest = row.get::<_, String>(10)?;
                Ok((stored, digest))
            },
        )
        .optional()
        .map_err(|error| database_error(OPERATION, "verifying migrated stream head", error))?;
    if actual.as_ref() != Some(&(event.clone(), projection_digest.to_owned())) {
        return Err(invalid("stream head or projection digest failed readback"));
    }
    Ok(())
}

fn decode_head_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredEvent> {
    let version = row.get::<_, i64>(3)?;
    let version = u64::try_from(version).map_err(|source| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Integer,
            Box::new(source),
        )
    })?;
    Ok(StoredEvent {
        data_source_ref: row.get(0)?,
        resource: row.get(1)?,
        aggregate_id: row.get(2)?,
        version,
        idempotency_key: row.get(4)?,
        event_ref: row.get(5)?,
        event_type: row.get(6)?,
        event_digest: row.get(7)?,
        event_json: row.get(8)?,
        committed_at: row.get(9)?,
    })
}

impl StoredEvent {
    fn stream_key(&self) -> (String, String, String) {
        (
            self.data_source_ref.clone(),
            self.resource.clone(),
            self.aggregate_id.clone(),
        )
    }
}

pub(super) fn empty_projection_digest() -> Result<String, RuntimeError> {
    model::digest(&JsonValue::Object(runx_contracts::JsonObject::from([
        (
            "version".to_owned(),
            JsonValue::Number(runx_contracts::JsonNumber::U64(0)),
        ),
        ("event_digest".to_owned(), JsonValue::Null),
    ])))
}

pub(super) fn advance_projection_digest(
    version: u64,
    previous_projection_digest: &str,
    event_digest: &str,
) -> Result<String, RuntimeError> {
    model::digest(&JsonValue::Object(runx_contracts::JsonObject::from([
        (
            "version".to_owned(),
            JsonValue::Number(runx_contracts::JsonNumber::U64(version)),
        ),
        (
            "previous_projection_digest".to_owned(),
            JsonValue::String(previous_projection_digest.to_owned()),
        ),
        (
            "event_digest".to_owned(),
            JsonValue::String(event_digest.to_owned()),
        ),
    ])))
}

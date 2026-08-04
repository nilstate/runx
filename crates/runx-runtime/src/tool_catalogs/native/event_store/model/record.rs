use runx_contracts::{JsonNumber, JsonObject, JsonValue, sha256_prefixed};

use crate::RuntimeError;

use super::super::input::{SourceIdentity, validate_event_type};
use super::super::{APPEND_TOOL, invalid_input};

#[derive(Clone, Debug)]
pub(in crate::tool_catalogs::native::event_store) struct EventRecord {
    pub(in crate::tool_catalogs::native::event_store) event_ref: String,
    pub(in crate::tool_catalogs::native::event_store) version: u64,
    pub(in crate::tool_catalogs::native::event_store) event_type: String,
    pub(in crate::tool_catalogs::native::event_store) event: JsonObject,
    pub(in crate::tool_catalogs::native::event_store) event_digest: String,
    pub(in crate::tool_catalogs::native::event_store) idempotency_key: String,
    pub(in crate::tool_catalogs::native::event_store) committed_at: String,
}

#[derive(Clone, Debug)]
pub(in crate::tool_catalogs::native::event_store) struct Projection {
    pub(in crate::tool_catalogs::native::event_store) aggregate_id: String,
    pub(in crate::tool_catalogs::native::event_store) resource: String,
    pub(in crate::tool_catalogs::native::event_store) version: u64,
    pub(in crate::tool_catalogs::native::event_store) event_count: u64,
    pub(in crate::tool_catalogs::native::event_store) last_event_ref: Option<String>,
    pub(in crate::tool_catalogs::native::event_store) last_event_type: Option<String>,
    pub(in crate::tool_catalogs::native::event_store) last_event_digest: Option<String>,
    pub(in crate::tool_catalogs::native::event_store) projection_digest: String,
}

#[derive(Clone, Debug)]
pub(in crate::tool_catalogs::native::event_store) struct StreamHead {
    pub(in crate::tool_catalogs::native::event_store) aggregate_id: String,
    pub(in crate::tool_catalogs::native::event_store) event: EventRecord,
}

pub(in crate::tool_catalogs::native::event_store) fn record(
    source: SourceIdentity<'_>,
    version: u64,
    idempotency_key: &str,
    event: &JsonObject,
    observed_at: &str,
) -> Result<EventRecord, RuntimeError> {
    let event_type = event_type(event);
    validate_event_type(APPEND_TOOL, &event_type)?;
    Ok(EventRecord {
        event_ref: format!("{}:{}:{version}", source.resource, source.aggregate_id),
        version,
        event_type,
        event: event.clone(),
        event_digest: digest(&JsonValue::Object(event.clone()))?,
        idempotency_key: idempotency_key.to_owned(),
        committed_at: normalize_time(observed_at)?,
    })
}

pub(in crate::tool_catalogs::native::event_store) fn empty_projection(
    source: SourceIdentity<'_>,
) -> Result<Projection, RuntimeError> {
    Ok(Projection {
        aggregate_id: source.aggregate_id.to_owned(),
        resource: source.resource.to_owned(),
        version: 0,
        event_count: 0,
        last_event_ref: None,
        last_event_type: None,
        last_event_digest: None,
        projection_digest: digest(&JsonValue::Object(JsonObject::from([
            ("version".to_owned(), number(0)),
            ("event_digest".to_owned(), JsonValue::Null),
        ])))?,
    })
}

pub(in crate::tool_catalogs::native::event_store) fn advance_projection(
    current: &Projection,
    event: &EventRecord,
) -> Result<Projection, RuntimeError> {
    let projection_digest = digest(&JsonValue::Object(JsonObject::from([
        ("version".to_owned(), number(event.version)),
        (
            "previous_projection_digest".to_owned(),
            text(&current.projection_digest),
        ),
        ("event_digest".to_owned(), text(&event.event_digest)),
    ])))?;
    Ok(Projection {
        aggregate_id: current.aggregate_id.clone(),
        resource: current.resource.clone(),
        version: event.version,
        event_count: event.version,
        last_event_ref: Some(event.event_ref.clone()),
        last_event_type: Some(event.event_type.clone()),
        last_event_digest: Some(event.event_digest.clone()),
        projection_digest,
    })
}

pub(in crate::tool_catalogs::native::event_store) fn record_json(
    record: &EventRecord,
) -> JsonValue {
    JsonValue::Object(record_object(record))
}

pub(in crate::tool_catalogs::native::event_store) fn record_object(
    record: &EventRecord,
) -> JsonObject {
    JsonObject::from([
        ("event_ref".to_owned(), text(&record.event_ref)),
        ("version".to_owned(), number(record.version)),
        ("event_type".to_owned(), text(&record.event_type)),
        ("event".to_owned(), JsonValue::Object(record.event.clone())),
        ("event_digest".to_owned(), text(&record.event_digest)),
        ("idempotency_key".to_owned(), text(&record.idempotency_key)),
        ("committed_at".to_owned(), text(&record.committed_at)),
    ])
}

pub(in crate::tool_catalogs::native::event_store) fn projection_json(
    projection: &Projection,
) -> JsonValue {
    JsonValue::Object(JsonObject::from([
        ("aggregate_id".to_owned(), text(&projection.aggregate_id)),
        ("resource".to_owned(), text(&projection.resource)),
        ("version".to_owned(), number(projection.version)),
        ("event_count".to_owned(), number(projection.event_count)),
        (
            "last_event_ref".to_owned(),
            projection
                .last_event_ref
                .as_deref()
                .map_or(JsonValue::Null, text),
        ),
        (
            "last_event_type".to_owned(),
            projection
                .last_event_type
                .as_deref()
                .map_or(JsonValue::Null, text),
        ),
        (
            "last_event_digest".to_owned(),
            projection
                .last_event_digest
                .as_deref()
                .map_or(JsonValue::Null, text),
        ),
    ]))
}

pub(in crate::tool_catalogs::native::event_store) fn digest(
    value: &JsonValue,
) -> Result<String, RuntimeError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|source| RuntimeError::json("serializing event-store digest input", source))?;
    Ok(sha256_prefixed(&bytes))
}

pub(in crate::tool_catalogs::native::event_store) fn text(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}

pub(in crate::tool_catalogs::native::event_store) fn number(value: u64) -> JsonValue {
    JsonValue::Number(JsonNumber::U64(value))
}

pub(in crate::tool_catalogs::native::event_store) fn event_type(event: &JsonObject) -> String {
    for field in ["type", "event_type"] {
        if let Some(value) = event.get(field).and_then(JsonValue::as_str)
            && validate_event_type(APPEND_TOOL, value).is_ok()
        {
            return value.to_owned();
        }
    }
    let family = event.get("effect_family").and_then(JsonValue::as_str);
    let operation = event.get("operation").and_then(JsonValue::as_str);
    match (family, operation) {
        (Some(family), Some(operation))
            if validate_event_type(APPEND_TOOL, family).is_ok()
                && validate_event_type(APPEND_TOOL, operation).is_ok() =>
        {
            format!("{family}.{operation}")
        }
        (_, Some(operation)) if validate_event_type(APPEND_TOOL, operation).is_ok() => {
            operation.to_owned()
        }
        _ => "data.event".to_owned(),
    }
}

pub(in crate::tool_catalogs::native::event_store) fn normalize_time(
    value: &str,
) -> Result<String, RuntimeError> {
    let (days, seconds, nanos) = runx_core::policy::parse_rfc3339_moment(value)
        .ok_or_else(|| invalid_input(APPEND_TOOL, "observed_at must be RFC 3339"))?;
    let unix_seconds = days
        .checked_mul(86_400)
        .and_then(|value| value.checked_add(seconds))
        .ok_or_else(|| invalid_input(APPEND_TOOL, "observed_at is outside the supported range"))?;
    let whole = crate::time::iso8601_from_unix_seconds(unix_seconds);
    let prefix = whole.strip_suffix('Z').unwrap_or(&whole);
    Ok(format!("{prefix}.{:03}Z", nanos / 1_000_000))
}

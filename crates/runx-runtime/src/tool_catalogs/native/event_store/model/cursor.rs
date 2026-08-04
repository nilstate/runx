use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use runx_contracts::{JsonObject, JsonValue};

use crate::RuntimeError;

use super::super::input::validate_aggregate_id;
use super::super::{LIST_HEADS_TOOL, invalid_input};
use super::record::StreamHead;

pub(in crate::tool_catalogs::native::event_store) struct HeadCursor {
    pub(in crate::tool_catalogs::native::event_store) committed_at: String,
    pub(in crate::tool_catalogs::native::event_store) aggregate_id: String,
}

pub(in crate::tool_catalogs::native::event_store) fn decode_cursor(
    value: Option<&str>,
) -> Result<Option<HeadCursor>, RuntimeError> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > 1024
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(cursor_error());
    }
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| cursor_error())?;
    let cursor: JsonObject = serde_json::from_slice(&bytes).map_err(|_| cursor_error())?;
    let committed_at = cursor
        .get("committed_at")
        .and_then(JsonValue::as_str)
        .ok_or_else(cursor_error)?;
    if runx_core::policy::parse_rfc3339_moment(committed_at).is_none() {
        return Err(cursor_error());
    }
    let aggregate_id = cursor
        .get("aggregate_id")
        .and_then(JsonValue::as_str)
        .ok_or_else(cursor_error)?;
    validate_aggregate_id(LIST_HEADS_TOOL, aggregate_id)?;
    Ok(Some(HeadCursor {
        committed_at: committed_at.to_owned(),
        aggregate_id: aggregate_id.to_owned(),
    }))
}

pub(in crate::tool_catalogs::native::event_store) fn encode_cursor(
    head: &StreamHead,
) -> Result<String, RuntimeError> {
    let cursor = JsonObject::from([
        (
            "committed_at".to_owned(),
            JsonValue::String(head.event.committed_at.clone()),
        ),
        (
            "aggregate_id".to_owned(),
            JsonValue::String(head.aggregate_id.clone()),
        ),
    ]);
    let bytes = serde_json::to_vec(&cursor)
        .map_err(|source| RuntimeError::json("serializing data cursor", source))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn cursor_error() -> RuntimeError {
    invalid_input(
        LIST_HEADS_TOOL,
        "cursor must be an opaque stream-head cursor",
    )
}

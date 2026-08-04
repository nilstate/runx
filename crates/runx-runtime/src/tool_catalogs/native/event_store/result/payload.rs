mod records;

use runx_contracts::{JsonNumber, JsonObject, JsonValue};
use serde::Deserialize;

use crate::RuntimeError;

use super::super::{APPEND_TOOL, LIST_HEADS_TOOL, READ_EVENTS_TOOL, READ_PROJECTION_TOOL};
use super::{Expectation, OperationResult, Status, invalid, valid_digest};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Projection {
    aggregate_id: String,
    resource: String,
    version: u64,
    event_count: u64,
    last_event_ref: Option<String>,
    last_event_type: Option<String>,
    last_event_digest: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    limit: u64,
    count: u64,
    has_more: bool,
    next_cursor: Option<String>,
}

pub(super) fn validate(
    expectation: &Expectation,
    result: &OperationResult,
) -> Result<(), RuntimeError> {
    if result.status == Status::ProviderUnavailable {
        if result.projection.is_some() || !result.events.is_empty() || !result.rows.is_empty() {
            return Err(invalid(
                expectation,
                "provider_unavailable must not return operation data",
            ));
        }
        return Ok(());
    }
    match expectation.tool_ref() {
        APPEND_TOOL => validate_append(expectation, result),
        READ_EVENTS_TOOL => validate_events(expectation, result),
        READ_PROJECTION_TOOL => validate_projection(expectation, result),
        LIST_HEADS_TOOL => validate_heads(expectation, result),
        _ => Err(invalid(expectation, "unknown data operation")),
    }
}

fn validate_append(
    expectation: &Expectation,
    result: &OperationResult,
) -> Result<(), RuntimeError> {
    if result.projection.is_some() || !result.events.is_empty() || !result.rows.is_empty() {
        return Err(invalid(
            expectation,
            "append result must not return unbounded event data",
        ));
    }
    if let Some(event_ref) = result.event_ref.as_deref()
        && !event_ref.starts_with(&format!(
            "{}:{}:",
            expectation.resource, expectation.aggregate_id
        ))
    {
        return Err(invalid(
            expectation,
            "append result returned an event_ref for another stream",
        ));
    }
    if result.status == Status::Conflict {
        verify_digest(
            expectation,
            "result_digest",
            &result.result_digest,
            &JsonValue::Object(JsonObject::from([
                (
                    "code".to_owned(),
                    JsonValue::String(result.stop_conditions[0].code.clone()),
                ),
                (
                    "message".to_owned(),
                    JsonValue::String(result.stop_conditions[0].message.clone()),
                ),
            ])),
        )?;
    }
    Ok(())
}

fn validate_events(
    expectation: &Expectation,
    result: &OperationResult,
) -> Result<(), RuntimeError> {
    if result.projection.is_some()
        || result.events.len() > expectation.limit
        || result.rows != result.events
    {
        return Err(invalid(
            expectation,
            "read_events returned an invalid or oversized page",
        ));
    }
    records::validate_event_page(expectation, result.after_version, &result.events)?;
    let limit = result
        .limit
        .ok_or_else(|| invalid(expectation, "read_events is missing limit"))?;
    let next_after_version = result
        .next_after_version
        .ok_or_else(|| invalid(expectation, "read_events is missing next_after_version"))?;
    let has_more = result
        .has_more
        .ok_or_else(|| invalid(expectation, "read_events is missing has_more"))?;
    if limit != expectation.limit as u64
        || next_after_version > result.after_version
        || expectation
            .after_version
            .is_some_and(|after| next_after_version < after)
        || has_more
            && (expectation.after_version.is_none() || result.events.len() != expectation.limit)
    {
        return Err(invalid(
            expectation,
            "read_events returned inconsistent continuation metadata",
        ));
    }
    if let Some(last) = result.events.last().and_then(JsonValue::as_object) {
        if last.get("version").and_then(json_u64) != Some(next_after_version) {
            return Err(invalid(
                expectation,
                "next_after_version does not match the final event",
            ));
        }
    } else if next_after_version != expectation.after_version.unwrap_or(result.after_version) {
        return Err(invalid(
            expectation,
            "empty read_events page changed the continuation version",
        ));
    }
    verify_digest(
        expectation,
        "result_digest",
        &result.result_digest,
        &JsonValue::Object(JsonObject::from([
            ("events".to_owned(), JsonValue::Array(result.events.clone())),
            (
                "limit".to_owned(),
                JsonValue::Number(JsonNumber::U64(limit)),
            ),
            (
                "next_after_version".to_owned(),
                JsonValue::Number(JsonNumber::U64(next_after_version)),
            ),
            ("has_more".to_owned(), JsonValue::Bool(has_more)),
        ])),
    )
}

fn json_u64(value: &JsonValue) -> Option<u64> {
    match value {
        JsonValue::Number(JsonNumber::U64(value)) => Some(*value),
        JsonValue::Number(JsonNumber::I64(value)) => u64::try_from(*value).ok(),
        _ => None,
    }
}

fn validate_projection(
    expectation: &Expectation,
    result: &OperationResult,
) -> Result<(), RuntimeError> {
    if !result.events.is_empty() || !result.rows.is_empty() {
        return Err(invalid(
            expectation,
            "read_projection must not return event rows",
        ));
    }
    let raw = result
        .projection
        .as_ref()
        .ok_or_else(|| invalid(expectation, "read_projection is missing projection"))?;
    reject_internal_projection_fields(expectation, raw)?;
    let projection: Projection = JsonValue::Object(raw.clone())
        .deserialize_into()
        .map_err(|source| invalid(expectation, format!("invalid projection: {source}")))?;
    if projection.aggregate_id != expectation.aggregate_id
        || projection.resource != expectation.resource
        || projection.version != result.after_version
        || projection.event_count != projection.version
    {
        return Err(invalid(
            expectation,
            "projection identity or version is inconsistent",
        ));
    }
    validate_projection_head(expectation, &projection)?;
    verify_digest(
        expectation,
        "result_digest",
        &result.result_digest,
        &JsonValue::Object(raw.clone()),
    )?;
    if projection.version == 0 {
        verify_digest(
            expectation,
            "projection_digest",
            &result.projection_digest,
            &JsonValue::Object(JsonObject::from([
                ("version".to_owned(), JsonValue::Number(JsonNumber::U64(0))),
                ("event_digest".to_owned(), JsonValue::Null),
            ])),
        )?;
    }
    Ok(())
}

fn validate_heads(expectation: &Expectation, result: &OperationResult) -> Result<(), RuntimeError> {
    if !result.events.is_empty() || result.rows.len() > expectation.limit {
        return Err(invalid(
            expectation,
            "list_stream_heads returned an invalid or oversized page",
        ));
    }
    let raw_page = result
        .projection
        .as_ref()
        .ok_or_else(|| invalid(expectation, "list_stream_heads is missing page metadata"))?;
    let page: Page = JsonValue::Object(raw_page.clone())
        .deserialize_into()
        .map_err(|source| invalid(expectation, format!("invalid stream-head page: {source}")))?;
    let expected_limit = u64::try_from(expectation.limit)
        .map_err(|_| invalid(expectation, "stream-head limit is too large"))?;
    if result.before_version != 0
        || page.limit != expected_limit
        || page.count != result.rows.len() as u64
        || page.has_more != page.next_cursor.is_some()
    {
        return Err(invalid(
            expectation,
            "stream-head page metadata is inconsistent",
        ));
    }
    records::validate_head_page(expectation, &result.rows)?;
    verify_digest(
        expectation,
        "result_digest",
        &result.result_digest,
        &JsonValue::Object(JsonObject::from([
            ("rows".to_owned(), JsonValue::Array(result.rows.clone())),
            ("page".to_owned(), JsonValue::Object(raw_page.clone())),
        ])),
    )?;
    let digest_rows = result
        .rows
        .iter()
        .filter_map(JsonValue::as_object)
        .map(|row| {
            JsonValue::Array(vec![
                row.get("aggregate_id").cloned().unwrap_or(JsonValue::Null),
                row.get("version").cloned().unwrap_or(JsonValue::Null),
                row.get("event_digest").cloned().unwrap_or(JsonValue::Null),
            ])
        })
        .collect::<Vec<_>>();
    verify_digest(
        expectation,
        "projection_digest",
        &result.projection_digest,
        &JsonValue::Array(digest_rows),
    )
}

fn validate_projection_head(
    expectation: &Expectation,
    projection: &Projection,
) -> Result<(), RuntimeError> {
    let fields = [
        projection.last_event_ref.as_deref(),
        projection.last_event_type.as_deref(),
        projection.last_event_digest.as_deref(),
    ];
    if projection.version == 0 {
        if fields.iter().any(|field| field.is_some()) {
            return Err(invalid(
                expectation,
                "empty projection must not claim a last event",
            ));
        }
        return Ok(());
    }
    let [Some(event_ref), Some(event_type), Some(event_digest)] = fields else {
        return Err(invalid(
            expectation,
            "non-empty projection requires complete last-event metadata",
        ));
    };
    if event_ref
        != format!(
            "{}:{}:{}",
            expectation.resource, expectation.aggregate_id, projection.version
        )
        || !valid_digest(event_digest)
    {
        return Err(invalid(
            expectation,
            "projection last-event metadata is inconsistent",
        ));
    }
    super::super::input::validate_event_type(expectation.tool_ref(), event_type)
}

fn reject_internal_projection_fields(
    expectation: &Expectation,
    projection: &JsonObject,
) -> Result<(), RuntimeError> {
    if projection.contains_key("event_digests") || projection.contains_key("projection_digest") {
        Err(invalid(
            expectation,
            "projection exposes internal or unbounded digest state",
        ))
    } else {
        Ok(())
    }
}

fn verify_digest(
    expectation: &Expectation,
    field: &str,
    actual: &str,
    value: &JsonValue,
) -> Result<(), RuntimeError> {
    let expected = super::super::model::digest(value)?;
    if actual == expected {
        Ok(())
    } else {
        Err(invalid(
            expectation,
            format!("provider returned an invalid {field}"),
        ))
    }
}

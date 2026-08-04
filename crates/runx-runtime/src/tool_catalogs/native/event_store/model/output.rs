use runx_contracts::{DataOperationResult, JsonObject, JsonValue};

use crate::{CapabilityOutput, RuntimeError};

use super::cursor::encode_cursor;
use super::record::{
    EventRecord, Projection, StreamHead, digest, number, projection_json, record_json,
    record_object, text,
};
use crate::tool_catalogs::native::event_store::input::SourceIdentity;

const PROVIDER: &str = "sqlite-event-store";
const ADAPTER: &str = "data.sqlite";

impl CapabilityOutput for DataOperationResult {}

pub(in crate::tool_catalogs::native::event_store) fn append_result(
    source: SourceIdentity<'_>,
    status: &str,
    before: u64,
    after: u64,
    record: &EventRecord,
    projection_digest: String,
) -> Result<JsonValue, RuntimeError> {
    let mut result = envelope(source, "append_event");
    common_versions(&mut result, before, after);
    result.insert("status".to_owned(), text(status));
    result.insert("idempotency_key".to_owned(), text(&record.idempotency_key));
    result.insert("event_ref".to_owned(), text(&record.event_ref));
    result.insert("event_digest".to_owned(), text(&record.event_digest));
    result.insert(
        "result_digest".to_owned(),
        text(&digest(&record_json(record))?),
    );
    result.insert("projection_digest".to_owned(), text(&projection_digest));
    empty_collections(&mut result);
    result.insert("provider_evidence".to_owned(), provider_evidence(source)?);
    Ok(JsonValue::Object(result))
}

pub(in crate::tool_catalogs::native::event_store) fn conflict_result(
    source: SourceIdentity<'_>,
    current: u64,
    idempotency_key: &str,
    event_digest: &str,
    reason: String,
    projection_digest: String,
) -> Result<JsonValue, RuntimeError> {
    let stop = JsonValue::Object(JsonObject::from([
        ("code".to_owned(), text("conflict")),
        ("message".to_owned(), text(&reason)),
    ]));
    let mut result = envelope(source, "append_event");
    common_versions(&mut result, current, current);
    result.insert("status".to_owned(), text("conflict"));
    result.insert("idempotency_key".to_owned(), text(idempotency_key));
    result.insert("event_ref".to_owned(), JsonValue::Null);
    result.insert("event_digest".to_owned(), text(event_digest));
    result.insert("result_digest".to_owned(), text(&digest(&stop)?));
    result.insert("projection_digest".to_owned(), text(&projection_digest));
    result.insert("events".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("rows".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("redactions".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("stop_conditions".to_owned(), JsonValue::Array(vec![stop]));
    result.insert("provider_evidence".to_owned(), provider_evidence(source)?);
    Ok(JsonValue::Object(result))
}

pub(in crate::tool_catalogs::native::event_store) fn events_result(
    source: SourceIdentity<'_>,
    current: u64,
    events: &[EventRecord],
    limit: usize,
    next_after_version: u64,
    has_more: bool,
    projection_digest: String,
) -> Result<JsonValue, RuntimeError> {
    let rows = events.iter().map(record_json).collect::<Vec<_>>();
    let page = event_page(&rows, limit, next_after_version, has_more);
    let mut result = envelope(source, "read_events");
    common_versions(&mut result, current, current);
    result.insert("status".to_owned(), text("read"));
    nullable_effect_fields(&mut result);
    result.insert(
        "result_digest".to_owned(),
        text(&digest(&JsonValue::Object(page.clone()))?),
    );
    result.insert("projection_digest".to_owned(), text(&projection_digest));
    result.insert("limit".to_owned(), number(limit as u64));
    result.insert("next_after_version".to_owned(), number(next_after_version));
    result.insert("has_more".to_owned(), JsonValue::Bool(has_more));
    result.insert("events".to_owned(), JsonValue::Array(rows.clone()));
    result.insert("rows".to_owned(), JsonValue::Array(rows));
    result.insert("redactions".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("stop_conditions".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("provider_evidence".to_owned(), provider_evidence(source)?);
    Ok(JsonValue::Object(result))
}

fn event_page(
    rows: &[JsonValue],
    limit: usize,
    next_after_version: u64,
    has_more: bool,
) -> JsonObject {
    JsonObject::from([
        ("events".to_owned(), JsonValue::Array(rows.to_vec())),
        ("limit".to_owned(), number(limit as u64)),
        ("next_after_version".to_owned(), number(next_after_version)),
        ("has_more".to_owned(), JsonValue::Bool(has_more)),
    ])
}

pub(in crate::tool_catalogs::native::event_store) fn projection_result(
    source: SourceIdentity<'_>,
    projection: &Projection,
) -> Result<JsonValue, RuntimeError> {
    let version = projection.version;
    let projection_digest = projection.projection_digest.clone();
    let projection = projection_json(projection);
    let result_digest = digest(&projection)?;
    let mut result = envelope(source, "read_projection");
    common_versions(&mut result, version, version);
    result.insert("status".to_owned(), text("read"));
    nullable_effect_fields(&mut result);
    result.insert("result_digest".to_owned(), text(&result_digest));
    result.insert("projection_digest".to_owned(), text(&projection_digest));
    result.insert("projection".to_owned(), projection);
    result.insert("events".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("rows".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("redactions".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("stop_conditions".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("provider_evidence".to_owned(), provider_evidence(source)?);
    Ok(JsonValue::Object(result))
}

pub(in crate::tool_catalogs::native::event_store) fn heads_result(
    data_source_ref: &str,
    resource: &str,
    limit: usize,
    heads: &[StreamHead],
    has_more: bool,
) -> Result<JsonValue, RuntimeError> {
    let rows = head_rows(heads);
    let page = head_page(limit, rows.len(), has_more, heads)?;
    let source = SourceIdentity {
        data_source_ref,
        resource,
        aggregate_id: "stream-heads",
    };
    let mut result = envelope(source, "list_stream_heads");
    common_versions(&mut result, 0, 0);
    result.insert("status".to_owned(), text("read"));
    nullable_effect_fields(&mut result);
    result.insert(
        "result_digest".to_owned(),
        text(&head_result_digest(&rows, &page)?),
    );
    result.insert(
        "projection_digest".to_owned(),
        text(&head_projection_digest(&rows)?),
    );
    result.insert("projection".to_owned(), page);
    result.insert("events".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("rows".to_owned(), JsonValue::Array(rows));
    result.insert("redactions".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("stop_conditions".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("provider_evidence".to_owned(), provider_evidence(source)?);
    Ok(JsonValue::Object(result))
}

fn head_rows(heads: &[StreamHead]) -> Vec<JsonValue> {
    heads
        .iter()
        .map(|head| {
            let mut object = record_object(&head.event);
            object.insert("aggregate_id".to_owned(), text(&head.aggregate_id));
            JsonValue::Object(object)
        })
        .collect()
}

fn head_page(
    limit: usize,
    count: usize,
    has_more: bool,
    heads: &[StreamHead],
) -> Result<JsonValue, RuntimeError> {
    let next_cursor = if has_more {
        heads.last().map(encode_cursor).transpose()?
    } else {
        None
    };
    Ok(JsonValue::Object(JsonObject::from([
        ("limit".to_owned(), number(limit as u64)),
        ("count".to_owned(), number(count as u64)),
        ("has_more".to_owned(), JsonValue::Bool(has_more)),
        (
            "next_cursor".to_owned(),
            next_cursor.map_or(JsonValue::Null, JsonValue::String),
        ),
    ])))
}

fn head_result_digest(rows: &[JsonValue], page: &JsonValue) -> Result<String, RuntimeError> {
    digest(&JsonValue::Object(JsonObject::from([
        ("rows".to_owned(), JsonValue::Array(rows.to_vec())),
        ("page".to_owned(), page.clone()),
    ])))
}

fn head_projection_digest(rows: &[JsonValue]) -> Result<String, RuntimeError> {
    let digest_rows = rows
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
    digest(&JsonValue::Array(digest_rows))
}

fn envelope(source: SourceIdentity<'_>, operation: &str) -> JsonObject {
    JsonObject::from([
        ("schema".to_owned(), text("runx.data.operation_result.v1")),
        ("data_source_ref".to_owned(), text(source.data_source_ref)),
        ("provider".to_owned(), text(PROVIDER)),
        ("operation".to_owned(), text(operation)),
        ("resource".to_owned(), text(source.resource)),
        ("aggregate_id".to_owned(), text(source.aggregate_id)),
    ])
}

fn common_versions(result: &mut JsonObject, before: u64, after: u64) {
    result.insert("before_version".to_owned(), number(before));
    result.insert("after_version".to_owned(), number(after));
}

fn nullable_effect_fields(result: &mut JsonObject) {
    result.insert("idempotency_key".to_owned(), JsonValue::Null);
    result.insert("event_ref".to_owned(), JsonValue::Null);
    result.insert("event_digest".to_owned(), JsonValue::Null);
}

fn empty_collections(result: &mut JsonObject) {
    result.insert("events".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("rows".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("redactions".to_owned(), JsonValue::Array(Vec::new()));
    result.insert("stop_conditions".to_owned(), JsonValue::Array(Vec::new()));
}

fn provider_evidence(source: SourceIdentity<'_>) -> Result<JsonValue, RuntimeError> {
    Ok(JsonValue::Object(JsonObject::from([
        ("provider".to_owned(), text(PROVIDER)),
        ("adapter".to_owned(), text(ADAPTER)),
        (
            "data_source_ref_digest".to_owned(),
            text(&digest(&text(source.data_source_ref))?),
        ),
        ("resource".to_owned(), text(source.resource)),
        ("aggregate_id".to_owned(), text(source.aggregate_id)),
        ("storage_class".to_owned(), text("sqlite")),
    ])))
}

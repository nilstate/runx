use std::collections::BTreeSet;

use runx_contracts::{JsonObject, JsonValue, MAX_PORTABLE_INTEGER};
use serde::Deserialize;

use crate::RuntimeError;

use super::super::{Expectation, invalid, valid_digest};
use super::verify_digest;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EventRecord {
    event_ref: String,
    version: u64,
    event_type: String,
    event: JsonObject,
    event_digest: String,
    idempotency_key: String,
    committed_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StreamHead {
    aggregate_id: String,
    event_ref: String,
    version: u64,
    event_type: String,
    event: JsonObject,
    event_digest: String,
    idempotency_key: String,
    committed_at: String,
}

pub(super) fn validate_event_page(
    expectation: &Expectation,
    current: u64,
    values: &[JsonValue],
) -> Result<(), RuntimeError> {
    let records = values
        .iter()
        .map(|value| decode_event(expectation, value))
        .collect::<Result<Vec<_>, _>>()?;
    validate_event_sequence(expectation, current, &records)?;
    if records
        .last()
        .is_some_and(|record| record.version > current)
    {
        return Err(invalid(
            expectation,
            "read_events returned an event beyond the reported stream version",
        ));
    }
    Ok(())
}

pub(super) fn validate_head_page(
    expectation: &Expectation,
    values: &[JsonValue],
) -> Result<(), RuntimeError> {
    let heads = values
        .iter()
        .map(|value| decode_head(expectation, value))
        .collect::<Result<Vec<_>, _>>()?;
    let mut aggregate_ids = BTreeSet::new();
    for head in &heads {
        if !aggregate_ids.insert(head.aggregate_id.as_str()) {
            return Err(invalid(expectation, "stream-head page contains duplicates"));
        }
    }
    for pair in heads.windows(2) {
        let left = &pair[0];
        let right = &pair[1];
        if left.committed_at < right.committed_at
            || left.committed_at == right.committed_at && left.aggregate_id > right.aggregate_id
        {
            return Err(invalid(
                expectation,
                "stream-head page is not in canonical newest-first order",
            ));
        }
    }
    Ok(())
}

fn decode_event(expectation: &Expectation, value: &JsonValue) -> Result<EventRecord, RuntimeError> {
    let record: EventRecord = value
        .clone()
        .deserialize_into()
        .map_err(|source| invalid(expectation, format!("invalid event record: {source}")))?;
    validate_record(expectation, &expectation.aggregate_id, &record)?;
    Ok(record)
}

fn decode_head(expectation: &Expectation, value: &JsonValue) -> Result<StreamHead, RuntimeError> {
    let head: StreamHead = value
        .clone()
        .deserialize_into()
        .map_err(|source| invalid(expectation, format!("invalid stream head: {source}")))?;
    super::super::super::input::validate_aggregate_id(expectation.tool_ref(), &head.aggregate_id)?;
    validate_record(expectation, &head.aggregate_id, &head)?;
    if !expectation.event_types.is_empty() && !expectation.event_types.contains(&head.event_type) {
        return Err(invalid(
            expectation,
            "stream-head row does not match the requested event_types",
        ));
    }
    Ok(head)
}

trait Record {
    fn event_ref(&self) -> &str;
    fn version(&self) -> u64;
    fn event_type(&self) -> &str;
    fn event(&self) -> &JsonObject;
    fn event_digest(&self) -> &str;
    fn idempotency_key(&self) -> &str;
    fn committed_at(&self) -> &str;
}

impl Record for EventRecord {
    fn event_ref(&self) -> &str {
        &self.event_ref
    }
    fn version(&self) -> u64 {
        self.version
    }
    fn event_type(&self) -> &str {
        &self.event_type
    }
    fn event(&self) -> &JsonObject {
        &self.event
    }
    fn event_digest(&self) -> &str {
        &self.event_digest
    }
    fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }
    fn committed_at(&self) -> &str {
        &self.committed_at
    }
}

impl Record for StreamHead {
    fn event_ref(&self) -> &str {
        &self.event_ref
    }
    fn version(&self) -> u64 {
        self.version
    }
    fn event_type(&self) -> &str {
        &self.event_type
    }
    fn event(&self) -> &JsonObject {
        &self.event
    }
    fn event_digest(&self) -> &str {
        &self.event_digest
    }
    fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }
    fn committed_at(&self) -> &str {
        &self.committed_at
    }
}

fn validate_record(
    expectation: &Expectation,
    aggregate_id: &str,
    record: &impl Record,
) -> Result<(), RuntimeError> {
    if record.version() == 0
        || record.version() > MAX_PORTABLE_INTEGER
        || record.event_ref()
            != format!(
                "{}:{aggregate_id}:{}",
                expectation.resource,
                record.version()
            )
        || record.idempotency_key().trim().is_empty()
        || record.idempotency_key().len() > 256
        || record.idempotency_key().chars().any(char::is_control)
        || runx_core::policy::parse_rfc3339_moment(record.committed_at()).is_none()
    {
        return Err(invalid(expectation, "event record identity is invalid"));
    }
    super::super::super::input::validate_event_type(expectation.tool_ref(), record.event_type())?;
    if record.event_type() != super::super::super::model::event_type(record.event()) {
        return Err(invalid(
            expectation,
            "event record type does not match the canonical event classification",
        ));
    }
    if !valid_digest(record.event_digest()) {
        return Err(invalid(expectation, "event record digest is invalid"));
    }
    verify_digest(
        expectation,
        "event_digest",
        record.event_digest(),
        &JsonValue::Object(record.event().clone()),
    )
}

fn validate_event_sequence(
    expectation: &Expectation,
    current: u64,
    records: &[EventRecord],
) -> Result<(), RuntimeError> {
    if records.is_empty() {
        return Ok(());
    }
    let expected_first = match expectation.after_version {
        Some(after) => after.checked_add(1),
        None => current
            .checked_sub(records.len() as u64)
            .and_then(|value| value.checked_add(1)),
    }
    .ok_or_else(|| invalid(expectation, "event page version range is invalid"))?;
    for (offset, record) in records.iter().enumerate() {
        let expected = expected_first
            .checked_add(offset as u64)
            .ok_or_else(|| invalid(expectation, "event page version range overflowed"))?;
        if record.version != expected {
            return Err(invalid(
                expectation,
                "event page versions are not contiguous",
            ));
        }
    }
    Ok(())
}

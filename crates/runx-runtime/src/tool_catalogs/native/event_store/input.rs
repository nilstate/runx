use std::collections::BTreeSet;

use runx_contracts::{JsonNumber, JsonObject, JsonValue, MAX_PORTABLE_INTEGER};
use serde::{Deserialize, Serialize};

use crate::{CapabilityInput, RuntimeError};

use super::{APPEND_TOOL, LIST_HEADS_TOOL, READ_EVENTS_TOOL, READ_PROJECTION_TOOL, invalid_input};

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct AppendInput {
    pub(super) data_source_ref: String,
    pub(super) resource: String,
    pub(super) aggregate_id: String,
    pub(super) expected_version: u64,
    pub(super) idempotency_key: String,
    pub(super) event: JsonObject,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) observed_at: Option<String>,
}

impl CapabilityInput for AppendInput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ReadEventsInput {
    pub(super) data_source_ref: String,
    pub(super) resource: String,
    pub(super) aggregate_id: String,
    pub(super) limit: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) after_version: Option<u64>,
}

impl CapabilityInput for ReadEventsInput {
    fn defaults() -> JsonObject {
        JsonObject::from([("limit".to_owned(), JsonValue::Number(JsonNumber::U64(50)))])
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ReadProjectionInput {
    pub(super) data_source_ref: String,
    pub(super) resource: String,
    pub(super) aggregate_id: String,
}

impl CapabilityInput for ReadProjectionInput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ListHeadsInput {
    pub(super) data_source_ref: String,
    pub(super) resource: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) event_types: Vec<String>,
    pub(super) limit: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cursor: Option<String>,
}

impl CapabilityInput for ListHeadsInput {
    fn defaults() -> JsonObject {
        JsonObject::from([("limit".to_owned(), JsonValue::Number(JsonNumber::U64(50)))])
    }
}

pub(super) struct AppendRequest<'a> {
    pub(super) source: SourceIdentity<'a>,
    pub(super) expected_version: u64,
    pub(super) idempotency_key: &'a str,
    pub(super) event: &'a JsonObject,
    pub(super) observed_at: Option<&'a str>,
}

pub(super) struct ReadEventsRequest<'a> {
    pub(super) source: SourceIdentity<'a>,
    pub(super) limit: usize,
    pub(super) after_version: Option<u64>,
}

pub(super) struct ListHeadsRequest<'a> {
    pub(super) data_source_ref: &'a str,
    pub(super) resource: &'a str,
    pub(super) event_types: Vec<&'a str>,
    pub(super) limit: usize,
    pub(super) cursor: Option<&'a str>,
}

#[derive(Clone, Copy)]
pub(super) struct SourceIdentity<'a> {
    pub(super) data_source_ref: &'a str,
    pub(super) resource: &'a str,
    pub(super) aggregate_id: &'a str,
}

impl AppendInput {
    pub(super) fn validate(&self) -> Result<AppendRequest<'_>, RuntimeError> {
        let source = source(
            APPEND_TOOL,
            &self.data_source_ref,
            &self.resource,
            &self.aggregate_id,
        )?;
        validate_token(
            APPEND_TOOL,
            "idempotency_key",
            &self.idempotency_key,
            256,
            true,
        )?;
        if self.expected_version >= MAX_PORTABLE_INTEGER {
            return Err(invalid_input(
                APPEND_TOOL,
                format!("expected_version must be less than {MAX_PORTABLE_INTEGER}"),
            ));
        }
        if let Some(observed_at) = self.observed_at.as_deref()
            && runx_core::policy::parse_rfc3339_moment(observed_at).is_none()
        {
            return Err(invalid_input(APPEND_TOOL, "observed_at must be RFC 3339"));
        }
        Ok(AppendRequest {
            source,
            expected_version: self.expected_version,
            idempotency_key: &self.idempotency_key,
            event: &self.event,
            observed_at: self.observed_at.as_deref(),
        })
    }
}

impl ReadEventsInput {
    pub(super) fn validate(&self) -> Result<ReadEventsRequest<'_>, RuntimeError> {
        let source = source(
            READ_EVENTS_TOOL,
            &self.data_source_ref,
            &self.resource,
            &self.aggregate_id,
        )?;
        let limit = bounded_limit(READ_EVENTS_TOOL, self.limit, 500)?;
        if self
            .after_version
            .is_some_and(|version| version > MAX_PORTABLE_INTEGER)
        {
            return Err(invalid_input(
                READ_EVENTS_TOOL,
                format!("after_version must not exceed {MAX_PORTABLE_INTEGER}"),
            ));
        }
        Ok(ReadEventsRequest {
            source,
            limit,
            after_version: self.after_version,
        })
    }
}

impl ReadProjectionInput {
    pub(super) fn validate(&self) -> Result<SourceIdentity<'_>, RuntimeError> {
        source(
            READ_PROJECTION_TOOL,
            &self.data_source_ref,
            &self.resource,
            &self.aggregate_id,
        )
    }
}

impl ListHeadsInput {
    pub(super) fn validate(&self) -> Result<ListHeadsRequest<'_>, RuntimeError> {
        validate_token(
            LIST_HEADS_TOOL,
            "data_source_ref",
            &self.data_source_ref,
            512,
            true,
        )?;
        validate_identifier(LIST_HEADS_TOOL, "resource", &self.resource, false)?;
        let limit = bounded_limit(LIST_HEADS_TOOL, self.limit, 100)?;
        if self.event_types.len() > 20 {
            return Err(invalid_input(
                LIST_HEADS_TOOL,
                "event_types may contain at most 20 values",
            ));
        }
        let mut seen = BTreeSet::new();
        let mut event_types = Vec::with_capacity(self.event_types.len());
        for event_type in &self.event_types {
            validate_event_type(LIST_HEADS_TOOL, event_type)?;
            if seen.insert(event_type.as_str()) {
                event_types.push(event_type.as_str());
            }
        }
        Ok(ListHeadsRequest {
            data_source_ref: &self.data_source_ref,
            resource: &self.resource,
            event_types,
            limit,
            cursor: self.cursor.as_deref(),
        })
    }
}

fn source<'a>(
    tool: &str,
    data_source_ref: &'a str,
    resource: &'a str,
    aggregate_id: &'a str,
) -> Result<SourceIdentity<'a>, RuntimeError> {
    validate_token(tool, "data_source_ref", data_source_ref, 512, true)?;
    validate_identifier(tool, "resource", resource, false)?;
    validate_identifier(tool, "aggregate_id", aggregate_id, true)?;
    Ok(SourceIdentity {
        data_source_ref,
        resource,
        aggregate_id,
    })
}

fn bounded_limit(tool: &str, value: u64, maximum: usize) -> Result<usize, RuntimeError> {
    let value = usize::try_from(value).map_err(|_| invalid_input(tool, "limit is too large"))?;
    if value == 0 || value > maximum {
        return Err(invalid_input(
            tool,
            format!("limit must be from 1 to {maximum}"),
        ));
    }
    Ok(value)
}

pub(super) fn validate_event_type(tool: &str, value: &str) -> Result<(), RuntimeError> {
    validate_token(tool, "event_type", value, 128, false)
}

fn validate_identifier(
    tool: &str,
    field: &str,
    value: &str,
    aggregate: bool,
) -> Result<(), RuntimeError> {
    let valid = !value.is_empty()
        && value.len() <= if aggregate { 192 } else { 128 }
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric()
                || (index > 0
                    && matches!(character, '.' | '_' | ':' | '-' | '@' | '/')
                    && (aggregate || character != '@' && character != '/'))
        });
    if valid {
        Ok(())
    } else {
        Err(invalid_input(
            tool,
            format!("{field} must be a safe identifier"),
        ))
    }
}

pub(super) fn validate_aggregate_id(tool: &str, value: &str) -> Result<(), RuntimeError> {
    validate_identifier(tool, "aggregate_id", value, true)
}

fn validate_token(
    tool: &str,
    field: &str,
    value: &str,
    maximum: usize,
    allow_slash: bool,
) -> Result<(), RuntimeError> {
    let valid = !value.trim().is_empty()
        && value.trim() == value
        && value.len() <= maximum
        && !value.chars().any(char::is_control)
        && (allow_slash || !value.contains('/'));
    if valid {
        Ok(())
    } else {
        Err(invalid_input(tool, format!("{field} is invalid")))
    }
}

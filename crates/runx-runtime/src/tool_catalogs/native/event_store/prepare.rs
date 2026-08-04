use runx_contracts::{JsonObject, JsonValue};

use crate::{CapabilityContract, RuntimeError};

use super::{
    APPEND, APPEND_TOOL, AppendInput, LIST_HEADS, LIST_HEADS_TOOL, ListHeadsInput, READ_EVENTS,
    READ_EVENTS_TOOL, READ_PROJECTION, READ_PROJECTION_TOOL, ReadEventsInput, ReadProjectionInput,
    invalid_input, model, result,
};

pub(crate) struct PreparedOperation {
    pub(crate) inputs: JsonObject,
    adapter_inputs: AdapterInputs,
    expectation: result::Expectation,
}

enum AdapterInputs {
    None,
    Append {
        event_type: String,
        event_digest: String,
    },
}

impl PreparedOperation {
    pub(crate) fn tool_ref(&self) -> &'static str {
        self.expectation.tool_ref()
    }

    pub(crate) fn validate_result(&self, value: &JsonValue) -> Result<(), RuntimeError> {
        result::validate(&self.expectation, value)
    }

    pub(crate) fn apply_adapter_inputs(&self, inputs: &mut JsonObject) {
        let AdapterInputs::Append {
            event_type,
            event_digest,
        } = &self.adapter_inputs
        else {
            return;
        };
        inputs.insert(
            "event_type".to_owned(),
            JsonValue::String(event_type.clone()),
        );
        inputs.insert(
            "event_digest".to_owned(),
            JsonValue::String(event_digest.clone()),
        );
    }
}

pub(crate) fn prepare_operation(
    tool_ref: &str,
    inputs: &JsonObject,
    observed_at: &str,
) -> Option<Result<PreparedOperation, RuntimeError>> {
    match tool_ref {
        APPEND_TOOL => Some(prepare_append(inputs, observed_at)),
        READ_EVENTS_TOOL => Some(prepare_read_events(inputs)),
        READ_PROJECTION_TOOL => Some(prepare_read_projection(inputs)),
        LIST_HEADS_TOOL => Some(prepare_list_heads(inputs)),
        _ => None,
    }
}

fn prepare_append(
    inputs: &JsonObject,
    observed_at: &str,
) -> Result<PreparedOperation, RuntimeError> {
    let mut normalized = APPEND.normalize_inputs(inputs)?;
    let observed_at = normalized
        .get("observed_at")
        .and_then(JsonValue::as_str)
        .unwrap_or(observed_at);
    normalized.insert(
        "observed_at".to_owned(),
        JsonValue::String(model::normalize_time(observed_at)?),
    );
    let decoded = decode::<AppendInput>(APPEND_TOOL, &normalized)?;
    let request = decoded.validate()?;
    let event_digest = model::digest(&JsonValue::Object(request.event.clone()))?;
    let expectation = result::Expectation::append(
        request.source,
        request.expected_version,
        request.idempotency_key,
        event_digest.clone(),
    );
    Ok(PreparedOperation {
        inputs: normalized,
        adapter_inputs: AdapterInputs::Append {
            event_type: model::event_type(request.event),
            event_digest,
        },
        expectation,
    })
}

fn prepare_read_events(inputs: &JsonObject) -> Result<PreparedOperation, RuntimeError> {
    let normalized = READ_EVENTS.normalize_inputs(inputs)?;
    let decoded = decode::<ReadEventsInput>(READ_EVENTS_TOOL, &normalized)?;
    let request = decoded.validate()?;
    let expectation =
        result::Expectation::read_events(request.source, request.limit, request.after_version);
    Ok(prepared(normalized, expectation))
}

fn prepare_read_projection(inputs: &JsonObject) -> Result<PreparedOperation, RuntimeError> {
    let normalized = READ_PROJECTION.normalize_inputs(inputs)?;
    let decoded = decode::<ReadProjectionInput>(READ_PROJECTION_TOOL, &normalized)?;
    let source = decoded.validate()?;
    Ok(prepared(
        normalized,
        result::Expectation::read_projection(source),
    ))
}

fn prepare_list_heads(inputs: &JsonObject) -> Result<PreparedOperation, RuntimeError> {
    let normalized = LIST_HEADS.normalize_inputs(inputs)?;
    let decoded = decode::<ListHeadsInput>(LIST_HEADS_TOOL, &normalized)?;
    let request = decoded.validate()?;
    let expectation = result::Expectation::list_heads(
        request.data_source_ref,
        request.resource,
        request.event_types,
        request.limit,
    );
    Ok(prepared(normalized, expectation))
}

fn prepared(inputs: JsonObject, expectation: result::Expectation) -> PreparedOperation {
    PreparedOperation {
        inputs,
        adapter_inputs: AdapterInputs::None,
        expectation,
    }
}

fn decode<I>(tool: &str, inputs: &JsonObject) -> Result<I, RuntimeError>
where
    I: crate::CapabilityInput,
{
    JsonValue::Object(inputs.clone())
        .deserialize_into()
        .map_err(|source| invalid_input(tool, format!("invalid typed input: {source}")))
}

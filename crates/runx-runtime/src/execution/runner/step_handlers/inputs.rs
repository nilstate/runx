// Typed input extraction shared by concrete step handlers.
use runx_contracts::{JsonObject, JsonValue};
use runx_parser::GraphStep;

use crate::RuntimeError;

pub(super) fn required_input_string(
    step: &GraphStep,
    inputs: &JsonObject,
    field: &str,
) -> Result<String, RuntimeError> {
    let Some(value) = inputs.get(field) else {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: format!("{field} input is required"),
        });
    };
    string_value(step, field, value)
}

pub(super) fn optional_input_string(
    step: &GraphStep,
    inputs: &JsonObject,
    field: &str,
) -> Result<Option<String>, RuntimeError> {
    let Some(value) = inputs.get(field) else {
        return Ok(None);
    };
    Ok(Some(string_value(step, field, value)?))
}

pub(super) fn string_value(
    step: &GraphStep,
    field: &str,
    value: &JsonValue,
) -> Result<String, RuntimeError> {
    Ok(string_value_ref(step, field, value)?.to_owned())
}

pub(super) fn string_value_ref<'a>(
    step: &GraphStep,
    field: &str,
    value: &'a JsonValue,
) -> Result<&'a str, RuntimeError> {
    let JsonValue::String(value) = value else {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: format!("{field} must be a string"),
        });
    };
    Ok(value)
}

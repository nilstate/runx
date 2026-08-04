use runx_contracts::{JsonObject, JsonValue};

use crate::RuntimeError;

pub(crate) fn required_string<'a>(
    tool: &str,
    object: &'a JsonObject,
    field: &str,
) -> Result<&'a str, RuntimeError> {
    optional_string(object, field)
        .ok_or_else(|| invalid_input(tool, format!("{field} must be a non-empty string")))
}

fn optional_string<'a>(object: &'a JsonObject, field: &str) -> Option<&'a str> {
    object
        .get(field)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(crate) fn invalid_input(tool: &str, message: impl Into<String>) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: tool.to_owned(),
        message: message.into(),
    }
}

use std::collections::BTreeMap;

use runx_contracts::{JsonObject, JsonValue};

use crate::RuntimeError;

pub(super) fn json_value_env(value: &JsonValue) -> Result<String, RuntimeError> {
    match value {
        JsonValue::Null => Ok(String::new()),
        JsonValue::Bool(value) => Ok(value.to_string()),
        JsonValue::Number(value) => serde_json::to_string(value)
            .map_err(|source| RuntimeError::json("serializing input number", source)),
        JsonValue::String(value) => Ok(value.clone()),
        JsonValue::Array(_) | JsonValue::Object(_) => serde_json::to_string(value)
            .map_err(|source| RuntimeError::json("serializing structured input", source)),
    }
}

pub(super) fn resolve_template(
    template: &str,
    inputs: &JsonObject,
    base_env: &BTreeMap<String, String>,
) -> String {
    let mut resolved = template.to_owned();
    for (key, value) in inputs {
        if let Ok(value) = json_value_env(value) {
            resolved = resolved.replace(&format!("{{{{{key}}}}}"), &value);
            resolved = resolved.replace(&format!("{{{{ {key} }}}}"), &value);
        }
    }
    for (key, value) in base_env {
        resolved = resolved.replace(&format!("{{{{env.{key}}}}}"), value);
        resolved = resolved.replace(&format!("{{{{ env.{key} }}}}"), value);
    }
    resolved
}

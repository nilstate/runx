use std::collections::BTreeMap;

use runx_contracts::{ExecutionRequirements, JsonObject, JsonValue};

pub(super) fn inspect(
    inspection: &JsonObject,
    environment: &BTreeMap<String, String>,
) -> Result<Option<JsonValue>, String> {
    let Some(declaration) = inspection
        .get("runner")
        .and_then(JsonValue::as_object)
        .and_then(|runner| runner.get("requirements"))
    else {
        return Ok(None);
    };
    let declaration = serde_json::from_value::<ExecutionRequirements>(
        serde_json::to_value(declaration)
            .map_err(|error| format!("serializing environment requirements: {error}"))?,
    )
    .map_err(|error| format!("decoding environment requirements: {error}"))?;
    if declaration.environment.is_empty() {
        return Ok(None);
    }

    let statuses =
        runx_runtime::environment_requirement_statuses(&declaration.environment, environment);
    let missing = statuses
        .iter()
        .filter(|status| status.required && !status.available)
        .map(|status| JsonValue::String(status.name.clone()))
        .collect::<Vec<_>>();
    let status = if missing.is_empty() {
        "ready"
    } else {
        "needs_environment"
    };
    let variables = statuses
        .into_iter()
        .map(|status| {
            serde_json::to_value(status)
                .and_then(serde_json::from_value)
                .map_err(|error| format!("serializing environment readiness: {error}"))
        })
        .collect::<Result<Vec<JsonValue>, String>>()?;
    let mut output = JsonObject::from([
        ("status".to_owned(), JsonValue::String(status.to_owned())),
        ("variables".to_owned(), JsonValue::Array(variables)),
    ]);
    if !missing.is_empty() {
        output.insert("missing".to_owned(), JsonValue::Array(missing));
    }
    Ok(Some(JsonValue::Object(output)))
}

pub(super) fn append_text(output: &mut String, inspection: &JsonObject) {
    let Some(environment) = inspection.get("environment").and_then(JsonValue::as_object) else {
        return;
    };
    let Some(variables) = environment.get("variables").and_then(JsonValue::as_array) else {
        return;
    };
    for variable in variables {
        let Some(variable) = variable.as_object() else {
            continue;
        };
        let Some(name) = variable.get("name").and_then(JsonValue::as_str) else {
            continue;
        };
        let required = variable
            .get("required")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        let available = variable
            .get("available")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        output.push_str(&format!(
            "environment: {name} ({}, {})\n",
            if required { "required" } else { "optional" },
            if available { "available" } else { "missing" }
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::inspect;
    use runx_contracts::{JsonObject, JsonValue};
    use std::collections::BTreeMap;

    #[test]
    fn readiness_reports_names_without_values() -> Result<(), String> {
        let inspection = JsonObject::from([(
            "runner".to_owned(),
            JsonValue::Object(JsonObject::from([(
                "requirements".to_owned(),
                JsonValue::Object(JsonObject::from([(
                    "environment".to_owned(),
                    JsonValue::Object(JsonObject::from([
                        (
                            "required".to_owned(),
                            JsonValue::Array(vec![JsonValue::String("REGION".to_owned())]),
                        ),
                        (
                            "optional".to_owned(),
                            JsonValue::Array(vec![JsonValue::String("TRACE_LABEL".to_owned())]),
                        ),
                    ])),
                )])),
            )])),
        )]);
        let readiness = inspect(
            &inspection,
            &BTreeMap::from([("TRACE_LABEL".to_owned(), "do-not-render".to_owned())]),
        )?
        .ok_or_else(|| "missing readiness".to_owned())?;
        let encoded = serde_json::to_string(&readiness).map_err(|error| error.to_string())?;
        assert!(encoded.contains("needs_environment"));
        assert!(encoded.contains("REGION"));
        assert!(!encoded.contains("do-not-render"));
        Ok(())
    }
}

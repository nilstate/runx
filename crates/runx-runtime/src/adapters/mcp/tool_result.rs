use runx_contracts::{JsonObject, JsonValue};

use crate::RuntimeError;

pub fn stringify_mcp_tool_result(result: &JsonValue) -> Result<String, RuntimeError> {
    if let JsonValue::Object(record) = result
        && let Some(JsonValue::Array(content)) = record.get("content")
    {
        return content
            .iter()
            .map(stringify_content_entry)
            .collect::<Result<Vec<_>, _>>()
            .map(|entries| entries.join("\n"));
    }

    match result {
        JsonValue::String(value) => Ok(value.clone()),
        value => serde_json::to_string(value)
            .map_err(|source| RuntimeError::json("serializing MCP tool result", source)),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct McpToolResultProjection {
    pub(super) value: JsonValue,
    pub(super) runx: Option<JsonObject>,
    pub(super) is_error: bool,
}

/// Project one MCP result into its semantic value and protocol evidence.
///
/// Structured content is authoritative when it contains a domain result.
/// Runx's own server reserves `structuredContent.runx` for receipt metadata and
/// places a completed result beside it in `structuredContent.output`. States
/// without an output (`needs_agent`, denied, failed) deliberately carry their
/// operator-facing value in the single text content block. This is one current
/// protocol shape, not a compatibility probe across historical envelopes.
pub(super) fn project_mcp_tool_result(result: &JsonValue) -> McpToolResultProjection {
    let JsonValue::Object(record) = result else {
        return McpToolResultProjection {
            value: result.clone(),
            runx: None,
            is_error: false,
        };
    };
    let is_error = record
        .get("isError")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let structured = record
        .get("structuredContent")
        .and_then(JsonValue::as_object);

    if let Some(structured) = structured {
        if let Some(JsonValue::Object(runx)) = structured.get("runx") {
            if let Some(output) = structured.get("output") {
                return McpToolResultProjection {
                    value: output.clone(),
                    runx: Some(runx.clone()),
                    is_error,
                };
            }
            if structured.len() == 1 {
                return McpToolResultProjection {
                    value: single_text_value(record).unwrap_or(JsonValue::Null),
                    runx: Some(runx.clone()),
                    is_error,
                };
            }
        }
        return McpToolResultProjection {
            value: JsonValue::Object(structured.clone()),
            runx: None,
            is_error,
        };
    }

    McpToolResultProjection {
        value: single_text_value(record).unwrap_or_else(|| result.clone()),
        runx: None,
        is_error,
    }
}

fn single_text_value(record: &JsonObject) -> Option<JsonValue> {
    let content = record.get("content")?.as_array()?;
    let text = (content.len() == 1)
        .then(|| content.first().and_then(text_content))
        .flatten()?;
    Some(
        serde_json::from_str::<JsonValue>(text)
            .unwrap_or_else(|_| JsonValue::String(text.to_owned())),
    )
}

fn stringify_content_entry(entry: &JsonValue) -> Result<String, RuntimeError> {
    if let Some(text) = text_content(entry) {
        return Ok(text.to_owned());
    }
    serde_json::to_string(entry)
        .map_err(|source| RuntimeError::json("serializing MCP content entry", source))
}

fn text_content(entry: &JsonValue) -> Option<&str> {
    let JsonValue::Object(record) = entry else {
        return None;
    };
    if record.get("type") != Some(&JsonValue::String("text".to_owned())) {
        return None;
    }
    record.get("text").and_then(JsonValue::as_str)
}

#[cfg(test)]
mod tests {
    use runx_contracts::{JsonObject, JsonValue};

    use super::project_mcp_tool_result;

    #[test]
    fn structured_content_is_the_semantic_tool_result() {
        let result = JsonValue::Object(JsonObject::from([
            (
                "content".to_owned(),
                JsonValue::Array(vec![text("{\"ignored\":true}")]),
            ),
            (
                "structuredContent".to_owned(),
                JsonValue::Object(JsonObject::from([(
                    "number".to_owned(),
                    JsonValue::String("42".to_owned()),
                )])),
            ),
        ]));

        assert_eq!(
            project_mcp_tool_result(&result).value,
            JsonValue::Object(JsonObject::from([(
                "number".to_owned(),
                JsonValue::String("42".to_owned()),
            )]))
        );
    }

    #[test]
    fn one_json_text_block_is_projected_without_fake_stdout() {
        let result = JsonValue::Object(JsonObject::from([(
            "content".to_owned(),
            JsonValue::Array(vec![text("{\"number\":\"42\"}")]),
        )]));

        assert_eq!(
            project_mcp_tool_result(&result).value,
            JsonValue::Object(JsonObject::from([(
                "number".to_owned(),
                JsonValue::String("42".to_owned()),
            )]))
        );
    }

    #[test]
    fn runx_envelope_separates_semantic_output_from_receipt_metadata() {
        let runx = JsonObject::from([(
            "receipt_id".to_owned(),
            JsonValue::String("sha256:fixture".to_owned()),
        )]);
        let result = JsonValue::Object(JsonObject::from([
            ("isError".to_owned(), JsonValue::Bool(true)),
            (
                "structuredContent".to_owned(),
                JsonValue::Object(JsonObject::from([
                    (
                        "output".to_owned(),
                        JsonValue::Object(JsonObject::from([(
                            "number".to_owned(),
                            JsonValue::String("42".to_owned()),
                        )])),
                    ),
                    ("runx".to_owned(), JsonValue::Object(runx.clone())),
                ])),
            ),
        ]));

        let projection = project_mcp_tool_result(&result);

        assert!(projection.is_error);
        assert_eq!(projection.runx, Some(runx));
        assert_eq!(
            projection.value,
            JsonValue::Object(JsonObject::from([(
                "number".to_owned(),
                JsonValue::String("42".to_owned()),
            )]))
        );
    }

    #[test]
    fn runx_state_without_output_uses_its_current_text_value() {
        let runx = JsonObject::from([("run_id".to_owned(), JsonValue::String("run_1".to_owned()))]);
        let result = JsonValue::Object(JsonObject::from([
            (
                "content".to_owned(),
                JsonValue::Array(vec![text("Resolve one request.")]),
            ),
            (
                "structuredContent".to_owned(),
                JsonValue::Object(JsonObject::from([(
                    "runx".to_owned(),
                    JsonValue::Object(runx.clone()),
                )])),
            ),
        ]));

        let projection = project_mcp_tool_result(&result);

        assert_eq!(projection.runx, Some(runx));
        assert_eq!(
            projection.value,
            JsonValue::String("Resolve one request.".to_owned())
        );
    }

    #[test]
    fn mixed_content_remains_lossless() {
        let result = JsonValue::Object(JsonObject::from([(
            "content".to_owned(),
            JsonValue::Array(vec![text("first"), text("second")]),
        )]));

        assert_eq!(project_mcp_tool_result(&result).value, result);
    }

    fn text(value: &str) -> JsonValue {
        JsonValue::Object(JsonObject::from([
            ("type".to_owned(), JsonValue::String("text".to_owned())),
            ("text".to_owned(), JsonValue::String(value.to_owned())),
        ]))
    }
}

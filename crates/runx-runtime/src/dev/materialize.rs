use std::collections::BTreeMap;

use runx_contracts::JsonValue;

pub(super) fn materialize_fixture_value(
    value: JsonValue,
    tokens: &BTreeMap<String, String>,
) -> JsonValue {
    match value {
        JsonValue::String(value) => JsonValue::String(materialize_fixture_string(&value, tokens)),
        JsonValue::Array(values) => JsonValue::Array(
            values
                .into_iter()
                .map(|value| materialize_fixture_value(value, tokens))
                .collect(),
        ),
        JsonValue::Object(object) => JsonValue::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, materialize_fixture_value(value, tokens)))
                .collect(),
        ),
        other => other,
    }
}

pub(super) fn materialize_fixture_string(value: &str, tokens: &BTreeMap<String, String>) -> String {
    let mut resolved = value.to_owned();
    for (key, replacement) in tokens {
        resolved = resolved.replace(&format!("${key}"), replacement);
        resolved = resolved.replace(&format!("${{{key}}}"), replacement);
    }
    resolved
}

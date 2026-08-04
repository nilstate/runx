//! Native evidence admission and artifact verification.

mod capability;
mod context;
mod effects;
mod index;
mod output;
mod paths;
mod source;
mod verify;

use runx_contracts::{JsonObject, JsonValue};

use super::NativeInvocation;
use crate::RuntimeError;

use super::capability::decode_typed_output;
pub(super) use capability::CAPABILITIES;
use capability::{EvidenceIndexInput, EvidenceVerifyInput};
use output::{EvidenceIndexOutput, EvidenceVerifyOutput};

fn index_sources(
    invocation: &NativeInvocation<'_, EvidenceIndexInput>,
) -> Result<EvidenceIndexOutput, RuntimeError> {
    decode_typed_output(
        "evidence.index_sources",
        index::build(invocation.inputs, invocation.observed_at)?,
    )
}

fn verify_artifact(
    invocation: &NativeInvocation<'_, EvidenceVerifyInput>,
) -> Result<EvidenceVerifyOutput, RuntimeError> {
    decode_typed_output(
        "evidence.verify_artifact",
        verify::build(invocation.inputs)?,
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Finding {
    code: String,
    message: String,
    path: Option<String>,
}

impl Finding {
    fn new(code: &str, message: impl Into<String>, path: Option<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            path,
        }
    }

    fn into_json(self) -> JsonValue {
        let mut value = JsonObject::from([
            ("code".to_owned(), JsonValue::String(self.code)),
            ("message".to_owned(), JsonValue::String(self.message)),
        ]);
        if let Some(path) = self.path {
            value.insert("path".to_owned(), JsonValue::String(path));
        }
        JsonValue::Object(value)
    }
}

fn object(value: Option<&JsonValue>) -> &JsonObject {
    match value.and_then(JsonValue::as_object) {
        Some(value) => value,
        None => empty_object(),
    }
}

fn empty_object() -> &'static JsonObject {
    static EMPTY: std::sync::OnceLock<JsonObject> = std::sync::OnceLock::new();
    EMPTY.get_or_init(JsonObject::new)
}

fn array(value: Option<&JsonValue>) -> &[JsonValue] {
    value
        .and_then(JsonValue::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn text(value: Option<&JsonValue>) -> String {
    value
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned()
}

fn strings(value: Option<&JsonValue>) -> Vec<String> {
    array(value)
        .iter()
        .filter_map(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn is_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests;

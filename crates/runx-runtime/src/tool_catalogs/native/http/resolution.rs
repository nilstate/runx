use std::collections::{BTreeMap, BTreeSet};

use runx_contracts::{JsonNumber, JsonObject, JsonValue};

use super::invalid;
use crate::RuntimeError;
use crate::http::{HttpMethod, RuntimeHttpHeader};

pub(super) struct Pagination {
    pub(super) cursor_param: String,
    pub(super) cursor_path: String,
    pub(super) items_path: String,
    pub(super) max_pages: usize,
    pub(super) max_items: usize,
}

pub(super) fn resolve_url_template(
    template: &str,
    prior: &BTreeMap<String, JsonObject>,
    path: &JsonObject,
) -> Result<String, RuntimeError> {
    const PREFIX: &str = "{$response:";
    let mut output = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find(PREFIX) {
        output.push_str(&rest[..start]);
        let after = &rest[start + PREFIX.len()..];
        let end = after
            .find('}')
            .ok_or_else(|| invalid("URL response reference is missing a closing brace"))?;
        let reference = &after[..end];
        let value = response_reference(prior, reference)
            .and_then(scalar_string)
            .ok_or_else(|| invalid(format!("URL references unavailable response {reference:?}")))?;
        output.push_str(&percent_encode(&value));
        rest = &after[end + 1..];
    }
    output.push_str(rest);
    resolve_path_parameters(&output, path)
}

fn resolve_path_parameters(template: &str, path: &JsonObject) -> Result<String, RuntimeError> {
    let mut output = String::with_capacity(template.len());
    let mut rest = template;
    let mut consumed = BTreeSet::new();
    while let Some(start) = rest.find('{') {
        output.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after
            .find('}')
            .ok_or_else(|| invalid("URL path parameter is missing a closing brace"))?;
        let name = &after[..end];
        if name.is_empty()
            || !name.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
            })
        {
            return Err(invalid(format!("invalid URL path parameter {name:?}")));
        }
        let value = path
            .get(name)
            .and_then(scalar_string)
            .ok_or_else(|| invalid(format!("URL path parameter {name:?} is missing")))?;
        output.push_str(&percent_encode(&value));
        consumed.insert(name);
        rest = &after[end + 1..];
    }
    output.push_str(rest);
    if let Some(name) = path.keys().find(|name| !consumed.contains(name.as_str())) {
        return Err(invalid(format!(
            "path parameter {name:?} is not present in the request URL"
        )));
    }
    Ok(output)
}

fn scalar_string(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(value) => Some(value.clone()),
        JsonValue::Bool(value) => Some(value.to_string()),
        JsonValue::Number(value) => Some(value.to_string()),
        JsonValue::Null | JsonValue::Array(_) | JsonValue::Object(_) => None,
    }
}

pub(super) fn pagination(value: Option<&JsonValue>) -> Result<Option<Pagination>, RuntimeError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or_else(|| invalid("pagination must be an object"))?;
    let max_pages = optional_positive_usize(object, "max_pages", 10)?.min(20);
    let max_items = optional_positive_usize(object, "max_items", 200)?.min(10_000);
    Ok(Some(Pagination {
        cursor_param: required_string(object, "cursor_param")?.to_owned(),
        cursor_path: required_path(object, "cursor_path")?.to_owned(),
        items_path: required_path(object, "items_path")?.to_owned(),
        max_pages,
        max_items,
    }))
}

fn required_path<'a>(object: &'a JsonObject, field: &str) -> Result<&'a str, RuntimeError> {
    let path = required_string(object, field)?;
    if path
        .split('.')
        .any(|segment| segment.is_empty() || !segment.chars().all(path_character))
    {
        return Err(invalid(format!(
            "{field} must be a dot path of letters, digits, underscores, or hyphens"
        )));
    }
    Ok(path)
}

fn path_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
}

pub(super) fn optional_positive_usize(
    object: &JsonObject,
    field: &str,
    default: usize,
) -> Result<usize, RuntimeError> {
    let Some(value) = object.get(field) else {
        return Ok(default);
    };
    json_u64(value)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid(format!("{field} must be a positive integer")))
}

pub(super) fn value_at_path<'a>(value: &'a JsonValue, path: &str) -> Option<&'a JsonValue> {
    path.split('.')
        .try_fold(value, |current, segment| current.as_object()?.get(segment))
}

pub(super) fn allowed_hosts(values: &[String]) -> Result<BTreeSet<String>, RuntimeError> {
    let hosts = values
        .iter()
        .map(|value| {
            let host = value.trim();
            if host.is_empty() {
                return Err(invalid("allowed_hosts entries must be non-empty strings"));
            }
            if host.contains(['/', ':', '*', '?', '#', '@']) {
                return Err(invalid(format!(
                    "allowed host {host:?} must be an exact hostname"
                )));
            }
            Ok(host.trim_end_matches('.').to_ascii_lowercase())
        })
        .collect::<Result<BTreeSet<_>, RuntimeError>>()?;
    if hosts.is_empty() {
        return Err(invalid("allowed_hosts must not be empty"));
    }
    Ok(hosts)
}

pub(super) fn request_headers(
    value: Option<&JsonValue>,
) -> Result<Vec<RuntimeHttpHeader>, RuntimeError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let object = value
        .as_object()
        .ok_or_else(|| invalid("request headers must be an object"))?;
    object
        .iter()
        .map(|(name, value)| {
            value
                .as_str()
                .map(|value| RuntimeHttpHeader::new(name, value))
                .ok_or_else(|| invalid(format!("header {name:?} must be a string")))
        })
        .collect()
}

pub(super) fn resolve_object(
    value: Option<&JsonValue>,
    prior: &BTreeMap<String, JsonObject>,
    field: &str,
) -> Result<JsonObject, RuntimeError> {
    let Some(value) = value else {
        return Ok(JsonObject::new());
    };
    match resolve_value(value.clone(), prior, field)? {
        JsonValue::Object(object) => Ok(object),
        _ => Err(invalid(format!("{field} must be an object"))),
    }
}

pub(super) fn resolve_value(
    value: JsonValue,
    prior: &BTreeMap<String, JsonObject>,
    field: &str,
) -> Result<JsonValue, RuntimeError> {
    match value {
        JsonValue::Object(object) if object.len() == 1 && object.contains_key("$response") => {
            let reference = object
                .get("$response")
                .and_then(JsonValue::as_str)
                .ok_or_else(|| invalid(format!("{field}.$response must be a string")))?;
            response_reference(prior, reference)
                .cloned()
                .ok_or_else(|| {
                    invalid(format!(
                        "{field} references unavailable response {reference:?}"
                    ))
                })
        }
        JsonValue::Object(object) => object
            .into_iter()
            .map(|(key, value)| {
                Ok((
                    key.clone(),
                    resolve_value(value, prior, &format!("{field}.{key}"))?,
                ))
            })
            .collect::<Result<JsonObject, RuntimeError>>()
            .map(JsonValue::Object),
        JsonValue::Array(values) => values
            .into_iter()
            .enumerate()
            .map(|(index, value)| resolve_value(value, prior, &format!("{field}[{index}]")))
            .collect::<Result<Vec<_>, _>>()
            .map(JsonValue::Array),
        value => Ok(value),
    }
}

pub(super) fn response_reference<'a>(
    prior: &'a BTreeMap<String, JsonObject>,
    reference: &str,
) -> Option<&'a JsonValue> {
    let (request_id, path) = reference.split_once('.')?;
    let mut current = prior.get(request_id)?.get(path.split('.').next()?)?;
    for segment in path.split('.').skip(1) {
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

pub(super) fn scalar_pairs(
    object: &JsonObject,
    field: &str,
) -> Result<Vec<(String, String)>, RuntimeError> {
    object
        .iter()
        .filter(|(_, value)| **value != JsonValue::Null)
        .map(|(key, value)| {
            let value = match value {
                JsonValue::String(value) => value.clone(),
                JsonValue::Bool(value) => value.to_string(),
                JsonValue::Number(value) => value.to_string(),
                _ => {
                    return Err(invalid(format!("{field}.{key} must be a scalar value")));
                }
            };
            Ok((key.clone(), value))
        })
        .collect()
}

pub(super) fn method(value: Option<&str>) -> Result<HttpMethod, RuntimeError> {
    match value.unwrap_or("GET").to_ascii_uppercase().as_str() {
        "GET" => Ok(HttpMethod::Get),
        "POST" => Ok(HttpMethod::Post),
        "PUT" => Ok(HttpMethod::Put),
        "PATCH" => Ok(HttpMethod::Patch),
        "DELETE" => Ok(HttpMethod::Delete),
        other => Err(invalid(format!("unsupported HTTP method {other:?}"))),
    }
}

pub(super) fn required_string<'a>(
    object: &'a JsonObject,
    field: &str,
) -> Result<&'a str, RuntimeError> {
    object
        .get(field)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{field} must be a non-empty string")))
}

pub(super) fn json_u64(value: &JsonValue) -> Option<u64> {
    match value {
        JsonValue::Number(JsonNumber::U64(value)) => Some(*value),
        JsonValue::Number(JsonNumber::I64(value)) => u64::try_from(*value).ok(),
        JsonValue::Number(JsonNumber::F64(value)) if value.fract() == 0.0 && *value >= 0.0 => {
            Some(*value as u64)
        }
        _ => None,
    }
}

pub(super) fn estimated_size(value: &JsonObject) -> Result<usize, RuntimeError> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|error| invalid(format!("serializing HTTP response: {error}")))
}

pub(super) fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

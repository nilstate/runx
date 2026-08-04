use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use runx_contracts::JsonValue;

use crate::document_input::{DocumentInputSource, read_document_input};

pub(super) fn parse_direct_input_arg(
    args: &[OsString],
    mut index: usize,
    token: &str,
    inputs: &mut BTreeMap<String, JsonValue>,
) -> Result<usize, String> {
    if token.contains('=') {
        let (key, value) = token.split_once('=').ok_or_else(|| {
            "runx skill argument must use --name value or --name=value".to_owned()
        })?;
        insert_input(inputs, key, value.to_owned())?;
    } else {
        let key = token.trim_start_matches("--");
        index += 1;
        insert_input(inputs, key, string_arg(args, index)?)?;
    }
    Ok(index)
}

pub(super) fn parse_input_arg(
    args: &[OsString],
    mut index: usize,
    inline_value: Option<&str>,
    inputs: &mut BTreeMap<String, JsonValue>,
) -> Result<usize, String> {
    if let Some(value) = inline_value {
        parse_input_assignment(value, None, inputs)?;
        return Ok(index);
    }

    index += 1;
    let key_or_assignment = string_arg(args, index)?;
    if key_or_assignment.contains('=') {
        parse_input_assignment(&key_or_assignment, None, inputs)?;
    } else {
        index += 1;
        parse_input_assignment(&key_or_assignment, Some(string_arg(args, index)?), inputs)?;
    }
    Ok(index)
}

pub(super) fn parse_json_input_arg(
    args: &[OsString],
    mut index: usize,
    inline_value: Option<&str>,
    inputs: &mut BTreeMap<String, JsonValue>,
) -> Result<usize, String> {
    if let Some(value) = inline_value {
        parse_json_input_assignment(value, None, inputs)?;
        return Ok(index);
    }

    index += 1;
    let key_or_assignment = string_arg(args, index)?;
    if key_or_assignment.contains('=') {
        parse_json_input_assignment(&key_or_assignment, None, inputs)?;
    } else {
        index += 1;
        parse_json_input_assignment(&key_or_assignment, Some(string_arg(args, index)?), inputs)?;
    }
    Ok(index)
}

pub(super) fn parse_input_document_arg(
    args: &[OsString],
    mut index: usize,
    inline_value: Option<&str>,
    source: &mut Option<DocumentInputSource>,
) -> Result<usize, String> {
    if source.is_some() {
        return Err("runx skill accepts exactly one --inputs document".to_owned());
    }
    let value = if let Some(value) = inline_value {
        value.to_owned()
    } else {
        index += 1;
        string_arg(args, index)?
    };
    let value = value.trim();
    if value.is_empty() {
        return Err("runx skill --inputs requires a file path or - for stdin".to_owned());
    }
    *source = Some(if value == "-" {
        DocumentInputSource::Stdin
    } else {
        DocumentInputSource::Path(PathBuf::from(value))
    });
    Ok(index)
}

pub(super) fn read_input_document(
    source: &DocumentInputSource,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<BTreeMap<String, JsonValue>, String> {
    let raw = read_document_input(source, env, cwd)
        .map_err(|error| format!("runx skill --inputs could not be read: {error}"))?;
    let value: JsonValue = serde_json::from_str(&raw)
        .map_err(|error| format!("runx skill --inputs contains invalid JSON: {error}"))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "runx skill --inputs must contain one JSON object".to_owned())
}

fn parse_input_assignment(
    key_or_assignment: &str,
    explicit_value: Option<String>,
    inputs: &mut BTreeMap<String, JsonValue>,
) -> Result<(), String> {
    match explicit_value {
        Some(value) => insert_input(inputs, key_or_assignment, value),
        None => {
            let (key, value) = key_or_assignment
                .split_once('=')
                .ok_or_else(|| "runx skill --input requires key=value or key value".to_owned())?;
            insert_input(inputs, key, value.to_owned())
        }
    }
}

fn parse_json_input_assignment(
    key_or_assignment: &str,
    explicit_value: Option<String>,
    inputs: &mut BTreeMap<String, JsonValue>,
) -> Result<(), String> {
    match explicit_value {
        Some(value) => insert_json_input(inputs, key_or_assignment, &value),
        None => {
            let (key, value) = key_or_assignment.split_once('=').ok_or_else(|| {
                "runx skill --input-json requires key=<json> or key <json>".to_owned()
            })?;
            insert_json_input(inputs, key, value)
        }
    }
}

fn insert_input(
    inputs: &mut BTreeMap<String, JsonValue>,
    raw_key: &str,
    raw_value: String,
) -> Result<(), String> {
    let key = normalize_input_key(raw_key);
    if key.is_empty() {
        return Err("runx skill input key must be non-empty".to_owned());
    }
    insert_unique(inputs, key, parse_cli_value(&raw_value))
}

fn insert_json_input(
    inputs: &mut BTreeMap<String, JsonValue>,
    raw_key: &str,
    raw_value: &str,
) -> Result<(), String> {
    let key = normalize_input_key(raw_key);
    if key.is_empty() {
        return Err("runx skill input key must be non-empty".to_owned());
    }
    let value = serde_json::from_str(raw_value)
        .map_err(|error| format!("runx skill --input-json {key} is invalid JSON: {error}"))?;
    insert_unique(inputs, key, value)
}

fn insert_unique(
    inputs: &mut BTreeMap<String, JsonValue>,
    key: String,
    value: JsonValue,
) -> Result<(), String> {
    if inputs.contains_key(&key) {
        return Err(format!(
            "runx skill input {key:?} was supplied more than once"
        ));
    }
    inputs.insert(key, value);
    Ok(())
}

fn normalize_input_key(raw: &str) -> String {
    raw.trim()
        .trim_start_matches("--")
        .replace('-', "_")
        .to_owned()
}

fn parse_cli_value(raw: &str) -> JsonValue {
    serde_json::from_str(raw).unwrap_or_else(|_| JsonValue::String(raw.to_owned()))
}

fn string_arg(args: &[OsString], index: usize) -> Result<String, String> {
    let value = args
        .get(index)
        .ok_or_else(|| "missing value for runx skill argument".to_owned())?;
    value
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "runx skill arguments must be UTF-8".to_owned())
}

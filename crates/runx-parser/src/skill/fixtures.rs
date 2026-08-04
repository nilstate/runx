use std::collections::BTreeMap;

use runx_contracts::{JsonObject, JsonValue};
use serde::{Deserialize, Serialize};

use crate::ValidationError;
pub use crate::harness_fixture::{HarnessExpectation, ReceiptExpectation};

use super::FIELDS;

const RUNTIME_OWNED_HARNESS_ENV: &[&str] = &["RUNX_CWD", "RUNX_RECEIPT_DIR"];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HarnessCallerFixture {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answers: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approvals: Option<BTreeMap<String, bool>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunnerHarnessCase {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner: Option<String>,
    pub inputs: JsonObject,
    pub env: BTreeMap<String, String>,
    pub caller: HarnessCallerFixture,
    pub expect: HarnessExpectation,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunnerHarnessManifest {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    pub cases: Vec<RunnerHarnessCase>,
}

pub(crate) fn validate_harness_manifest(
    value: Option<JsonObject>,
    field: &str,
) -> Result<Option<RunnerHarnessManifest>, ValidationError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let files = FIELDS
        .optional_string_array(value.get("files"), &format!("{field}.files"))?
        .unwrap_or_default();
    let cases = FIELDS
        .required_plain_array(value.get("cases"), &format!("{field}.cases"))?
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            validate_harness_case(
                FIELDS.required_object(Some(entry), &format!("{field}.cases[{index}]"))?,
                &format!("{field}.cases[{index}]"),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(RunnerHarnessManifest { files, cases }))
}

fn validate_harness_case(
    value: &JsonObject,
    field: &str,
) -> Result<RunnerHarnessCase, ValidationError> {
    Ok(RunnerHarnessCase {
        name: FIELDS.required_string(value.get("name"), &format!("{field}.name"))?,
        runner: FIELDS
            .optional_non_empty_string(value.get("runner"), &format!("{field}.runner"))?,
        inputs: FIELDS
            .optional_object(value.get("inputs"), &format!("{field}.inputs"))?
            .unwrap_or_default(),
        env: validate_string_object(
            FIELDS
                .optional_object(value.get("env"), &format!("{field}.env"))?
                .unwrap_or_default(),
            &format!("{field}.env"),
        )?,
        caller: validate_harness_caller(
            FIELDS
                .optional_object(value.get("caller"), &format!("{field}.caller"))?
                .unwrap_or_default(),
            &format!("{field}.caller"),
        )?,
        expect: validate_harness_expectation(
            FIELDS.required_object(value.get("expect"), &format!("{field}.expect"))?,
            &format!("{field}.expect"),
        )?,
    })
}

fn validate_string_object(
    value: JsonObject,
    field: &str,
) -> Result<BTreeMap<String, String>, ValidationError> {
    value
        .into_iter()
        .map(|(key, value)| {
            if RUNTIME_OWNED_HARNESS_ENV.contains(&key.as_str()) {
                return Err(FIELDS.validation_error(format!(
                    "{field}.{key} is owned by the isolated harness runtime and cannot be overridden."
                )));
            }
            match value {
                JsonValue::String(value) => Ok((key, value)),
                _ => Err(FIELDS.validation_error(format!("{field}.{key} must be a string."))),
            }
        })
        .collect()
}

fn validate_harness_caller(
    value: JsonObject,
    field: &str,
) -> Result<HarnessCallerFixture, ValidationError> {
    Ok(HarnessCallerFixture {
        answers: FIELDS.optional_object(value.get("answers"), &format!("{field}.answers"))?,
        approvals: Some(validate_bool_object(
            FIELDS
                .optional_object(value.get("approvals"), &format!("{field}.approvals"))?
                .unwrap_or_default(),
            &format!("{field}.approvals"),
        )?),
    })
}

fn validate_bool_object(
    value: JsonObject,
    field: &str,
) -> Result<BTreeMap<String, bool>, ValidationError> {
    value
        .into_iter()
        .map(|(key, value)| match value {
            JsonValue::Bool(value) => Ok((key, value)),
            _ => Err(FIELDS.validation_error(format!("{field}.{key} must be a boolean."))),
        })
        .collect()
}

fn validate_harness_expectation(
    value: &JsonObject,
    field: &str,
) -> Result<HarnessExpectation, ValidationError> {
    crate::harness_fixture::parse_harness_expectation(value.clone())
        .map_err(|error| FIELDS.validation_error(format!("{field}: {error}")))
}

#[cfg(test)]
mod tests {
    use crate::{parse_runner_manifest_yaml, validate_runner_manifest};

    #[test]
    fn inline_harness_cannot_override_runtime_owned_isolation()
    -> Result<(), Box<dyn std::error::Error>> {
        for key in ["RUNX_CWD", "RUNX_RECEIPT_DIR"] {
            let raw = parse_runner_manifest_yaml(&format!(
                r#"
skill: fixture
harness:
  cases:
    - name: escape
      env:
        {key}: "."
      inputs: {{}}
      expect:
        status: sealed
runners:
  fixture:
    default: true
    type: graph
    graph:
      name: fixture
      result_from:
        - digest
      steps:
        - id: digest
          tool: data.digest
          inputs:
            value: fixture
"#
            ))?;
            let Err(error) = validate_runner_manifest(raw) else {
                return Err("runtime-owned harness environment was accepted".into());
            };

            assert!(error.to_string().contains("isolated harness runtime"));
        }
        Ok(())
    }
}

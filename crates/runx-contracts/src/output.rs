//! Skill output declaration types: the value shape of the `runx.ai/spec`
//! output map (a field is either a bare type name or a typed field spec).
//!
//! The standalone `output.schema.json` document is a top-level open map carrying
//! a bare `$id`; it is modeled here as the transparent map newtype [`Output`],
//! whose `RunxSchema` derive emits the committed `patternProperties` shape. The
//! same `BTreeMap<String, OutputField>` is embedded by the agent-context
//! envelope's `output` field.
use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::fingerprint::sha256_prefixed;
use crate::json::{JsonNumber, JsonObject, JsonValue};
use crate::schema::{NonEmptyString, RunxSchema};

/// The diagnostic/base fields a step projection always injects into its `outputs`
/// map for receipts, effect replay, and debugging. They are NOT part of a step's
/// addressable contract: a graph context edge may bind only to declared outputs and
/// artifact packets, never to these. This is the single source of truth shared by the
/// runtime projection/resolver and the parser's parse-time context-edge validation, so
/// the addressable surface cannot drift between the two layers.
pub const BASE_OUTPUT_FIELDS: &[&str] = &["raw", "skill_claim", "stdout", "stderr", "status"];

/// A declared output value type.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "lowercase")]
pub enum OutputType {
    String,
    Number,
    Integer,
    Boolean,
    Array,
    Object,
    Null,
}

/// The expanded form of an output field declaration. Committed with
/// `additionalProperties: false` and `minProperties: 1` (the latter is a
/// numeric bound the emitter does not express).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct OutputFieldSpec {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub field_type: Option<OutputType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap_as: Option<NonEmptyString>,
    #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
}

/// A single output field declaration: either a bare type name or a typed spec.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(untagged)]
pub enum OutputField {
    Type(OutputType),
    Spec(OutputFieldSpec),
}

/// The standalone `output.schema.json` document: a top-level open map of field
/// name to [`OutputField`], carrying the bare `runx.ai/spec` `$id`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(transparent)]
#[runx_schema(spec_id = "https://runx.ai/spec/output.schema.json")]
pub struct Output(pub BTreeMap<String, OutputField>);

/// A deterministic output-contract violation at the native trust boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputValidationError {
    path: String,
    message: String,
}

impl OutputValidationError {
    fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }

    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for OutputValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.path, self.message)
    }
}

impl std::error::Error for OutputValidationError {}

/// Build the exact JSON schema presented to an agent for its final result.
/// Runtime validation below is derived from the same declarations, keeping the
/// model hint and the enforced boundary on one semantic source.
#[must_use]
pub fn output_value_schema(output: Option<&BTreeMap<String, OutputField>>) -> JsonValue {
    let Some(output) = output.filter(|fields| !fields.is_empty()) else {
        return object_schema();
    };

    let mut properties = JsonObject::new();
    let mut required = Vec::new();
    for (name, field) in output {
        properties.insert(name.clone(), output_field_schema(field));
        if output_field_required(field) {
            required.push(JsonValue::String(name.clone()));
        }
    }

    let mut schema = JsonObject::new();
    schema.insert("type".to_owned(), JsonValue::String("object".to_owned()));
    schema.insert("properties".to_owned(), JsonValue::Object(properties));
    schema.insert("additionalProperties".to_owned(), JsonValue::Bool(false));
    if !required.is_empty() {
        schema.insert("required".to_owned(), JsonValue::Array(required));
    }
    JsonValue::Object(schema)
}

/// Hash the enforced output contract using the deterministic boundary JSON
/// representation. This digest is suitable for signed receipt evidence.
pub fn output_contract_digest(
    output: Option<&BTreeMap<String, OutputField>>,
) -> Result<String, serde_json::Error> {
    serde_json::to_vec(&output_value_schema(output)).map(|bytes| sha256_prefixed(&bytes))
}

/// Validate an agent's final result against its declared output contract.
/// Undeclared fields are rejected whenever a declaration is present; an absent
/// declaration still requires a JSON object but intentionally leaves it open.
pub fn validate_output_value(
    output: Option<&BTreeMap<String, OutputField>>,
    value: &JsonValue,
) -> Result<(), OutputValidationError> {
    let JsonValue::Object(object) = value else {
        return Err(OutputValidationError::new("$", "expected object"));
    };
    let Some(output) = output.filter(|fields| !fields.is_empty()) else {
        return Ok(());
    };

    if let Some(name) = object.keys().find(|name| !output.contains_key(*name)) {
        return Err(OutputValidationError::new(
            format!("$.{name}"),
            "field is not declared by the output contract",
        ));
    }

    for (name, field) in output {
        match object.get(name) {
            Some(value) => validate_output_field(name, field, value)?,
            None if output_field_required(field) => {
                return Err(OutputValidationError::new(
                    format!("$.{name}"),
                    "required field is missing",
                ));
            }
            None => {}
        }
    }
    Ok(())
}

fn object_schema() -> JsonValue {
    let mut schema = JsonObject::new();
    schema.insert("type".to_owned(), JsonValue::String("object".to_owned()));
    JsonValue::Object(schema)
}

fn output_field_required(field: &OutputField) -> bool {
    match field {
        OutputField::Type(_) => true,
        OutputField::Spec(spec) => spec.required.unwrap_or(true),
    }
}

fn output_field_schema(field: &OutputField) -> JsonValue {
    let mut schema = JsonObject::new();
    match field {
        OutputField::Type(field_type) => {
            schema.insert(
                "type".to_owned(),
                JsonValue::String(output_type_name(field_type).to_owned()),
            );
        }
        OutputField::Spec(spec) => {
            if let Some(field_type) = spec.field_type.as_ref() {
                schema.insert(
                    "type".to_owned(),
                    JsonValue::String(output_type_name(field_type).to_owned()),
                );
            }
            if let Some(values) = spec.enum_values.as_ref() {
                schema.insert(
                    "enum".to_owned(),
                    JsonValue::Array(values.iter().cloned().map(JsonValue::String).collect()),
                );
            }
            if let Some(description) = spec.description.as_ref() {
                schema.insert(
                    "description".to_owned(),
                    JsonValue::String(description.clone()),
                );
            }
        }
    }
    JsonValue::Object(schema)
}

const fn output_type_name(field_type: &OutputType) -> &'static str {
    match field_type {
        OutputType::String => "string",
        OutputType::Number => "number",
        OutputType::Integer => "integer",
        OutputType::Boolean => "boolean",
        OutputType::Array => "array",
        OutputType::Object => "object",
        OutputType::Null => "null",
    }
}

fn validate_output_field(
    name: &str,
    field: &OutputField,
    value: &JsonValue,
) -> Result<(), OutputValidationError> {
    let (field_type, enum_values) = match field {
        OutputField::Type(field_type) => (Some(field_type), None),
        OutputField::Spec(spec) => (spec.field_type.as_ref(), spec.enum_values.as_ref()),
    };
    if let Some(field_type) = field_type {
        if !value_matches_type(value, field_type) {
            return Err(OutputValidationError::new(
                format!("$.{name}"),
                format!("expected {}", output_type_name(field_type)),
            ));
        }
    }
    if let Some(enum_values) = enum_values {
        let Some(actual) = value.as_str() else {
            return Err(OutputValidationError::new(
                format!("$.{name}"),
                "expected a string enum value",
            ));
        };
        if !enum_values.iter().any(|candidate| candidate == actual) {
            return Err(OutputValidationError::new(
                format!("$.{name}"),
                "value is not in the declared enum",
            ));
        }
    }
    Ok(())
}

fn value_matches_type(value: &JsonValue, field_type: &OutputType) -> bool {
    match (field_type, value) {
        (OutputType::String, JsonValue::String(_))
        | (OutputType::Number, JsonValue::Number(_))
        | (OutputType::Boolean, JsonValue::Bool(_))
        | (OutputType::Array, JsonValue::Array(_))
        | (OutputType::Object, JsonValue::Object(_))
        | (OutputType::Null, JsonValue::Null) => true,
        (OutputType::Integer, JsonValue::Number(JsonNumber::I64(_) | JsonNumber::U64(_))) => true,
        (OutputType::Integer, JsonValue::Number(JsonNumber::F64(value))) => {
            value.is_finite() && value.fract() == 0.0
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        OutputField, OutputFieldSpec, OutputType, output_contract_digest, output_value_schema,
        validate_output_value,
    };
    use crate::{JsonNumber, JsonValue};
    use std::collections::BTreeMap;

    fn declared_output() -> BTreeMap<String, OutputField> {
        [
            (
                "notify_plan".to_owned(),
                OutputField::Type(OutputType::Object),
            ),
            (
                "status".to_owned(),
                OutputField::Spec(OutputFieldSpec {
                    field_type: Some(OutputType::String),
                    description: None,
                    required: Some(false),
                    wrap_as: None,
                    enum_values: Some(vec!["ready".to_owned(), "blocked".to_owned()]),
                }),
            ),
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn output_schema_and_validator_share_strict_declared_fields()
    -> Result<(), Box<dyn std::error::Error>> {
        let output = declared_output();
        let valid = JsonValue::Object(
            [("notify_plan".to_owned(), JsonValue::Object(BTreeMap::new()))]
                .into_iter()
                .collect(),
        );
        let extra = JsonValue::Object(
            [
                ("notify_plan".to_owned(), JsonValue::Object(BTreeMap::new())),
                ("message".to_owned(), JsonValue::String("secret".to_owned())),
            ]
            .into_iter()
            .collect(),
        );

        assert!(validate_output_value(Some(&output), &valid).is_ok());
        let Err(error) = validate_output_value(Some(&output), &extra) else {
            return Err("extra field must fail".into());
        };
        assert_eq!(error.path(), "$.message");
        assert!(
            serde_json::to_string(&output_value_schema(Some(&output)))?
                .contains("\"additionalProperties\":false")
        );
        Ok(())
    }

    #[test]
    fn output_validator_enforces_required_type_and_enum() -> Result<(), Box<dyn std::error::Error>>
    {
        let output = declared_output();
        let missing = JsonValue::Object(BTreeMap::new());
        let wrong_enum = JsonValue::Object(
            [
                ("notify_plan".to_owned(), JsonValue::Object(BTreeMap::new())),
                ("status".to_owned(), JsonValue::String("sent".to_owned())),
            ]
            .into_iter()
            .collect(),
        );
        let wrong_type = JsonValue::Object(
            [(
                "notify_plan".to_owned(),
                JsonValue::Number(JsonNumber::I64(1)),
            )]
            .into_iter()
            .collect(),
        );

        let Err(error) = validate_output_value(Some(&output), &missing) else {
            return Err("missing required field must fail".into());
        };
        assert_eq!(error.path(), "$.notify_plan");
        assert!(validate_output_value(Some(&output), &wrong_enum).is_err());
        assert!(validate_output_value(Some(&output), &wrong_type).is_err());
        Ok(())
    }

    #[test]
    fn output_contract_digest_is_stable() -> Result<(), serde_json::Error> {
        let output = declared_output();
        assert_eq!(
            output_contract_digest(Some(&output))?,
            output_contract_digest(Some(&output))?
        );
        Ok(())
    }
}

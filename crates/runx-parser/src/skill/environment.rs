use std::collections::BTreeSet;

use runx_contracts::{EnvironmentRequirements, JsonValue};

use crate::ValidationError;

use super::FIELDS;

const ENVIRONMENT_FIELDS: &[&str] = &["required", "optional"];

pub(crate) fn validate_environment_requirements(
    value: Option<&JsonValue>,
) -> Result<EnvironmentRequirements, ValidationError> {
    let Some(value) = value else {
        return Ok(EnvironmentRequirements::default());
    };
    let environment = FIELDS.required_object(Some(value), "source.environment")?;
    FIELDS.reject_unknown_fields(environment, "source.environment", ENVIRONMENT_FIELDS)?;
    let required = FIELDS
        .optional_string_array(environment.get("required"), "source.environment.required")?
        .unwrap_or_default();
    let optional = FIELDS
        .optional_string_array(environment.get("optional"), "source.environment.optional")?
        .unwrap_or_default();
    validate_names(&required, &optional)?;
    Ok(EnvironmentRequirements { required, optional })
}

fn validate_names(required: &[String], optional: &[String]) -> Result<(), ValidationError> {
    let mut seen = BTreeSet::new();
    for (field, names) in [
        ("source.environment.required", required),
        ("source.environment.optional", optional),
    ] {
        for name in names {
            validate_name(name, field)?;
            if !seen.insert(name.as_str()) {
                return Err(FIELDS
                    .validation_error(format!("{field} repeats environment variable {name:?}")));
            }
        }
    }
    Ok(())
}

fn validate_name(name: &str, field: &str) -> Result<(), ValidationError> {
    let mut chars = name.chars();
    let valid_start = chars
        .next()
        .is_some_and(|character| character == '_' || character.is_ascii_alphabetic());
    if !valid_start || !chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
    {
        return Err(FIELDS.validation_error(format!(
            "{field} entry {name:?} must be a portable environment variable name"
        )));
    }
    if is_reserved_runx_environment_name(name) {
        return Err(FIELDS.validation_error(format!(
            "{field} cannot request runtime-reserved environment variable {name}"
        )));
    }
    Ok(())
}

pub(crate) fn is_reserved_runx_environment_name(name: &str) -> bool {
    name.starts_with("RUNX_")
}

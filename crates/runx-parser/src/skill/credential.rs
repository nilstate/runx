use std::collections::BTreeMap;

use runx_contracts::JsonValue;

use crate::ValidationError;

use super::{CredentialRequirement, FIELDS, environment::is_reserved_runx_environment_name};

const CREDENTIAL_FIELDS: &[&str] = &["provider", "audience", "auth"];
const AUTH_MODE_FIELDS: &[&str] = &["delivery"];
const DELIVERY_FIELDS: &[&str] = &["env"];

pub(crate) fn validate_credential_requirements(
    value: Option<&JsonValue>,
) -> Result<BTreeMap<String, CredentialRequirement>, ValidationError> {
    let Some(credentials) = FIELDS.optional_object(value, "credentials")? else {
        return Ok(BTreeMap::new());
    };
    credentials
        .iter()
        .map(|(name, value)| validate_credential_requirement(name, value))
        .collect()
}

fn validate_credential_requirement(
    name: &str,
    value: &JsonValue,
) -> Result<(String, CredentialRequirement), ValidationError> {
    let field = format!("credentials.{name}");
    if name.trim().is_empty() {
        return Err(FIELDS.validation_error("credential names must not be empty"));
    }
    let requirement = FIELDS.required_object(Some(value), &field)?;
    FIELDS.reject_unknown_fields(requirement, &field, CREDENTIAL_FIELDS)?;
    let provider =
        required_non_empty_string(requirement.get("provider"), &format!("{field}.provider"))?;
    let audience = FIELDS
        .optional_non_empty_string(requirement.get("audience"), &format!("{field}.audience"))?;
    let auth_field = format!("{field}.auth");
    let auth = FIELDS.required_object(requirement.get("auth"), &auth_field)?;
    if auth.is_empty() {
        return Err(FIELDS.validation_error(format!("{auth_field} must declare at least one mode")));
    }
    let deliveries = auth
        .iter()
        .map(|(auth_mode, value)| validate_auth_mode(&auth_field, auth_mode, value))
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    Ok((
        name.to_owned(),
        CredentialRequirement {
            provider,
            audience,
            deliveries,
        },
    ))
}

fn validate_auth_mode(
    auth_field: &str,
    auth_mode: &str,
    value: &JsonValue,
) -> Result<(String, String), ValidationError> {
    if auth_mode.trim().is_empty() {
        return Err(FIELDS.validation_error(format!("{auth_field} mode names must not be empty")));
    }
    let field = format!("{auth_field}.{auth_mode}");
    let mode = FIELDS.required_object(Some(value), &field)?;
    FIELDS.reject_unknown_fields(mode, &field, AUTH_MODE_FIELDS)?;
    let delivery_field = format!("{field}.delivery");
    let delivery = FIELDS.required_object(mode.get("delivery"), &delivery_field)?;
    FIELDS.reject_unknown_fields(delivery, &delivery_field, DELIVERY_FIELDS)?;
    let delivery_env =
        required_non_empty_string(delivery.get("env"), &format!("{delivery_field}.env"))?;
    validate_delivery_env(&delivery_env, &format!("{delivery_field}.env"))?;
    Ok((auth_mode.to_owned(), delivery_env))
}

fn validate_delivery_env(value: &str, field: &str) -> Result<(), ValidationError> {
    let mut chars = value.chars();
    let valid_start = chars
        .next()
        .is_some_and(|character| character == '_' || character.is_ascii_alphabetic());
    if !valid_start || !chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
    {
        return Err(
            FIELDS.validation_error(format!("{field} must be a valid environment variable name"))
        );
    }
    if is_reserved_runx_environment_name(value) {
        return Err(FIELDS.validation_error(format!(
            "{field} cannot use reserved Runx environment variable {value}"
        )));
    }
    Ok(())
}

pub(crate) fn validate_runner_credential_references(
    runners: &BTreeMap<String, super::SkillRunnerDefinition>,
    credentials: &BTreeMap<String, CredentialRequirement>,
) -> Result<(), ValidationError> {
    for (runner_name, runner) in runners {
        if let Some(credential) = runner.credential.as_ref()
            && !credentials.contains_key(credential)
        {
            return Err(FIELDS.validation_error(format!(
                "runners.{runner_name}.credential references undeclared credential {credential}"
            )));
        }
    }
    Ok(())
}

fn required_non_empty_string(
    value: Option<&JsonValue>,
    field: &str,
) -> Result<String, ValidationError> {
    let value = FIELDS.required_string(value, field)?;
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(FIELDS.validation_error(format!("{field} must not be empty")));
    }
    Ok(normalized.to_owned())
}

#[cfg(test)]
mod tests {
    use runx_contracts::JsonValue;

    use super::validate_credential_requirements;

    fn parse(value: &str) -> Result<JsonValue, serde_norway::Error> {
        serde_norway::from_str(value)
    }

    #[test]
    fn validates_named_api_key_requirement() -> Result<(), Box<dyn std::error::Error>> {
        let value = parse(
            r#"
nitrosend:
  provider: nitrosend
  audience: https://api.nitrosend.com
  auth:
    api_key:
      delivery:
        env: NITROSEND_API_KEY
"#,
        )?;
        let requirements = validate_credential_requirements(Some(&value))?;
        let requirement = requirements
            .get("nitrosend")
            .ok_or("named requirement is missing")?;
        assert_eq!(requirement.provider, "nitrosend");
        assert_eq!(
            requirement.deliveries.get("api_key").map(String::as_str),
            Some("NITROSEND_API_KEY")
        );
        Ok(())
    }

    #[test]
    fn rejects_reserved_delivery_environment() -> Result<(), Box<dyn std::error::Error>> {
        let value = parse(
            r#"
unsafe:
  provider: unsafe
  auth:
    api_key:
      delivery:
        env: RUNX_RECEIPT_SIGN_SEED
"#,
        )?;
        let error = match validate_credential_requirements(Some(&value)) {
            Ok(_) => return Err("reserved delivery env unexpectedly passed".into()),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("reserved Runx environment variable"));
        Ok(())
    }
}

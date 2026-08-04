use std::process::ExitCode;

use runx_contracts::{JsonObject, JsonValue};
use runx_runtime::{
    CredentialRequirement, SkillCredentialContext, SkillCredentialRequest,
    SkillCredentialResolution,
};

pub(super) fn inspect_context(context: &SkillCredentialContext) -> JsonValue {
    let requirement = &context.request.requirement;
    let ready = context.resolution.is_ready();
    let mut output = JsonObject::from([
        (
            "name".to_owned(),
            JsonValue::String(context.request.requirement_name.clone()),
        ),
        (
            "provider".to_owned(),
            JsonValue::String(requirement.provider.clone()),
        ),
        ("auth".to_owned(), auth_contract(requirement)),
        (
            "status".to_owned(),
            JsonValue::String(if ready { "ready" } else { "missing" }.to_owned()),
        ),
    ]);
    if let Some(audience) = requirement.audience.as_ref() {
        output.insert("audience".to_owned(), JsonValue::String(audience.clone()));
    }
    if let SkillCredentialResolution::Ready(resolved) = &context.resolution {
        output.insert(
            "source".to_owned(),
            JsonValue::String(resolved.source.as_str().to_owned()),
        );
        if let Some(profile) = resolved.profile.as_ref() {
            output.insert("profile".to_owned(), JsonValue::String(profile.clone()));
        }
        if let Some(descriptor) = resolved.descriptor.as_ref() {
            if let Some(audience) = descriptor.audience.as_ref() {
                output.insert("audience".to_owned(), JsonValue::String(audience.clone()));
            }
            output.insert(
                "auth_mode".to_owned(),
                JsonValue::String(descriptor.auth_mode.clone()),
            );
            output.insert(
                "delivery".to_owned(),
                JsonValue::Object(JsonObject::from([(
                    "env".to_owned(),
                    JsonValue::String(descriptor.env_var.clone()),
                )])),
            );
        }
    }
    if !ready {
        output.insert(
            "setup".to_owned(),
            JsonValue::Array(setup_commands(requirement)),
        );
    }
    JsonValue::Object(output)
}

pub(super) fn write_required(request: &SkillCredentialRequest, json: bool) -> ExitCode {
    let setup_commands = setup_commands(&request.requirement);
    if json {
        return write_required_json(request, setup_commands);
    }
    let setup = setup_commands
        .first()
        .and_then(JsonValue::as_str)
        .unwrap_or("runx credential set <provider> --from-stdin");
    let _ignored = crate::cli_io::write_stderr(&format!(
        "runx skill: credential '{}' for provider '{}' is required\nsetup: {setup}\n",
        request.requirement_name, request.requirement.provider
    ));
    ExitCode::from(2)
}

fn write_required_json(
    request: &SkillCredentialRequest,
    setup_commands: Vec<JsonValue>,
) -> ExitCode {
    let output = required_json(request, setup_commands);
    crate::cli_io::write_stdout_code(
        &format!(
            "{}\n",
            serde_json::to_string_pretty(&output).unwrap_or_else(|_| "{}".to_owned())
        ),
        2,
    )
}

fn required_json(request: &SkillCredentialRequest, setup_commands: Vec<JsonValue>) -> JsonValue {
    let requirement = JsonObject::from([
        (
            "name".to_owned(),
            JsonValue::String(request.requirement_name.clone()),
        ),
        (
            "provider".to_owned(),
            JsonValue::String(request.requirement.provider.clone()),
        ),
        (
            "auth_modes".to_owned(),
            strings(request.requirement.deliveries.keys().cloned()),
        ),
        ("scopes".to_owned(), strings(request.scopes.iter().cloned())),
        ("setup".to_owned(), JsonValue::Array(setup_commands)),
    ]);
    JsonValue::Object(JsonObject::from([
        (
            "status".to_owned(),
            JsonValue::String("needs_credential".to_owned()),
        ),
        (
            "requirements".to_owned(),
            JsonValue::Array(vec![JsonValue::Object(requirement)]),
        ),
    ]))
}

fn strings(values: impl Iterator<Item = String>) -> JsonValue {
    JsonValue::Array(values.map(JsonValue::String).collect())
}

fn auth_contract(requirement: &CredentialRequirement) -> JsonValue {
    JsonValue::Object(
        requirement
            .deliveries
            .iter()
            .map(|(auth_mode, env_var)| {
                (
                    auth_mode.clone(),
                    JsonValue::Object(JsonObject::from([(
                        "delivery".to_owned(),
                        JsonValue::Object(JsonObject::from([(
                            "env".to_owned(),
                            JsonValue::String(env_var.clone()),
                        )])),
                    )])),
                )
            })
            .collect(),
    )
}

fn setup_commands(requirement: &CredentialRequirement) -> Vec<JsonValue> {
    let multiple = requirement.deliveries.len() > 1;
    requirement
        .deliveries
        .keys()
        .map(|auth_mode| {
            JsonValue::String(if multiple || auth_mode != "api_key" {
                format!(
                    "runx credential set {} --auth-mode {} --from-stdin",
                    requirement.provider, auth_mode
                )
            } else {
                format!("runx credential set {} --from-stdin", requirement.provider)
            })
        })
        .collect()
}

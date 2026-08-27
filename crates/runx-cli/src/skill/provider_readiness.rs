use std::cell::OnceCell;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use runx_contracts::{JsonObject, JsonValue};
use runx_runtime::{ScopeGrantPolicy, missing_granted_scopes};

pub(super) fn inspect(
    inspection: &JsonObject,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Option<JsonValue> {
    let requirements = inspection
        .get("runner")
        .and_then(JsonValue::as_object)
        .and_then(|runner| runner.get("provider_requirements"))
        .and_then(JsonValue::as_array)?;
    if requirements.is_empty() {
        return None;
    }
    let sources = provider_readiness_sources(env, cwd);
    let (requirements, setup, status) = inspect_provider_requirements(requirements, &sources);
    Some(provider_readiness_value(requirements, setup, status))
}

struct ProviderReadinessSources<'a> {
    env: &'a BTreeMap<String, String>,
    cwd: &'a Path,
    explicit_grant: Option<&'a str>,
    explicit_scopes: Option<Vec<String>>,
    explicit_principal: bool,
    hosted_grants: OnceCell<Result<Vec<runx_runtime::HostedProviderGrant>, String>>,
}

fn provider_readiness_sources<'a>(
    env: &'a BTreeMap<String, String>,
    cwd: &'a Path,
) -> ProviderReadinessSources<'a> {
    let explicit_grant = env
        .get(runx_runtime::PROVIDER_PERMISSION_GRANT_ID_ENV)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let decoded_scopes = env
        .get(runx_runtime::PROVIDER_PERMISSION_GRANTED_SCOPES_ENV)
        .map(|value| runx_runtime::decode_provider_scopes_env(value));
    let explicit_scopes = decoded_scopes
        .as_ref()
        .and_then(|result| result.as_ref().ok())
        .cloned();
    let explicit_principal = env
        .get(runx_runtime::PROVIDER_PERMISSION_PRINCIPAL_REF_ENV)
        .is_some_and(|value| !value.trim().is_empty());
    let hosted_grants = OnceCell::new();
    if let Some(Err(error)) = decoded_scopes {
        let _ = hosted_grants.set(Err(error.to_string()));
    }
    ProviderReadinessSources {
        env,
        cwd,
        explicit_grant,
        explicit_scopes,
        explicit_principal,
        hosted_grants,
    }
}

impl ProviderReadinessSources<'_> {
    fn hosted_grants(&self) -> &Result<Vec<runx_runtime::HostedProviderGrant>, String> {
        self.hosted_grants
            .get_or_init(|| load_hosted_provider_grants(self.env, self.cwd))
    }
}

fn inspect_provider_requirements(
    requirements: &[JsonValue],
    sources: &ProviderReadinessSources<'_>,
) -> (Vec<JsonValue>, BTreeSet<String>, &'static str) {
    let mut inspected = Vec::new();
    let mut setup = BTreeSet::new();
    let mut overall = "ready";
    for requirement in requirements {
        let Some(requirement) = requirement.as_object() else {
            continue;
        };
        let provider = object_string(requirement, "provider").unwrap_or("unknown");
        let scopes = string_array(requirement, "scopes");
        let resolution = match (
            sources.explicit_grant,
            sources.explicit_scopes.as_ref(),
            sources.explicit_principal,
        ) {
            (Some(grant_id), Some(granted_scopes), true) => {
                inspect_explicit_provider_grant(grant_id, granted_scopes, &scopes)
            }
            _ => inspect_selected_provider_transport(requirement, sources, provider, &scopes),
        };
        overall = less_ready_status(overall, resolution.status);
        if resolution.status == "needs_provider_grant" && provider != "unknown" {
            setup.insert(connect_start_command(provider, &scopes));
        } else if resolution.status == "needs_provider_grant_selection" {
            setup.insert("runx connect list --json".to_owned());
        }
        let mut detail = requirement.clone();
        detail.insert(
            "status".to_owned(),
            JsonValue::String(resolution.status.to_owned()),
        );
        if let Some(grant_ref) = resolution.grant_ref {
            detail.insert("grant_ref".to_owned(), JsonValue::String(grant_ref));
        }
        for (field, value) in [
            ("transport", resolution.transport),
            ("principal_ref", resolution.principal_ref),
            ("target", resolution.target),
            ("host", resolution.host),
        ] {
            if let Some(value) = value {
                detail.insert(field.to_owned(), JsonValue::String(value));
            }
        }
        if let Some(reason) = resolution.reason {
            detail.insert("reason".to_owned(), JsonValue::String(reason));
        }
        inspected.push(JsonValue::Object(detail));
    }
    (inspected, setup, overall)
}

fn provider_readiness_value(
    requirements: Vec<JsonValue>,
    setup: BTreeSet<String>,
    status: &'static str,
) -> JsonValue {
    let mut provider = JsonObject::from([
        ("status".to_owned(), JsonValue::String(status.to_owned())),
        ("requirements".to_owned(), JsonValue::Array(requirements)),
    ]);
    if !setup.is_empty() {
        provider.insert(
            "setup".to_owned(),
            JsonValue::Array(setup.into_iter().map(JsonValue::String).collect()),
        );
    }
    JsonValue::Object(provider)
}

pub(super) fn append_text(output: &mut String, inspection: &JsonObject) {
    let Some(requirements) = inspection
        .get("provider")
        .and_then(JsonValue::as_object)
        .and_then(|provider| provider.get("requirements"))
        .and_then(JsonValue::as_array)
    else {
        return;
    };
    for requirement in requirements {
        let Some(requirement) = requirement.as_object() else {
            continue;
        };
        let provider = object_string(requirement, "provider").unwrap_or("unknown");
        let status = object_string(requirement, "status").unwrap_or("unknown");
        output.push_str(&format!("provider: {provider} ({status})\n"));
        if let Some(operation) = object_string(requirement, "operation") {
            output.push_str(&format!("operation: {operation}\n"));
        }
        let scopes = string_array(requirement, "scopes");
        if !scopes.is_empty() {
            output.push_str(&format!("scopes: {}\n", scopes.join(", ")));
        }
    }
    if let Some(setup) = inspection
        .get("provider")
        .and_then(JsonValue::as_object)
        .and_then(|provider| provider.get("setup"))
        .and_then(JsonValue::as_array)
    {
        for command in setup.iter().filter_map(JsonValue::as_str) {
            output.push_str(&format!("setup: {command}\n"));
        }
    }
}

fn connect_start_command(provider: &str, scopes: &[String]) -> String {
    let mut parts = vec![
        "runx".to_owned(),
        "connect".to_owned(),
        "start".to_owned(),
        crate::resume::shell_token(provider),
    ];
    for scope in scopes {
        parts.push("--scope".to_owned());
        parts.push(crate::resume::shell_token(scope));
    }
    parts.join(" ")
}

#[derive(Debug)]
struct ProviderReadinessResolution {
    status: &'static str,
    grant_ref: Option<String>,
    reason: Option<String>,
    transport: Option<String>,
    principal_ref: Option<String>,
    target: Option<String>,
    host: Option<String>,
}

fn inspect_selected_provider_transport(
    requirement: &JsonObject,
    sources: &ProviderReadinessSources<'_>,
    provider: &str,
    scopes: &[String],
) -> ProviderReadinessResolution {
    let preference = match runx_runtime::resolve_provider_transport_preference(
        sources.env,
        sources.cwd,
        provider,
    ) {
        Ok(preference) => preference,
        Err(error) => return provider_resolution("provider_readiness_unknown", None, Some(error)),
    };
    match preference {
        runx_runtime::ProviderTransportPreference::LocalGithub => {
            inspect_local_provider(requirement, sources, provider, scopes).unwrap_or_else(|error| {
                provider_resolution("needs_local_provider", None, Some(error))
            })
        }
        runx_runtime::ProviderTransportPreference::Hosted(grant) => inspect_hosted_result(
            sources.hosted_grants(),
            provider,
            scopes,
            grant.as_deref().or(sources.explicit_grant),
        ),
        runx_runtime::ProviderTransportPreference::Auto => {
            let local_error = match inspect_local_provider(requirement, sources, provider, scopes) {
                Ok(resolution) => return resolution,
                Err(error) => Some(error),
            };
            let mut hosted = inspect_hosted_result(
                sources.hosted_grants(),
                provider,
                scopes,
                sources.explicit_grant,
            );
            if hosted.status != "ready"
                && let Some(local_error) = local_error
            {
                hosted.reason = Some(match hosted.reason {
                    Some(hosted_error) => format!(
                        "local transport unavailable ({local_error}); hosted transport unavailable ({hosted_error})"
                    ),
                    None => format!("local transport unavailable ({local_error})"),
                });
            }
            hosted
        }
    }
}

fn inspect_local_provider(
    requirement: &JsonObject,
    sources: &ProviderReadinessSources<'_>,
    provider: &str,
    scopes: &[String],
) -> Result<ProviderReadinessResolution, String> {
    let operation = object_string(requirement, "operation")
        .ok_or_else(|| "provider operation is not statically preflightable".to_owned())?;
    let access = object_string(requirement, "access").unwrap_or("read");
    let target = object_string(requirement, "target")
        .filter(|target| !target.starts_with('$'))
        .unwrap_or(".");
    let Some(readiness) = runx_runtime::preflight_local_provider_transport(
        sources.env,
        sources.cwd,
        provider,
        operation,
        access,
        target,
        scopes,
    )?
    else {
        return Err(format!(
            "no compatible local {provider} driver is registered"
        ));
    };
    Ok(ProviderReadinessResolution {
        status: "ready",
        grant_ref: Some(readiness.grant_ref),
        reason: None,
        transport: Some(readiness.transport.to_owned()),
        principal_ref: Some(readiness.principal_ref),
        target: Some(readiness.target),
        host: Some(readiness.host),
    })
}

fn provider_resolution(
    status: &'static str,
    grant_ref: Option<String>,
    reason: Option<String>,
) -> ProviderReadinessResolution {
    ProviderReadinessResolution {
        status,
        grant_ref,
        reason,
        transport: None,
        principal_ref: None,
        target: None,
        host: None,
    }
}

fn load_hosted_provider_grants(
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<Vec<runx_runtime::HostedProviderGrant>, String> {
    let transport = runx_runtime::hosted_api_transport(
        runx_runtime::hosted_private_network_allowed(false, env),
    )
    .map_err(|error| error.to_string())?;
    let resolved = runx_runtime::HostedApiEnvironment::resolve(None, None, env, cwd)
        .map_err(|error| error.to_string())?;
    let authenticated = resolved
        .authenticate(&transport)
        .map_err(|error| error.to_string())?;
    runx_runtime::list_provider_grants(&transport, &authenticated)
        .map_err(|error| error.to_string())
}

fn inspect_hosted_result(
    grants: &Result<Vec<runx_runtime::HostedProviderGrant>, String>,
    provider: &str,
    scopes: &[String],
    explicit_grant: Option<&str>,
) -> ProviderReadinessResolution {
    match grants {
        Ok(grants) => inspect_hosted_provider_grant(grants, provider, scopes, explicit_grant),
        Err(error) => provider_resolution("provider_readiness_unknown", None, Some(error.clone())),
    }
}

fn inspect_explicit_provider_grant(
    grant_id: &str,
    granted_scopes: &[String],
    required_scopes: &[String],
) -> ProviderReadinessResolution {
    let missing =
        missing_granted_scopes(required_scopes, granted_scopes, ScopeGrantPolicy::Delegated);
    if missing.is_empty() {
        let mut resolution =
            provider_resolution("ready", Some(format!("runx:grant:{grant_id}")), None);
        resolution.transport = Some("runx_connect".to_owned());
        return resolution;
    }
    provider_resolution(
        "needs_provider_grant",
        Some(format!("runx:grant:{grant_id}")),
        Some(format!(
            "configured provider grant is missing scopes [{}]",
            missing.join(", ")
        )),
    )
}

fn inspect_hosted_provider_grant(
    grants: &[runx_runtime::HostedProviderGrant],
    provider: &str,
    required_scopes: &[String],
    explicit_grant: Option<&str>,
) -> ProviderReadinessResolution {
    let candidates = grants
        .iter()
        .filter(|grant| grant.status == "active")
        .filter(|grant| grant.provider == provider)
        .filter(|grant| explicit_grant.is_none_or(|expected| grant.grant_id == expected))
        .filter(|grant| {
            missing_granted_scopes(required_scopes, &grant.scopes, ScopeGrantPolicy::Delegated)
                .is_empty()
        })
        .collect::<Vec<_>>();
    match candidates.as_slice() {
        [grant] => {
            let mut resolution = provider_resolution(
                "ready",
                Some(format!("runx:grant:{}", grant.grant_id)),
                None,
            );
            resolution.transport = Some("runx_connect".to_owned());
            resolution
        }
        [] => provider_resolution(
            "needs_provider_grant",
            explicit_grant.map(|grant| format!("runx:grant:{grant}")),
            Some(format!(
                "no active Runx Connect grant authorizes {provider} scopes [{}]",
                required_scopes.join(", ")
            )),
        ),
        _ => provider_resolution(
            "needs_provider_grant_selection",
            None,
            Some(format!(
                "multiple active Runx Connect grants authorize {provider} scopes [{}]",
                required_scopes.join(", ")
            )),
        ),
    }
}

fn less_ready_status(current: &'static str, candidate: &'static str) -> &'static str {
    let rank = |status| match status {
        "ready" => 0,
        "provider_readiness_unknown" => 1,
        "needs_provider_grant" => 2,
        "needs_local_provider" | "needs_provider_grant_selection" => 3,
        _ => 4,
    };
    if rank(candidate) > rank(current) {
        candidate
    } else {
        current
    }
}

fn object_string<'a>(object: &'a JsonObject, key: &str) -> Option<&'a str> {
    object.get(key).and_then(JsonValue::as_str)
}

fn string_array(object: &JsonObject, key: &str) -> Vec<String> {
    object
        .get(key)
        .and_then(JsonValue::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;

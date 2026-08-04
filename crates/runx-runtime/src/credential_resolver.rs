use std::path::Path;

use crate::config::{
    RunxCredentialProfile, RunxCredentialsConfig, load_local_credential_secret,
    load_runx_config_file, resolve_runx_home_dir,
};
use crate::credentials::CredentialDelivery;
use crate::credentials::credential_audience_host;
use crate::execution::orchestrator::LocalCredentialDescriptor;
use crate::services::WorkspaceEnv;

mod manifest;
mod profile_store;
mod types;

pub use manifest::resolve_skill_credential_for_path;
pub use profile_store::{
    bind_project_credential, list_local_credential_profiles, load_project_bindings,
    remove_local_credential_profile, set_local_credential_profile,
};
pub use types::{
    CredentialBindingsFile, CredentialProfileSummary, ResolvedSkillCredential,
    SkillCredentialContext, SkillCredentialError, SkillCredentialRequest,
    SkillCredentialResolution, SkillCredentialSource,
};

pub fn resolve_skill_credential(
    request: &SkillCredentialRequest,
    workspace: &WorkspaceEnv,
) -> Result<SkillCredentialResolution, SkillCredentialError> {
    let config_dir = resolve_runx_home_dir(workspace.env(), workspace.cwd());
    let config = load_runx_config_file(&config_dir.join("config.json"))?;
    let credentials = config.credentials.unwrap_or_default();
    let bindings = load_project_bindings(workspace.cwd())?;

    if let Some(resolution) =
        resolve_selected_profile(request, &credentials, &bindings, &config_dir)?
    {
        return Ok(resolution);
    }
    if let Some(resolution) = resolve_hosted_credential(request, workspace)? {
        return Ok(resolution);
    }
    resolve_environment_credential(request, workspace)
}

fn resolve_selected_profile(
    request: &SkillCredentialRequest,
    credentials: &RunxCredentialsConfig,
    bindings: &CredentialBindingsFile,
    config_dir: &Path,
) -> Result<Option<SkillCredentialResolution>, SkillCredentialError> {
    let selected = request
        .explicit_profile
        .as_deref()
        .map(|profile| (profile, SkillCredentialSource::ExplicitProfile))
        .or_else(|| {
            project_profile(request, bindings)
                .map(|profile| (profile, SkillCredentialSource::ProjectBinding))
        })
        .or_else(|| {
            credentials
                .defaults
                .get(&request.requirement.provider)
                .map(|profile| (profile.as_str(), SkillCredentialSource::GlobalDefault))
        });
    selected
        .map(|(profile, source)| resolve_profile(request, credentials, config_dir, profile, source))
        .transpose()
}

fn resolve_hosted_credential(
    request: &SkillCredentialRequest,
    workspace: &WorkspaceEnv,
) -> Result<Option<SkillCredentialResolution>, SkillCredentialError> {
    if let Some(raw) = workspace
        .env()
        .get(crate::credentials::RUNX_HOSTED_CREDENTIAL_HANDLES_JSON_ENV)
        .filter(|value| !value.trim().is_empty())
    {
        let provider = CredentialDelivery::hosted_handles_provider(raw)?;
        if let Some(provider) = provider {
            if provider != request.requirement.provider {
                return Err(SkillCredentialError::HostedProviderMismatch {
                    expected: request.requirement.provider.clone(),
                    actual: provider,
                });
            }
            return Ok(Some(SkillCredentialResolution::Ready(Box::new(
                ResolvedSkillCredential {
                    source: SkillCredentialSource::HostedHandle,
                    profile: None,
                    descriptor: None,
                },
            ))));
        }
    }
    Ok(None)
}

fn resolve_environment_credential(
    request: &SkillCredentialRequest,
    workspace: &WorkspaceEnv,
) -> Result<SkillCredentialResolution, SkillCredentialError> {
    let environment_matches = request
        .requirement
        .deliveries
        .iter()
        .filter_map(|(auth_mode, env_var)| {
            workspace
                .env()
                .get(env_var)
                .filter(|value| !value.trim().is_empty())
                .map(|secret| (auth_mode, env_var, secret))
        })
        .collect::<Vec<_>>();
    if environment_matches.len() > 1 {
        return Err(SkillCredentialError::AmbiguousEnvironment {
            names: environment_matches
                .iter()
                .map(|(_, env_var, _)| env_var.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        });
    }
    if let Some((auth_mode, env_var, secret)) = environment_matches.first() {
        return Ok(SkillCredentialResolution::Ready(Box::new(
            ResolvedSkillCredential {
                source: SkillCredentialSource::Environment,
                profile: None,
                descriptor: Some(descriptor(
                    request,
                    None,
                    auth_mode,
                    env_var,
                    "environment",
                    request.requirement.audience.clone(),
                    (*secret).clone(),
                )),
            },
        )));
    }
    Ok(SkillCredentialResolution::Missing)
}

fn resolve_profile(
    request: &SkillCredentialRequest,
    credentials: &RunxCredentialsConfig,
    config_dir: &Path,
    profile_name: &str,
    source: SkillCredentialSource,
) -> Result<SkillCredentialResolution, SkillCredentialError> {
    let profile = credentials.profiles.get(profile_name).ok_or_else(|| {
        SkillCredentialError::ProfileNotFound {
            profile: profile_name.to_owned(),
        }
    })?;
    let delivery_env = validate_profile(request, profile_name, profile)?;
    let audience = resolve_profile_audience(request, profile_name, profile)?;
    let secret = load_local_credential_secret(config_dir, &profile.secret_ref)?;
    Ok(SkillCredentialResolution::Ready(Box::new(
        ResolvedSkillCredential {
            source,
            profile: Some(profile_name.to_owned()),
            descriptor: Some(descriptor(
                request,
                Some(profile_name),
                &profile.auth_mode,
                &delivery_env,
                profile_name,
                audience,
                secret,
            )),
        },
    )))
}

fn validate_profile(
    request: &SkillCredentialRequest,
    profile_name: &str,
    profile: &RunxCredentialProfile,
) -> Result<String, SkillCredentialError> {
    if profile.provider != request.requirement.provider {
        return Err(SkillCredentialError::ProviderMismatch {
            profile: profile_name.to_owned(),
            expected: request.requirement.provider.clone(),
            actual: profile.provider.clone(),
        });
    }
    let delivery_env = request
        .requirement
        .deliveries
        .get(&profile.auth_mode)
        .ok_or_else(|| SkillCredentialError::AuthModeMismatch {
            profile: profile_name.to_owned(),
            expected: request
                .requirement
                .deliveries
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(" or "),
            actual: profile.auth_mode.clone(),
        })?;
    Ok(delivery_env.clone())
}

fn resolve_profile_audience(
    request: &SkillCredentialRequest,
    profile_name: &str,
    profile: &RunxCredentialProfile,
) -> Result<Option<String>, SkillCredentialError> {
    match (
        request.requirement.audience.as_deref(),
        profile.audience.as_deref(),
    ) {
        (Some(required), Some(configured)) => {
            if credential_audience_host(required)? != credential_audience_host(configured)? {
                return Err(SkillCredentialError::AudienceMismatch {
                    profile: profile_name.to_owned(),
                    expected: required.to_owned(),
                    actual: configured.to_owned(),
                });
            }
            Ok(Some(required.to_owned()))
        }
        (Some(required), None) => Ok(Some(required.to_owned())),
        (None, Some(configured)) => Ok(Some(configured.to_owned())),
        (None, None) => Ok(None),
    }
}

fn descriptor(
    request: &SkillCredentialRequest,
    profile: Option<&str>,
    auth_mode: &str,
    env_var: &str,
    material_identity: &str,
    audience: Option<String>,
    secret: String,
) -> LocalCredentialDescriptor {
    LocalCredentialDescriptor {
        profile: profile.map(str::to_owned),
        provider: request.requirement.provider.clone(),
        audience,
        auth_mode: auth_mode.to_owned(),
        env_var: env_var.to_owned(),
        material_ref: format!("local:{}:{material_identity}", request.requirement.provider),
        scopes: request.scopes.clone(),
        secret,
    }
}

fn project_profile<'a>(
    request: &SkillCredentialRequest,
    bindings: &'a CredentialBindingsFile,
) -> Option<&'a str> {
    let skill_key = format!("skill:{}:{}", request.skill_name, request.requirement_name);
    bindings
        .bindings
        .get(&skill_key)
        .or_else(|| {
            bindings
                .bindings
                .get(&format!("provider:{}", request.requirement.provider))
        })
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;

    use runx_parser::CredentialRequirement;

    use super::{
        SkillCredentialRequest, SkillCredentialResolution, SkillCredentialSource,
        bind_project_credential, resolve_skill_credential, set_local_credential_profile,
    };
    use crate::WorkspaceEnv;

    fn request(profile: Option<&str>) -> SkillCredentialRequest {
        SkillCredentialRequest {
            skill_name: "support".to_owned(),
            requirement_name: "nitrosend".to_owned(),
            requirement: CredentialRequirement {
                provider: "nitrosend".to_owned(),
                audience: Some("https://api.nitrosend.com".to_owned()),
                deliveries: BTreeMap::from([(
                    "api_key".to_owned(),
                    "NITROSEND_API_KEY".to_owned(),
                )]),
            },
            scopes: vec!["nitrosend:read".to_owned()],
            explicit_profile: profile.map(str::to_owned),
        }
    }

    fn workspace(
        root: &std::path::Path,
        env: BTreeMap<String, String>,
    ) -> Result<WorkspaceEnv, crate::services::WorkspaceEnvError> {
        let mut env = env;
        env.insert(
            "RUNX_HOME".to_owned(),
            root.join("home").display().to_string(),
        );
        WorkspaceEnv::new(env, root.to_path_buf())
    }

    fn multi_auth_request(profile: Option<&str>) -> SkillCredentialRequest {
        SkillCredentialRequest {
            skill_name: "twitter".to_owned(),
            requirement_name: "twitter-read".to_owned(),
            requirement: CredentialRequirement {
                provider: "twitter".to_owned(),
                audience: Some("https://api.x.com".to_owned()),
                deliveries: BTreeMap::from([
                    ("bearer".to_owned(), "TWITTER_BEARER_TOKEN".to_owned()),
                    ("oauth1_user".to_owned(), "TWITTER_USER_AUTH".to_owned()),
                ]),
            },
            scopes: vec!["twitter:read".to_owned()],
            explicit_profile: profile.map(str::to_owned),
        }
    }

    fn dynamic_audience_request(profile: &str) -> SkillCredentialRequest {
        SkillCredentialRequest {
            skill_name: "n8n-handoff".to_owned(),
            requirement_name: "n8n".to_owned(),
            requirement: CredentialRequirement {
                provider: "n8n".to_owned(),
                audience: None,
                deliveries: BTreeMap::from([("bearer".to_owned(), "N8N_WEBHOOK_TOKEN".to_owned())]),
            },
            scopes: vec!["orchestrator.n8n.workflow.invoke".to_owned()],
            explicit_profile: Some(profile.to_owned()),
        }
    }

    #[test]
    fn environment_fallback_resolves_declared_name_without_leaking_debug()
    -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempfile::tempdir()?;
        let workspace = workspace(
            temp.path(),
            BTreeMap::from([(
                "NITROSEND_API_KEY".to_owned(),
                "environment-secret-sentinel".to_owned(),
            )]),
        )?;
        let resolved = resolve_skill_credential(&request(None), &workspace)?;
        let SkillCredentialResolution::Ready(resolved) = resolved else {
            return Err("credential should resolve".into());
        };
        assert_eq!(resolved.source, SkillCredentialSource::Environment);
        assert!(!format!("{resolved:?}").contains("environment-secret-sentinel"));
        Ok(())
    }

    #[test]
    fn project_binding_overrides_global_default_and_local_secret_is_encrypted()
    -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempfile::tempdir()?;
        fs::create_dir_all(temp.path().join(".runx"))?;
        let workspace = workspace(temp.path(), BTreeMap::new())?;
        set_local_credential_profile(
            &workspace,
            "default",
            "nitrosend",
            "api_key",
            None,
            "default-secret-sentinel",
        )?;
        set_local_credential_profile(
            &workspace,
            "account-one",
            "nitrosend",
            "api_key",
            None,
            "account-one-secret-sentinel",
        )?;
        bind_project_credential(&workspace, "provider:nitrosend", "default")?;
        let resolved = resolve_skill_credential(&request(None), &workspace)?;
        let SkillCredentialResolution::Ready(resolved) = resolved else {
            return Err("credential should resolve".into());
        };
        assert_eq!(resolved.source, SkillCredentialSource::ProjectBinding);
        assert_eq!(resolved.profile.as_deref(), Some("default"));
        let key_files = fs::read_dir(temp.path().join("home/keys"))?
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|value| value == "json")
            })
            .map(|entry| fs::read_to_string(entry.path()))
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        assert!(!key_files.contains("secret-sentinel"));
        Ok(())
    }

    #[test]
    fn stored_profile_auth_mode_selects_declared_delivery() -> Result<(), Box<dyn std::error::Error>>
    {
        let temp = tempfile::tempdir()?;
        let workspace = workspace(temp.path(), BTreeMap::new())?;
        set_local_credential_profile(
            &workspace,
            "twitter-app",
            "twitter",
            "bearer",
            None,
            "bearer-secret-sentinel",
        )?;
        let resolved =
            resolve_skill_credential(&multi_auth_request(Some("twitter-app")), &workspace)?;
        let SkillCredentialResolution::Ready(resolved) = resolved else {
            return Err("credential should resolve".into());
        };
        let descriptor = resolved.descriptor.ok_or("missing local descriptor")?;
        assert_eq!(descriptor.auth_mode, "bearer");
        assert_eq!(descriptor.env_var, "TWITTER_BEARER_TOKEN");
        Ok(())
    }

    #[test]
    fn stored_profile_can_bind_a_dynamic_provider_to_one_https_audience()
    -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempfile::tempdir()?;
        let workspace = workspace(temp.path(), BTreeMap::new())?;
        set_local_credential_profile(
            &workspace,
            "n8n-workflow",
            "n8n",
            "bearer",
            Some("https://n8n.example.com"),
            "n8n-secret-sentinel",
        )?;
        set_local_credential_profile(
            &workspace,
            "n8n-workflow",
            "n8n",
            "bearer",
            None,
            "rotated-n8n-secret-sentinel",
        )?;

        let resolved =
            resolve_skill_credential(&dynamic_audience_request("n8n-workflow"), &workspace)?;
        let SkillCredentialResolution::Ready(resolved) = resolved else {
            return Err("credential should resolve".into());
        };
        assert_eq!(
            resolved
                .descriptor
                .ok_or("missing local descriptor")?
                .audience
                .as_deref(),
            Some("https://n8n.example.com")
        );
        Ok(())
    }

    #[test]
    fn profile_audience_cannot_override_a_skill_audience() -> Result<(), Box<dyn std::error::Error>>
    {
        let temp = tempfile::tempdir()?;
        let workspace = workspace(temp.path(), BTreeMap::new())?;
        set_local_credential_profile(
            &workspace,
            "wrong-host",
            "nitrosend",
            "api_key",
            Some("https://attacker.example"),
            "profile-secret-sentinel",
        )?;

        let error = match resolve_skill_credential(&request(Some("wrong-host")), &workspace) {
            Ok(_) => return Err("profile audience unexpectedly widened the skill audience".into()),
            Err(error) => error,
        };
        assert!(
            error
                .to_string()
                .contains("does not satisfy required audience")
        );
        Ok(())
    }

    #[test]
    fn multiple_environment_auth_modes_fail_closed() -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempfile::tempdir()?;
        let workspace = workspace(
            temp.path(),
            BTreeMap::from([
                ("TWITTER_BEARER_TOKEN".to_owned(), "bearer".to_owned()),
                ("TWITTER_USER_AUTH".to_owned(), "oauth".to_owned()),
            ]),
        )?;
        let error = match resolve_skill_credential(&multi_auth_request(None), &workspace) {
            Ok(_) => return Err("ambiguous ambient credentials unexpectedly resolved".into()),
            Err(error) => error,
        };
        assert!(error.to_string().contains("multiple declared credential"));
        Ok(())
    }
}

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::config::{
    RunxCredentialProfile, load_runx_config_file, remove_local_credential_secret,
    resolve_runx_home_dir, store_local_credential_secret, write_runx_config_file,
};
use crate::credentials::credential_audience_host;
use crate::services::WorkspaceEnv;

use super::{CredentialBindingsFile, CredentialProfileSummary, SkillCredentialError};

const PROJECT_BINDINGS_PATH: &str = ".runx/credentials.json";

pub fn set_local_credential_profile(
    workspace: &WorkspaceEnv,
    name: &str,
    provider: &str,
    auth_mode: &str,
    audience: Option<&str>,
    secret: &str,
) -> Result<CredentialProfileSummary, SkillCredentialError> {
    let name = required(name, SkillCredentialError::EmptyProfileName)?;
    let provider = required(provider, SkillCredentialError::EmptyProvider)?;
    let auth_mode = required(auth_mode, SkillCredentialError::EmptyAuthMode)?;
    if secret.trim().is_empty() {
        return Err(SkillCredentialError::EmptySecret);
    }
    let requested_audience = audience
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            credential_audience_host(value)?;
            Ok::<_, SkillCredentialError>(value.to_owned())
        })
        .transpose()?;
    let config_dir = resolve_runx_home_dir(workspace.env(), workspace.cwd());
    let config_path = config_dir.join("config.json");
    let mut config = load_runx_config_file(&config_path)?;
    let credentials = config.credentials.get_or_insert_with(Default::default);
    let prior = credentials.profiles.get(name);
    let prior_ref = prior.map(|profile| profile.secret_ref.clone());
    let audience =
        requested_audience.or_else(|| prior.and_then(|profile| profile.audience.clone()));
    let secret_ref = store_local_credential_secret(&config_dir, secret)?;
    credentials.profiles.insert(
        name.to_owned(),
        RunxCredentialProfile {
            provider: provider.to_owned(),
            auth_mode: auth_mode.to_owned(),
            audience: audience.clone(),
            secret_ref,
        },
    );
    credentials
        .defaults
        .insert(provider.to_owned(), name.to_owned());
    write_runx_config_file(&config_path, &config)?;
    if let Some(prior_ref) = prior_ref {
        remove_local_credential_secret(&config_dir, &prior_ref)?;
    }
    Ok(CredentialProfileSummary {
        name: name.to_owned(),
        provider: provider.to_owned(),
        auth_mode: auth_mode.to_owned(),
        audience,
        is_default: true,
    })
}

pub fn list_local_credential_profiles(
    workspace: &WorkspaceEnv,
) -> Result<Vec<CredentialProfileSummary>, SkillCredentialError> {
    let config_dir = resolve_runx_home_dir(workspace.env(), workspace.cwd());
    let config = load_runx_config_file(&config_dir.join("config.json"))?;
    let credentials = config.credentials.unwrap_or_default();
    Ok(credentials
        .profiles
        .into_iter()
        .map(|(name, profile)| CredentialProfileSummary {
            is_default: credentials.defaults.get(&profile.provider) == Some(&name),
            name,
            provider: profile.provider,
            auth_mode: profile.auth_mode,
            audience: profile.audience,
        })
        .collect())
}

pub fn remove_local_credential_profile(
    workspace: &WorkspaceEnv,
    name: &str,
) -> Result<bool, SkillCredentialError> {
    let name = required(name, SkillCredentialError::EmptyProfileName)?;
    let config_dir = resolve_runx_home_dir(workspace.env(), workspace.cwd());
    let config_path = config_dir.join("config.json");
    let mut config = load_runx_config_file(&config_path)?;
    let Some(credentials) = config.credentials.as_mut() else {
        return Ok(false);
    };
    let Some(profile) = credentials.profiles.remove(name) else {
        return Ok(false);
    };
    credentials.defaults.retain(|_, profile| profile != name);
    write_runx_config_file(&config_path, &config)?;
    remove_local_credential_secret(&config_dir, &profile.secret_ref)?;
    Ok(true)
}

pub fn bind_project_credential(
    workspace: &WorkspaceEnv,
    target: &str,
    profile: &str,
) -> Result<PathBuf, SkillCredentialError> {
    let target = required(target, SkillCredentialError::EmptyBindingTarget)?;
    let profile = required(profile, SkillCredentialError::EmptyProfileName)?;
    let config_dir = resolve_runx_home_dir(workspace.env(), workspace.cwd());
    let config = load_runx_config_file(&config_dir.join("config.json"))?;
    if !config
        .credentials
        .unwrap_or_default()
        .profiles
        .contains_key(profile)
    {
        return Err(SkillCredentialError::ProfileNotFound {
            profile: profile.to_owned(),
        });
    }
    let path = workspace.cwd().join(PROJECT_BINDINGS_PATH);
    let mut bindings = load_project_bindings(workspace.cwd())?;
    bindings
        .bindings
        .insert(target.to_owned(), profile.to_owned());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let contents = serde_json::to_string_pretty(&bindings).map_err(|error| {
        SkillCredentialError::InvalidBindings {
            path: path.clone(),
            message: error.to_string(),
        }
    })?;
    fs::write(&path, format!("{contents}\n"))?;
    Ok(path)
}

pub fn load_project_bindings(
    workspace_root: &Path,
) -> Result<CredentialBindingsFile, SkillCredentialError> {
    let path = workspace_root.join(PROJECT_BINDINGS_PATH);
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(CredentialBindingsFile {
                bindings: BTreeMap::new(),
            });
        }
        Err(error) => return Err(SkillCredentialError::Io(error)),
    };
    serde_json::from_str(&contents).map_err(|error| SkillCredentialError::InvalidBindings {
        path,
        message: error.to_string(),
    })
}

fn required(value: &str, error: SkillCredentialError) -> Result<&str, SkillCredentialError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(error);
    }
    Ok(value)
}

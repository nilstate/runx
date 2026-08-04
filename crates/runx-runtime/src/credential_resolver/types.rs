use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;

use runx_parser::CredentialRequirement;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::config::ConfigError;
use crate::credentials::CredentialDelivery;
use crate::execution::orchestrator::LocalCredentialDescriptor;
use crate::services::WorkspaceEnv;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillCredentialRequest {
    pub skill_name: String,
    pub requirement_name: String,
    pub requirement: CredentialRequirement,
    pub scopes: Vec<String>,
    pub explicit_profile: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillCredentialContext {
    pub request: SkillCredentialRequest,
    pub resolution: SkillCredentialResolution,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillCredentialSource {
    ExplicitProfile,
    ProjectBinding,
    GlobalDefault,
    HostedHandle,
    Environment,
}

impl SkillCredentialSource {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ExplicitProfile => "explicit_profile",
            Self::ProjectBinding => "project_binding",
            Self::GlobalDefault => "global_default",
            Self::HostedHandle => "hosted_handle",
            Self::Environment => "environment",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedSkillCredential {
    pub source: SkillCredentialSource,
    pub profile: Option<String>,
    pub descriptor: Option<LocalCredentialDescriptor>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SkillCredentialResolution {
    Ready(Box<ResolvedSkillCredential>),
    Missing,
}

impl SkillCredentialResolution {
    #[must_use]
    pub const fn is_ready(&self) -> bool {
        matches!(self, Self::Ready(_))
    }

    #[must_use]
    pub fn descriptor(&self) -> Option<&LocalCredentialDescriptor> {
        match self {
            Self::Ready(resolved) => resolved.descriptor.as_ref(),
            Self::Missing => None,
        }
    }

    pub fn delivery(
        &self,
        workspace: &WorkspaceEnv,
    ) -> Result<CredentialDelivery, SkillCredentialError> {
        match self {
            Self::Ready(resolved) => match resolved.descriptor.as_ref() {
                Some(descriptor) => Ok(CredentialDelivery::from_local_descriptor(
                    descriptor.provider.clone(),
                    descriptor.auth_mode.clone(),
                    descriptor.env_var.clone(),
                    descriptor.material_ref.clone(),
                    descriptor.scopes.clone(),
                    descriptor.secret.clone(),
                )?
                .bind_audience(descriptor.audience.as_deref())?),
                None => {
                    let raw = workspace
                        .env()
                        .get(crate::credentials::RUNX_HOSTED_CREDENTIAL_HANDLES_JSON_ENV)
                        .ok_or(SkillCredentialError::MissingHostedHandles)?;
                    Ok(CredentialDelivery::from_hosted_handles_json(raw)?)
                }
            },
            Self::Missing => Err(SkillCredentialError::MissingCredential),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialBindingsFile {
    #[serde(default)]
    pub bindings: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CredentialProfileSummary {
    pub name: String,
    pub provider: String,
    pub auth_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audience: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Error)]
pub enum SkillCredentialError {
    #[error("credential profile '{profile}' is not configured")]
    ProfileNotFound { profile: String },
    #[error(
        "credential profile '{profile}' provider '{actual}' does not satisfy required provider '{expected}'"
    )]
    ProviderMismatch {
        profile: String,
        expected: String,
        actual: String,
    },
    #[error(
        "credential profile '{profile}' auth mode '{actual}' does not satisfy required auth mode '{expected}'"
    )]
    AuthModeMismatch {
        profile: String,
        expected: String,
        actual: String,
    },
    #[error(
        "credential profile '{profile}' audience '{actual}' does not satisfy required audience '{expected}'"
    )]
    AudienceMismatch {
        profile: String,
        expected: String,
        actual: String,
    },
    #[error("multiple declared credential environment values are set: {names}")]
    AmbiguousEnvironment { names: String },
    #[error(
        "hosted credential provider '{actual}' does not satisfy required provider '{expected}'"
    )]
    HostedProviderMismatch { expected: String, actual: String },
    #[error("credential profile name must not be empty")]
    EmptyProfileName,
    #[error("credential provider must not be empty")]
    EmptyProvider,
    #[error("credential auth mode must not be empty")]
    EmptyAuthMode,
    #[error("credential secret must not be empty")]
    EmptySecret,
    #[error("required credential is not configured")]
    MissingCredential,
    #[error("hosted credential resolution is missing its pre-resolved handle set")]
    MissingHostedHandles,
    #[error("credential binding target must not be empty")]
    EmptyBindingTarget,
    #[error("credential bindings file {path} is invalid: {message}")]
    InvalidBindings { path: PathBuf, message: String },
    #[error("invalid skill credential declaration: {0}")]
    InvalidSkill(String),
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Delivery(#[from] crate::credentials::CredentialDeliveryError),
    #[error(transparent)]
    Io(#[from] io::Error),
}

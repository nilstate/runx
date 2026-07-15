use std::collections::BTreeMap;
use std::path::Path;

use runx_runtime::registry::{
    DefaultRuntimeHttpTransport, HttpMethod, HttpRequest, RuntimeHttpError, RuntimeHttpHeader,
    Transport,
};
use runx_runtime::{
    ConfigKey, load_local_public_api_token, load_runx_config_file, resolve_runx_home_dir,
    update_runx_config_value, write_runx_config_file,
};
use serde::Deserialize;

mod error;

pub(crate) use error::{ApiEnvironmentError, parse_error};

pub(crate) const DEFAULT_BASE_URL: &str = "https://api.runx.ai";
const BASE_URL_ENV: &str = "RUNX_PUBLIC_API_BASE_URL";
const TOKEN_ENV: &str = "RUNX_PUBLIC_API_TOKEN";
const PRIVATE_NETWORK_ENV: &str = "RUNX_PUBLIC_API_ALLOW_PRIVATE_NETWORK";

/// One resolved hosted environment for every native CLI command. Base URL,
/// credential and expected principal are selected together so a stored token
/// can never silently cross environments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ApiEnvironment {
    base_url: String,
    token: Option<String>,
    expected_principal_id: Option<String>,
    stored_credential_environment_mismatch: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AuthenticatedApiEnvironment {
    base_url: String,
    token: String,
    principal_id: String,
}

impl ApiEnvironment {
    pub(crate) fn resolve(
        explicit_base_url: Option<&str>,
        explicit_token: Option<&str>,
        env: &BTreeMap<String, String>,
        cwd: &Path,
    ) -> Result<Self, ApiEnvironmentError> {
        Self::resolve_inner(explicit_base_url, explicit_token, env, cwd, true)
    }

    pub(crate) fn resolve_unauthenticated(
        explicit_base_url: Option<&str>,
        env: &BTreeMap<String, String>,
        cwd: &Path,
    ) -> Result<Self, ApiEnvironmentError> {
        Self::resolve_inner(explicit_base_url, None, env, cwd, false)
    }

    fn resolve_inner(
        explicit_base_url: Option<&str>,
        explicit_token: Option<&str>,
        env: &BTreeMap<String, String>,
        cwd: &Path,
        include_credentials: bool,
    ) -> Result<Self, ApiEnvironmentError> {
        let config_dir = resolve_runx_home_dir(env, cwd);
        let config = load_runx_config_file(&config_dir.join("config.json"))?;
        let public = config.public.unwrap_or_default();
        let stored_base_url = public
            .api_base_url
            .as_deref()
            .and_then(normalize_non_empty_base_url)
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let base_url = explicit_base_url
            .and_then(normalize_non_empty_base_url)
            .or_else(|| {
                env.get(BASE_URL_ENV)
                    .and_then(|value| normalize_non_empty_base_url(value))
            })
            .unwrap_or_else(|| stored_base_url.clone());
        let direct_token = include_credentials
            .then(|| {
                non_empty(explicit_token)
                    .or_else(|| non_empty(env.get(TOKEN_ENV).map(String::as_str)))
            })
            .flatten();
        let stored_token_allowed = base_url == stored_base_url;
        let stored_token = if include_credentials && direct_token.is_none() && stored_token_allowed
        {
            public
                .api_token_ref
                .as_deref()
                .map(|token_ref| load_local_public_api_token(&config_dir, token_ref))
                .transpose()?
                .and_then(|token| non_empty(Some(&token)))
        } else {
            None
        };
        let using_stored_token = direct_token.is_none() && stored_token.is_some();
        let stored_credential_environment_mismatch = include_credentials
            && direct_token.is_none()
            && public.api_token_ref.is_some()
            && !stored_token_allowed;
        Ok(Self {
            base_url,
            token: direct_token.or(stored_token),
            expected_principal_id: using_stored_token.then_some(public.principal_id).flatten(),
            stored_credential_environment_mismatch,
        })
    }

    #[must_use]
    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn require_token(&self) -> Result<&str, ApiEnvironmentError> {
        if let Some(token) = self.token.as_deref() {
            return Ok(token);
        }
        if self.stored_credential_environment_mismatch {
            return Err(ApiEnvironmentError::StoredCredentialEnvironmentMismatch {
                base_url: self.base_url.clone(),
            });
        }
        Err(ApiEnvironmentError::MissingToken)
    }

    pub(crate) fn authenticate<T: Transport>(
        &self,
        transport: &T,
    ) -> Result<AuthenticatedApiEnvironment, ApiEnvironmentError> {
        let token = self.require_token()?;
        let response = transport.send(HttpRequest {
            method: HttpMethod::Get,
            url: format!("{}/v1/me", self.base_url),
            headers: vec![RuntimeHttpHeader::new(
                "authorization",
                format!("Bearer {token}"),
            )],
            body: None,
        })?;
        if !(200..=299).contains(&response.status) {
            return Err(ApiEnvironmentError::AuthenticationStatus {
                status: response.status,
                detail: parse_error(&response.body)
                    .map(|error| error.detail)
                    .unwrap_or(response.body),
            });
        }
        let profile = serde_json::from_str::<PrincipalProfile>(&response.body)
            .map_err(|error| ApiEnvironmentError::InvalidPrincipal(error.to_string()))?;
        let principal_id = profile.principal.principal_id.trim();
        if profile.status != "success" || principal_id.is_empty() {
            return Err(ApiEnvironmentError::InvalidPrincipal(
                "response did not identify a successful principal".to_owned(),
            ));
        }
        if let Some(expected) = self.expected_principal_id.as_deref()
            && expected != principal_id
        {
            return Err(ApiEnvironmentError::PrincipalMismatch {
                expected: expected.to_owned(),
                actual: principal_id.to_owned(),
            });
        }
        Ok(AuthenticatedApiEnvironment {
            base_url: self.base_url.clone(),
            token: token.to_owned(),
            principal_id: principal_id.to_owned(),
        })
    }
}

impl AuthenticatedApiEnvironment {
    #[must_use]
    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    #[must_use]
    pub(crate) fn token(&self) -> &str {
        &self.token
    }

    #[must_use]
    pub(crate) fn principal_id(&self) -> &str {
        &self.principal_id
    }
}

pub(crate) fn store_authenticated_environment(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    base_url: &str,
    principal_id: &str,
    token: &str,
) -> Result<(), ApiEnvironmentError> {
    let config_dir = resolve_runx_home_dir(env, cwd);
    let config_path = config_dir.join("config.json");
    let config = load_runx_config_file(&config_path)?;
    let mut next = update_runx_config_value(config, ConfigKey::PublicApiToken, token, &config_dir)?;
    let public = next.public.get_or_insert_default();
    public.api_base_url =
        Some(normalize_non_empty_base_url(base_url).unwrap_or_else(|| DEFAULT_BASE_URL.to_owned()));
    public.principal_id = non_empty(Some(principal_id));
    write_runx_config_file(&config_path, &next)?;
    Ok(())
}

pub(crate) fn private_network_allowed(explicit: bool, env: &BTreeMap<String, String>) -> bool {
    explicit
        || env
            .get(PRIVATE_NETWORK_ENV)
            .is_some_and(|value| truthy_env(value))
}

pub(crate) fn transport(
    allow_private_network: bool,
) -> Result<DefaultRuntimeHttpTransport, RuntimeHttpError> {
    if allow_private_network {
        return DefaultRuntimeHttpTransport::with_private_network_access();
    }
    DefaultRuntimeHttpTransport::new()
}

fn normalize_non_empty_base_url(value: &str) -> Option<String> {
    let normalized = value.trim().trim_end_matches('/');
    (!normalized.is_empty()).then(|| normalized.to_owned())
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn truthy_env(value: &str) -> bool {
    matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES")
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct PrincipalProfile {
    status: String,
    principal: PrincipalIdentity,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct PrincipalIdentity {
    principal_id: String,
}

use serde::{Deserialize, Serialize};

use super::HostedApiOperationError;
use super::request::{non_empty, path_identifier, send_json};
use crate::http::{HttpMethod, RuntimeHttpTransport};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct HostedLoginStartResponse {
    pub status: String,
    pub session_id: String,
    pub login_token: String,
    #[serde(default)]
    pub authorization_url: Option<String>,
    #[serde(default)]
    pub poll_after_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct HostedLoginCompleteResponse {
    pub status: String,
    pub session_id: String,
    #[serde(default)]
    pub principal_id: Option<String>,
    #[serde(default)]
    pub credential_id: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub poll_after_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct HostedProviderTokenLoginResponse {
    pub status: String,
    pub principal_id: String,
    pub credential_id: String,
    pub token: String,
}

#[derive(Serialize)]
struct LoginStartRequest<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    purpose: Option<&'a str>,
}

#[derive(Serialize)]
struct LoginCompleteRequest<'a> {
    login_token: &'a str,
}

pub fn start_hosted_login(
    transport: &impl RuntimeHttpTransport,
    base_url: &str,
    provider: Option<&str>,
    purpose: Option<&str>,
) -> Result<HostedLoginStartResponse, HostedApiOperationError> {
    let body = serde_json::to_string(&LoginStartRequest {
        provider: non_empty(provider),
        purpose: non_empty(purpose),
    })
    .map_err(|error| invalid_request("login start request", error))?;
    send_json(
        transport,
        base_url,
        "login start",
        HttpMethod::Post,
        "/v1/login/sessions",
        None,
        Some(body),
    )
}

pub fn complete_hosted_login(
    transport: &impl RuntimeHttpTransport,
    base_url: &str,
    session_id: &str,
    login_token: &str,
) -> Result<HostedLoginCompleteResponse, HostedApiOperationError> {
    let body = serde_json::to_string(&LoginCompleteRequest { login_token })
        .map_err(|error| invalid_request("login completion request", error))?;
    send_json(
        transport,
        base_url,
        "login completion",
        HttpMethod::Post,
        &format!(
            "/v1/login/sessions/{}/complete",
            path_identifier("login completion request", "session id", session_id)?
        ),
        None,
        Some(body),
    )
}

pub fn exchange_hosted_provider_token(
    transport: &impl RuntimeHttpTransport,
    base_url: &str,
    provider: &str,
    purpose: Option<&str>,
    provider_token: &str,
) -> Result<HostedProviderTokenLoginResponse, HostedApiOperationError> {
    let body = serde_json::to_string(&LoginStartRequest {
        provider: Some(provider),
        purpose: non_empty(purpose),
    })
    .map_err(|error| invalid_request("provider-token login request", error))?;
    send_json(
        transport,
        base_url,
        "provider-token login",
        HttpMethod::Post,
        "/v1/login/provider-token",
        Some(provider_token),
        Some(body),
    )
}

fn invalid_request(operation: &'static str, error: serde_json::Error) -> HostedApiOperationError {
    HostedApiOperationError::InvalidRequest {
        operation,
        message: error.to_string(),
    }
}

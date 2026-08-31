use serde::Serialize;
use serde_json::Value;

use super::request::{non_empty, path_identifier, send_json};
use super::{AuthenticatedHostedApiEnvironment, HostedApiOperationError};
use crate::http::{HttpMethod, RuntimeHttpTransport};

pub enum HostedConnectAction<'a> {
    List,
    Status {
        session_id: &'a str,
    },
    Revoke {
        grant_id: &'a str,
    },
    Start(HostedConnectStart<'a>),
    SubmitCredentials {
        session_id: &'a str,
        credentials: &'a Value,
    },
}

#[derive(Clone, Copy, Debug)]
pub struct HostedConnectStart<'a> {
    pub provider: &'a str,
    pub scopes: &'a [String],
    pub scope_family: Option<&'a str>,
    pub authority_kind: Option<&'a str>,
    pub target_repo: Option<&'a str>,
    pub target_locator: Option<&'a str>,
    pub binding_id: Option<&'a str>,
    pub credential_grant_id: Option<&'a str>,
}

#[derive(Serialize)]
struct ConnectStartRequest<'a> {
    provider: &'a str,
    scopes: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    scope_family: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    authority_kind: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_repo: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_locator: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    binding_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_grant_id: Option<&'a str>,
}

#[derive(Serialize)]
struct ConnectCredentialsRequest<'a> {
    credentials: &'a Value,
}

pub fn execute_hosted_connect(
    transport: &(impl RuntimeHttpTransport + ?Sized),
    environment: &AuthenticatedHostedApiEnvironment,
    action: HostedConnectAction<'_>,
) -> Result<Value, HostedApiOperationError> {
    let (method, path, body) = match action {
        HostedConnectAction::List => (HttpMethod::Get, "/v1/grants".to_owned(), None),
        HostedConnectAction::Status { session_id } => (
            HttpMethod::Get,
            format!(
                "/v1/connect/sessions/{}",
                path_identifier("connect request", "session id", session_id)?
            ),
            None,
        ),
        HostedConnectAction::Revoke { grant_id } => (
            HttpMethod::Delete,
            format!(
                "/v1/grants/{}",
                path_identifier("connect request", "grant id", grant_id)?
            ),
            None,
        ),
        HostedConnectAction::Start(start) => {
            let body = serde_json::to_string(&ConnectStartRequest {
                provider: start.provider,
                scopes: start.scopes,
                scope_family: non_empty(start.scope_family),
                authority_kind: non_empty(start.authority_kind),
                target_repo: non_empty(start.target_repo),
                target_locator: non_empty(start.target_locator),
                binding_id: non_empty(start.binding_id),
                credential_grant_id: non_empty(start.credential_grant_id),
            })
            .map_err(|error| HostedApiOperationError::InvalidRequest {
                operation: "connect start request",
                message: error.to_string(),
            })?;
            (
                HttpMethod::Post,
                "/v1/connect/sessions".to_owned(),
                Some(body),
            )
        }
        HostedConnectAction::SubmitCredentials {
            session_id,
            credentials,
        } => {
            let body = serde_json::to_string(&ConnectCredentialsRequest { credentials }).map_err(
                |error| HostedApiOperationError::InvalidRequest {
                    operation: "connect credential request",
                    message: error.to_string(),
                },
            )?;
            (
                HttpMethod::Post,
                format!(
                    "/v1/connect/sessions/{}/credentials",
                    path_identifier("connect request", "session id", session_id)?
                ),
                Some(body),
            )
        }
    };
    send_json(
        transport,
        environment.base_url(),
        "connect",
        method,
        &path,
        Some(environment.token()),
        body,
    )
}

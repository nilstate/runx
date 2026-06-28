use std::io::{Read, Write};
use std::net::TcpStream;

use serde::{Deserialize, Serialize};

use super::super::document::EffectFamilyState;
use super::super::{
    EffectStateError, HOSTED_TRANSACTIONAL_BACKEND_KIND, RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV,
};
use super::HostedEffectStateStore;

#[derive(Clone, Debug)]
pub(super) struct HostedEffectStateEndpoint {
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) base_path: String,
}

#[derive(Debug)]
pub(super) enum HostedCommitOutcome {
    Committed(HostedFamilyResponse),
    Conflict(HostedFamilyResponse),
}

#[derive(Debug, Deserialize)]
pub(super) struct HostedFamilyResponse {
    pub(super) state: EffectFamilyState,
    pub(super) version: u64,
}

#[derive(Serialize)]
struct HostedFamilyCommitRequest<'a> {
    expected_version: u64,
    state: &'a EffectFamilyState,
}

impl HostedEffectStateStore {
    pub(super) fn refresh_family(&mut self, family: &str) -> Result<(), EffectStateError> {
        self.ensure_family_allowed(family)?;
        let response = self.request_family("GET", family, None)?;
        self.state
            .families
            .insert(family.to_owned(), response.state);
        self.versions.insert(family.to_owned(), response.version);
        Ok(())
    }

    pub(super) fn commit_family(
        &self,
        family: &str,
        expected_version: u64,
        state: &EffectFamilyState,
    ) -> Result<HostedCommitOutcome, EffectStateError> {
        let body = serde_json::to_string(&HostedFamilyCommitRequest {
            expected_version,
            state,
        })
        .map_err(|source| EffectStateError::HostedBackendTransport {
            message: format!("failed to serialize hosted effect-state commit: {source}"),
        })?;
        match self.request_family_with_status("PUT", family, Some(&body))? {
            (200, response) => Ok(HostedCommitOutcome::Committed(response)),
            (409, response) => Ok(HostedCommitOutcome::Conflict(response)),
            (status, _) => Err(EffectStateError::HostedBackendTransport {
                message: format!("unexpected hosted effect-state status {status}"),
            }),
        }
    }

    fn request_family(
        &self,
        method: &str,
        family: &str,
        body: Option<&str>,
    ) -> Result<HostedFamilyResponse, EffectStateError> {
        let (status, response) = self.request_family_with_status(method, family, body)?;
        if status == 200 {
            Ok(response)
        } else {
            Err(EffectStateError::HostedBackendTransport {
                message: format!("unexpected hosted effect-state status {status}"),
            })
        }
    }

    fn request_family_with_status(
        &self,
        method: &str,
        family: &str,
        body: Option<&str>,
    ) -> Result<(u16, HostedFamilyResponse), EffectStateError> {
        self.ensure_family_allowed(family)?;
        let token = self
            .backend
            .bearer_token
            .as_deref()
            .ok_or_else(hosted_transport_missing)?;
        let path = format!("{}/families/{family}", self.endpoint.base_path);
        let body = body.unwrap_or("");
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.endpoint.host,
            body.len(),
        );
        let mut stream = TcpStream::connect((self.endpoint.host.as_str(), self.endpoint.port))
            .map_err(|source| EffectStateError::HostedBackendTransport {
                message: format!("failed to connect to hosted effect-state transport: {source}"),
            })?;
        stream.write_all(request.as_bytes()).map_err(|source| {
            EffectStateError::HostedBackendTransport {
                message: format!("failed to write hosted effect-state request: {source}"),
            }
        })?;
        let mut response = String::new();
        stream.read_to_string(&mut response).map_err(|source| {
            EffectStateError::HostedBackendTransport {
                message: format!("failed to read hosted effect-state response: {source}"),
            }
        })?;
        parse_hosted_response(&response)
    }

    pub(super) fn ensure_family_allowed(&self, family: &str) -> Result<(), EffectStateError> {
        if !hosted_family_name_is_safe(family) {
            return Err(EffectStateError::HostedBackendInvalid {
                message: format!("invalid hosted effect-state family {family}"),
            });
        }
        if self
            .backend
            .allowed_families
            .iter()
            .any(|allowed| allowed == family)
        {
            return Ok(());
        }
        Err(EffectStateError::HostedBackendInvalid {
            message: format!("hosted effect-state family {family} is not allowed"),
        })
    }
}

impl HostedEffectStateEndpoint {
    pub(super) fn parse(raw: &str) -> Result<Self, EffectStateError> {
        let Some(rest) = raw.strip_prefix("http://") else {
            return Err(EffectStateError::HostedBackendInvalid {
                message: "hosted effect-state endpoint must use http:// loopback".to_owned(),
            });
        };
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let (host, port) =
            authority
                .rsplit_once(':')
                .ok_or_else(|| EffectStateError::HostedBackendInvalid {
                    message: "hosted effect-state endpoint must include a loopback port".to_owned(),
                })?;
        if host != "127.0.0.1" && host != "localhost" {
            return Err(EffectStateError::HostedBackendInvalid {
                message: "hosted effect-state endpoint must be loopback".to_owned(),
            });
        }
        let port =
            port.parse::<u16>()
                .map_err(|source| EffectStateError::HostedBackendInvalid {
                    message: format!("hosted effect-state endpoint port is invalid: {source}"),
                })?;
        let mut base_path = format!("/{path}");
        while base_path.ends_with('/') && base_path.len() > 1 {
            base_path.pop();
        }
        Ok(Self {
            host: host.to_owned(),
            port,
            base_path,
        })
    }
}

fn parse_hosted_response(response: &str) -> Result<(u16, HostedFamilyResponse), EffectStateError> {
    let (head, body) = response.split_once("\r\n\r\n").ok_or_else(|| {
        EffectStateError::HostedBackendTransport {
            message: "hosted effect-state response is missing an HTTP body".to_owned(),
        }
    })?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| EffectStateError::HostedBackendTransport {
            message: "hosted effect-state response is missing a status code".to_owned(),
        })?
        .parse::<u16>()
        .map_err(|source| EffectStateError::HostedBackendTransport {
            message: format!("hosted effect-state status code is invalid: {source}"),
        })?;
    let body = body.trim();
    if body.is_empty() {
        return Err(EffectStateError::HostedBackendTransport {
            message: format!("hosted effect-state status {status} returned no response body"),
        });
    }
    let family =
        serde_json::from_str(body).map_err(|source| EffectStateError::HostedBackendTransport {
            message: format!("hosted effect-state response JSON is invalid: {source}"),
        })?;
    Ok((status, family))
}

fn hosted_family_name_is_safe(family: &str) -> bool {
    !family.is_empty()
        && family
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub(in crate::effect_state) fn hosted_transport_missing() -> EffectStateError {
    EffectStateError::HostedBackendUnsupported {
        message: format!(
            "{RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV} requests {HOSTED_TRANSACTIONAL_BACKEND_KIND}, but this native runtime did not receive a complete hosted effect-state transport"
        ),
    }
}

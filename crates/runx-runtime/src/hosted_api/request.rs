use serde::de::DeserializeOwned;

use super::{HostedApiOperationError, parse_hosted_api_error};
use crate::http::{HttpMethod, RuntimeHttpHeader, RuntimeHttpRequest, RuntimeHttpTransport};

pub(crate) fn send_json<T: DeserializeOwned>(
    transport: &(impl RuntimeHttpTransport + ?Sized),
    base_url: &str,
    operation: &'static str,
    method: HttpMethod,
    path: &str,
    bearer_token: Option<&str>,
    body: Option<String>,
) -> Result<T, HostedApiOperationError> {
    let mut headers = Vec::new();
    if let Some(token) = bearer_token {
        headers.push(RuntimeHttpHeader::new(
            "authorization",
            format!("Bearer {token}"),
        ));
    }
    if body.is_some() {
        headers.push(RuntimeHttpHeader::new("content-type", "application/json"));
    }
    let response = transport.send(RuntimeHttpRequest {
        method,
        url: format!("{}{}", base_url.trim_end_matches('/'), path),
        headers,
        body,
    })?;
    if !(200..=299).contains(&response.status) {
        if let Some(error) = parse_hosted_api_error(&response.body) {
            return Err(HostedApiOperationError::Api {
                operation,
                status: response.status,
                code: error.code,
                detail: error.detail,
                hint: error.hint,
                retry_after_seconds: error.retry_after_seconds,
            });
        }
        return Err(HostedApiOperationError::HttpStatus {
            operation,
            status: response.status,
            detail: response.body,
        });
    }
    serde_json::from_str(&response.body).map_err(|error| HostedApiOperationError::InvalidJson {
        operation,
        message: error.to_string(),
    })
}

pub(super) fn path_identifier<'a>(
    operation: &'static str,
    label: &str,
    value: &'a str,
) -> Result<&'a str, HostedApiOperationError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 200
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '?' | '#'))
    {
        return Err(HostedApiOperationError::InvalidRequest {
            operation,
            message: format!("{label} must be a safe, non-empty URL path identifier"),
        });
    }
    Ok(value)
}

pub(super) fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

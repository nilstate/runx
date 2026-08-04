use runx_contracts::{JsonObject, JsonValue};

use crate::hosted_api::{
    AuthenticatedHostedApiEnvironment, HostedConnectAction, execute_hosted_connect,
    request::send_json,
};
use crate::http::{HttpMethod, RuntimeHttpTransport as Transport};

mod error;

pub use error::ProviderOperationError;

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderOperationRequest {
    pub grant_id: String,
    pub operation: String,
    pub target: String,
    pub scopes: Vec<String>,
    pub input: JsonObject,
    pub expected_access: Option<ProviderOperationAccess>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderOperationAccess {
    Read,
    Mutate,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedProviderGrant {
    pub grant_id: String,
    pub provider: String,
    pub scopes: Vec<String>,
    pub status: String,
}

impl ProviderOperationAccess {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Mutate => "mutate",
        }
    }
}

pub fn list_provider_grants<T: Transport + ?Sized>(
    transport: &T,
    environment: &AuthenticatedHostedApiEnvironment,
) -> Result<Vec<HostedProviderGrant>, ProviderOperationError> {
    let response = execute_hosted_connect(transport, environment, HostedConnectAction::List)?;
    let response: JsonValue = serde_json::from_value(response).map_err(|error| {
        ProviderOperationError::InvalidResponse(format!(
            "grant response could not be projected: {error}"
        ))
    })?;
    let response = response.as_object().ok_or_else(|| {
        ProviderOperationError::InvalidResponse("grant response must be an object".to_owned())
    })?;
    if response.get("status").and_then(JsonValue::as_str) != Some("success") {
        return Err(ProviderOperationError::InvalidResponse(
            "grant response status is not success".to_owned(),
        ));
    }
    let grants = response
        .get("grants")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| {
            ProviderOperationError::InvalidResponse(
                "grant response grants must be an array".to_owned(),
            )
        })?;
    grants
        .iter()
        .map(parse_provider_grant)
        .collect::<Result<Vec<_>, _>>()
}

fn parse_provider_grant(value: &JsonValue) -> Result<HostedProviderGrant, ProviderOperationError> {
    let grant = value.as_object().ok_or_else(|| {
        ProviderOperationError::InvalidResponse("provider grant must be an object".to_owned())
    })?;
    let grant_id = required_response_string(grant, "grant_id")?.to_owned();
    validate_provider_grant_id(&grant_id)?;
    let provider = required_response_string(grant, "provider")?.to_owned();
    let status = required_response_string(grant, "status")?.to_owned();
    let scopes = grant
        .get("scopes")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| {
            ProviderOperationError::InvalidResponse(
                "provider grant scopes must be an array".to_owned(),
            )
        })?
        .iter()
        .map(|scope| {
            scope
                .as_str()
                .filter(|scope| !scope.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    ProviderOperationError::InvalidResponse(
                        "provider grant scopes must be non-empty strings".to_owned(),
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(HostedProviderGrant {
        grant_id,
        provider,
        scopes,
        status,
    })
}

pub fn invoke_provider_operation<T: Transport + ?Sized>(
    transport: &T,
    environment: &AuthenticatedHostedApiEnvironment,
    request: &ProviderOperationRequest,
) -> Result<JsonObject, ProviderOperationError> {
    validate_provider_grant_id(&request.grant_id)?;
    validate_provider_operation(&request.operation)?;
    if request.scopes.is_empty() || request.scopes.iter().any(|scope| scope.trim().is_empty()) {
        return Err(ProviderOperationError::InvalidScopes);
    }
    let mut body = JsonObject::from([
        (
            "grant_id".to_owned(),
            JsonValue::String(request.grant_id.clone()),
        ),
        (
            "operation".to_owned(),
            JsonValue::String(request.operation.clone()),
        ),
        (
            "target".to_owned(),
            JsonValue::String(request.target.clone()),
        ),
        (
            "scopes".to_owned(),
            JsonValue::Array(
                request
                    .scopes
                    .iter()
                    .cloned()
                    .map(JsonValue::String)
                    .collect(),
            ),
        ),
        ("input".to_owned(), JsonValue::Object(request.input.clone())),
    ]);
    if let Some(access) = request.expected_access {
        body.insert(
            "access".to_owned(),
            JsonValue::String(access.as_str().to_owned()),
        );
    }
    let body = serde_json::to_string(&body).map_err(|error| {
        crate::hosted_api::HostedApiOperationError::InvalidRequest {
            operation: "provider operation request",
            message: error.to_string(),
        }
    })?;
    let response: JsonObject = send_json(
        transport,
        environment.base_url(),
        "provider operation",
        HttpMethod::Post,
        "/v1/provider-operations",
        Some(environment.token()),
        Some(body),
    )?;
    parse_provider_operation_response(response, request)
}

fn parse_provider_operation_response(
    response: JsonObject,
    request: &ProviderOperationRequest,
) -> Result<JsonObject, ProviderOperationError> {
    validate_operation_readback(&response, request)?;
    project_operation_readback(response)
}

fn validate_operation_readback(
    response: &JsonObject,
    request: &ProviderOperationRequest,
) -> Result<(), ProviderOperationError> {
    if response.get("status").and_then(JsonValue::as_str) != Some("success") {
        return Err(ProviderOperationError::InvalidResponse(
            "response status is not success".to_owned(),
        ));
    }
    required_response_string(response, "provider")?;
    let operation = required_response_string(response, "operation")?;
    if operation != request.operation {
        return Err(ProviderOperationError::InvalidResponse(format!(
            "response operation {operation:?} does not match requested operation {:?}",
            request.operation
        )));
    }
    let target = required_response_string(response, "target")?;
    if target != request.target {
        return Err(ProviderOperationError::InvalidResponse(format!(
            "response target {target:?} does not match requested target {:?}",
            request.target
        )));
    }
    let access = response.get("access").and_then(JsonValue::as_str);
    if let Some(expected) = request.expected_access
        && access != Some(expected.as_str())
    {
        return Err(ProviderOperationError::InvalidResponse(format!(
            "response access {access:?} does not match requested access {:?}",
            expected.as_str()
        )));
    }
    if response.get("result").is_none() {
        return Err(ProviderOperationError::InvalidResponse(
            "response result is missing".to_owned(),
        ));
    }
    required_response_string(response, "readback_ref")?;
    if request.expected_access == Some(ProviderOperationAccess::Mutate) {
        required_response_string(response, "operation_id")?;
        let expected_idempotency_key = required_response_string(&request.input, "idempotency_key")?;
        let actual_idempotency_key = required_response_string(response, "idempotency_key")?;
        if actual_idempotency_key != expected_idempotency_key {
            return Err(ProviderOperationError::InvalidResponse(
                "response idempotency_key does not match the runtime-derived request key"
                    .to_owned(),
            ));
        }
    }
    Ok(())
}

fn project_operation_readback(response: JsonObject) -> Result<JsonObject, ProviderOperationError> {
    let provider = required_response_string(&response, "provider")?;
    let operation = required_response_string(&response, "operation")?;
    let target = required_response_string(&response, "target")?;
    let result = response.get("result").cloned().ok_or_else(|| {
        ProviderOperationError::InvalidResponse("response result is missing".to_owned())
    })?;
    let mut readback = JsonObject::from([
        ("status".to_owned(), JsonValue::String("success".to_owned())),
        (
            "provider".to_owned(),
            JsonValue::String(provider.to_owned()),
        ),
        (
            "operation".to_owned(),
            JsonValue::String(operation.to_owned()),
        ),
        ("target".to_owned(), JsonValue::String(target.to_owned())),
        ("result".to_owned(), result),
    ]);
    for field in ["operation_id", "idempotency_key", "readback_ref"] {
        if let Some(value) = response.get(field) {
            readback.insert(field.to_owned(), value.clone());
        }
    }
    Ok(readback)
}

fn required_response_string<'a>(
    object: &'a JsonObject,
    field: &str,
) -> Result<&'a str, ProviderOperationError> {
    object
        .get(field)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ProviderOperationError::InvalidResponse(format!(
                "response {field} must be a non-empty string"
            ))
        })
}

pub fn validate_provider_grant_id(value: &str) -> Result<(), ProviderOperationError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 200
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '?' | '#'))
    {
        return Err(ProviderOperationError::InvalidGrantId);
    }
    Ok(())
}

pub fn validate_provider_operation(value: &str) -> Result<(), ProviderOperationError> {
    let value = value.trim();
    let mut segments = value.split('.');
    let first = segments.next().unwrap_or_default();
    if value.len() > 100
        || !valid_operation_segment(first)
        || !segments.next().is_some_and(valid_operation_segment)
        || !segments.all(valid_operation_segment)
    {
        return Err(ProviderOperationError::InvalidOperation);
    }
    Ok(())
}

fn valid_operation_segment(segment: &str) -> bool {
    let mut characters = segment.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_lowercase())
        && characters.all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests;

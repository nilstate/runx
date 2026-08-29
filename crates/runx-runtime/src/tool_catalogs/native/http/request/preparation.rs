use std::collections::{BTreeMap, BTreeSet};

use runx_contracts::{JsonObject, JsonValue};
use url::Url;

use super::super::resolution::{
    Pagination, method, optional_positive_usize, pagination, request_headers, required_string,
    resolve_object, resolve_url_template, resolve_value,
};
use super::super::{DEFAULT_RESPONSE_BYTES, MAX_RESPONSE_BYTES, invalid};
use crate::RuntimeError;
use crate::http::{HttpMethod, RuntimeHttpHeader};

pub(super) struct PreparedRequest {
    pub(super) method: HttpMethod,
    pub(super) url: Url,
    pub(super) query: JsonObject,
    pub(super) headers: Vec<RuntimeHttpHeader>,
    pub(super) body: Option<String>,
    pub(super) pagination: Option<Pagination>,
    pub(super) response_limit: usize,
}

pub(super) fn prepare_request(
    request: &JsonObject,
    request_id: &str,
    allowed_hosts: &BTreeSet<String>,
    prior: &BTreeMap<String, JsonObject>,
) -> Result<PreparedRequest, RuntimeError> {
    let method = method(request.get("method").and_then(JsonValue::as_str))?;
    let path = resolve_object(request.get("path"), prior, "path")?;
    let url = admitted_url(request, request_id, allowed_hosts, prior, &path)?;
    let query = resolve_object(request.get("query"), prior, "query")?;
    let headers = request_headers(request.get("headers"))?;
    if has_authorization(&headers) {
        return Err(invalid(
            "request headers must not supply authorization; use the auth binding",
        ));
    }
    let body = resolved_body(request, prior)?;
    Ok(PreparedRequest {
        method,
        url,
        query,
        headers,
        body,
        pagination: pagination(request.get("pagination"))?,
        response_limit: response_limit(request, request_id)?,
    })
}

fn admitted_url(
    request: &JsonObject,
    request_id: &str,
    allowed_hosts: &BTreeSet<String>,
    prior: &BTreeMap<String, JsonObject>,
    path: &JsonObject,
) -> Result<Url, RuntimeError> {
    let resolved = resolve_url_template(required_string(request, "url")?, prior, path)?;
    let url = Url::parse(&resolved)
        .map_err(|error| invalid(format!("request {request_id:?} has invalid URL: {error}")))?;
    if url.scheme() != "https" {
        return Err(invalid(format!("request {request_id:?} must use HTTPS")));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid(format!(
            "request {request_id:?} URL must not contain credentials"
        )));
    }
    let host = url
        .host_str()
        .map(|value| value.trim_end_matches('.').to_ascii_lowercase())
        .ok_or_else(|| invalid(format!("request {request_id:?} URL has no host")))?;
    if !allowed_hosts.contains(&host) {
        return Err(invalid(format!(
            "request {request_id:?} host {host:?} is outside allowed_hosts"
        )));
    }
    Ok(url)
}

fn resolved_body(
    request: &JsonObject,
    prior: &BTreeMap<String, JsonObject>,
) -> Result<Option<String>, RuntimeError> {
    let Some(raw_body) = request.get("body") else {
        return Ok(None);
    };
    let body = resolve_value(raw_body.clone(), prior, "body")?;
    serde_json::to_string(&body)
        .map(Some)
        .map_err(|error| invalid(format!("serializing request body: {error}")))
}

fn response_limit(request: &JsonObject, request_id: &str) -> Result<usize, RuntimeError> {
    let limit = optional_positive_usize(request, "max_response_bytes", DEFAULT_RESPONSE_BYTES)?;
    if limit > MAX_RESPONSE_BYTES {
        return Err(invalid(format!(
            "request {request_id:?} max_response_bytes must not exceed {MAX_RESPONSE_BYTES}"
        )));
    }
    Ok(limit)
}

fn has_authorization(headers: &[RuntimeHttpHeader]) -> bool {
    headers
        .iter()
        .any(|header| header.name.eq_ignore_ascii_case("authorization"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared(
        method: &str,
        body: Option<JsonValue>,
    ) -> Result<PreparedRequest, Box<dyn std::error::Error>> {
        let mut request = JsonObject::from([
            ("method".to_owned(), JsonValue::String(method.to_owned())),
            (
                "url".to_owned(),
                JsonValue::String("https://api.example.com/mcp".to_owned()),
            ),
        ]);
        if let Some(body) = body {
            request.insert("body".to_owned(), body);
        }
        Ok(prepare_request(
            &request,
            "fixture",
            &BTreeSet::from(["api.example.com".to_owned()]),
            &BTreeMap::new(),
        )?)
    }

    #[test]
    fn harness_http_exchanges_preserve_absent_and_explicit_json_bodies()
    -> Result<(), Box<dyn std::error::Error>> {
        let absent = prepared("POST", None)?;
        assert_eq!(absent.body, None);

        for method in ["POST", "GET", "DELETE"] {
            let body = prepared(method, Some(JsonValue::Null))?;
            assert_eq!(body.body.as_deref(), Some("null"));
        }
        Ok(())
    }
}

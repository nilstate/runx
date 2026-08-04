use std::collections::{BTreeMap, BTreeSet};

use runx_contracts::{JsonNumber, JsonObject, JsonValue};

use super::super::NativeInvocation;
use super::HttpBatchInput;
use super::auth::{RequestAuth, apply_auth};
use super::invalid;
use super::resolution::scalar_pairs;
use crate::RuntimeError;
use crate::http::{
    RuntimeHttpHeader, RuntimeHttpRequest, RuntimeHttpResponse, RuntimeHttpTransport,
};

mod pagination;
mod preparation;

use pagination::execute_paginated;
use preparation::{PreparedRequest, prepare_request};

struct RequestRuntime<'a, 'invocation, T> {
    transport: &'a T,
    auth: &'a RequestAuth,
    invocation: &'a NativeInvocation<'invocation, HttpBatchInput>,
}

pub(super) struct RequestExecution<'a, 'invocation> {
    pub request: &'a JsonObject,
    pub request_id: &'a str,
    pub allowed_hosts: &'a BTreeSet<String>,
    pub auth: &'a RequestAuth,
    pub invocation: &'a NativeInvocation<'invocation, HttpBatchInput>,
    pub prior: &'a BTreeMap<String, JsonObject>,
    pub retry_as_idempotent: bool,
}

impl<T: RuntimeHttpTransport> RequestRuntime<'_, '_, T> {
    fn send(
        &self,
        request_id: &str,
        request: &PreparedRequest,
        query: &JsonObject,
        retry_as_idempotent: bool,
    ) -> Result<JsonObject, RuntimeError> {
        let mut url = request.url.clone();
        for (key, value) in scalar_pairs(query, "query")? {
            url.query_pairs_mut().append_pair(&key, &value);
        }
        let mut headers = request.headers.clone();
        ensure_content_type(&mut headers, request.body.as_deref());
        apply_auth(
            &mut headers,
            request.method,
            &url,
            self.auth,
            self.invocation,
        )?;
        let outbound = RuntimeHttpRequest {
            method: request.method,
            url: url.to_string(),
            headers,
            body: request.body.clone(),
        };
        let response = if retry_as_idempotent {
            self.transport
                .send_idempotent_limited(outbound, request.response_limit)
        } else {
            self.transport
                .send_limited(outbound, request.response_limit)
        }
        .map_err(|error| invalid(format!("request {request_id:?} failed: {error}")))?;
        response_object(request_id, response, self.invocation)
    }
}

pub(super) fn execute_one<T: RuntimeHttpTransport>(
    transport: &T,
    execution: RequestExecution<'_, '_>,
) -> Result<JsonObject, RuntimeError> {
    let request = prepare_request(
        execution.request,
        execution.request_id,
        execution.allowed_hosts,
        execution.prior,
    )?;
    let runtime = RequestRuntime {
        transport,
        auth: execution.auth,
        invocation: execution.invocation,
    };
    match &request.pagination {
        Some(pagination) => execute_paginated(&runtime, execution.request_id, &request, pagination),
        None => runtime.send(
            execution.request_id,
            &request,
            &request.query,
            execution.retry_as_idempotent,
        ),
    }
}

fn ensure_content_type(headers: &mut Vec<RuntimeHttpHeader>, body: Option<&str>) {
    if body.is_some()
        && !headers
            .iter()
            .any(|header| header.name.eq_ignore_ascii_case("content-type"))
    {
        headers.push(RuntimeHttpHeader::new("content-type", "application/json"));
    }
}

fn response_object(
    request_id: &str,
    response: RuntimeHttpResponse,
    invocation: &NativeInvocation<'_, HttpBatchInput>,
) -> Result<JsonObject, RuntimeError> {
    let (parsed_json, body) = match serde_json::from_str::<JsonValue>(&response.body) {
        Ok(mut value) => {
            invocation.credential_delivery.redact_json_value(&mut value);
            (Some(value), String::new())
        }
        Err(_) => (
            None,
            invocation.credential_delivery.redact_text(response.body),
        ),
    };
    let headers = response
        .headers
        .into_iter()
        .filter(|header| !crate::http::sensitive_header_name(&header.name))
        .map(|header| {
            (
                invocation
                    .credential_delivery
                    .redact_text(header.name.to_ascii_lowercase()),
                JsonValue::String(invocation.credential_delivery.redact_text(header.value)),
            )
        })
        .collect();
    Ok(JsonObject::from([
        ("id".to_owned(), JsonValue::String(request_id.to_owned())),
        ("performed".to_owned(), JsonValue::Bool(true)),
        (
            "status".to_owned(),
            JsonValue::Number(JsonNumber::U64(u64::from(response.status))),
        ),
        (
            "ok".to_owned(),
            JsonValue::Bool((200..300).contains(&response.status)),
        ),
        ("json".to_owned(), parsed_json.unwrap_or(JsonValue::Null)),
        ("body".to_owned(), JsonValue::String(body)),
        (
            "body_digest".to_owned(),
            JsonValue::String(response.body_digest),
        ),
        (
            "body_bytes".to_owned(),
            JsonValue::Number(JsonNumber::U64(response.body_bytes as u64)),
        ),
        ("truncated".to_owned(), JsonValue::Bool(response.truncated)),
        ("headers".to_owned(), JsonValue::Object(headers)),
    ]))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    #[cfg(feature = "catalog")]
    use crate::RuntimeEffectRegistry;
    use crate::credentials::CredentialDelivery;

    #[test]
    fn response_headers_are_name_filtered_and_value_redacted_before_receipt_projection()
    -> Result<(), Box<dyn std::error::Error>> {
        let workspace = tempfile::tempdir()?;
        let inputs = HttpBatchInput {
            requests: Vec::new(),
            allowed_hosts: vec!["api.example.com".to_owned()],
            auth: None,
            stop_on_error: true,
        };
        let env = BTreeMap::new();
        let delivery = CredentialDelivery::from_local_descriptor(
            "example",
            "bearer",
            "EXAMPLE_TOKEN",
            "local:example:test",
            vec!["example:read".to_owned()],
            "credential-sentinel",
        )?;
        #[cfg(feature = "catalog")]
        let effects = RuntimeEffectRegistry::default();
        let invocation = NativeInvocation {
            inputs: &inputs,
            observed_at: "2026-01-01T00:00:00Z",
            data_source_binding: None,
            env: &env,
            skill_directory: workspace.path(),
            credential_delivery: &delivery,
            local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
            #[cfg(feature = "catalog")]
            effects: &effects,
        };
        let mut response = RuntimeHttpResponse::new(200, "{\"ok\":true}");
        response.headers = vec![
            RuntimeHttpHeader::new("authorization", "Bearer credential-sentinel"),
            RuntimeHttpHeader::new("x-echo", "prefix credential-sentinel suffix"),
        ];

        let output = response_object("request-1", response, &invocation)?;
        let receipt_projection = serde_json::to_string(&output)?;

        let headers = output["headers"]
            .as_object()
            .ok_or_else(|| std::io::Error::other("response headers must be an object"))?;
        assert!(!headers.contains_key("authorization"));
        assert!(!receipt_projection.contains("credential-sentinel"));
        Ok(())
    }

    #[test]
    fn decoded_json_credentials_are_redacted_before_output_and_receipt_sealing()
    -> Result<(), Box<dyn std::error::Error>> {
        const SECRET: &str = "credential-sentinel";
        let workspace = tempfile::tempdir()?;
        let inputs = HttpBatchInput {
            requests: Vec::new(),
            allowed_hosts: vec!["api.example.com".to_owned()],
            auth: None,
            stop_on_error: true,
        };
        let env = BTreeMap::new();
        let delivery = CredentialDelivery::from_local_descriptor(
            "example",
            "bearer",
            "EXAMPLE_TOKEN",
            "local:example:test",
            vec!["example:read".to_owned()],
            SECRET,
        )?;
        #[cfg(feature = "catalog")]
        let effects = RuntimeEffectRegistry::default();
        let invocation = NativeInvocation {
            inputs: &inputs,
            observed_at: "2026-01-01T00:00:00Z",
            data_source_binding: None,
            env: &env,
            skill_directory: workspace.path(),
            credential_delivery: &delivery,
            local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
            #[cfg(feature = "catalog")]
            effects: &effects,
        };
        let response = RuntimeHttpResponse::new(
            200,
            r#"{"direct":"credential-sentinel","escaped":"\u0063redential-sentinel","credential-sentinel":{"nested":"\u0063redential-sentinel"}}"#,
        );

        let output = response_object("request-escaped", response, &invocation)?;
        let output_bytes = serde_json::to_vec(&output)?;
        assert!(
            !output_bytes
                .windows(SECRET.len())
                .any(|window| window == SECRET.as_bytes())
        );
        let json = output
            .get("json")
            .and_then(JsonValue::as_object)
            .ok_or("native HTTP JSON output was not an object")?;
        assert_eq!(
            json.get("escaped"),
            Some(&JsonValue::String("[redacted-credential]".to_owned()))
        );
        assert!(
            json.keys()
                .all(|key| { !key.contains("credential-sentinel") })
        );

        let skill_output = crate::adapter::InvocationOutput::runtime_success(
            serde_json::from_slice(&output_bytes)?,
            1,
            JsonObject::new(),
        );
        let receipt = crate::receipts::step_receipt(
            "native-http-redaction",
            "request-escaped",
            1,
            &skill_output,
            &output,
            "2026-01-01T00:00:00Z",
        )?;
        let receipt_bytes = serde_json::to_vec(&receipt)?;
        assert!(
            !receipt_bytes
                .windows(SECRET.len())
                .any(|window| window == SECRET.as_bytes())
        );
        assert!(!format!("{skill_output:?}").contains(SECRET));
        Ok(())
    }
}

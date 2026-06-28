// rust-style-allow: large-file because the governed HTTP front keeps the request
// engine, the skill adapter, and their unit tests in one review unit, mirroring
// http.rs.
//! Governed HTTP execution on the runtime HTTP transport.
//!
//! The keystone call-out front. Given a method, URL, and inputs, this builds a
//! request, sends it through the governed `http` transport (which enforces
//! SSRF and private-network filtering, header validation, no-redirect, SSL, and
//! timeouts), and maps the response to the universal [`SkillOutput`]. GET and DELETE
//! map inputs to the query string; POST, PUT, and PATCH map them to a JSON body. It reuses the same
//! transport the Anthropic resolver and the registry client use, so there is one
//! governed HTTP path, not a parallel one. The URL may carry `{name}` path
//! placeholders that are filled from matching scalar inputs (and then dropped from
//! the query/body), so REST resource paths like `/v1/pets/{id}` are expressible
//! directly.

use std::collections::BTreeMap;

use runx_contracts::{JsonObject, JsonValue};
use serde_json::Value as WireValue;

use crate::RuntimeError;
use crate::adapter::{
    CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA, InvocationStatus, SkillAdapter, SkillInvocation,
    SkillOutput,
};
use crate::credentials::SecretEnv;
use crate::http::{
    DEFAULT_BROWSER_USER_AGENT, HttpMethod, ReqwestHttpTransport, RuntimeHttpHeader,
    RuntimeHttpRequest, RuntimeHttpTransport,
};
use runx_parser::SourceKind;

const HTTP_SKILL: &str = "http";
const RUNX_HTTP_ALLOW_PRIVATE_NETWORK_ENV: &str = "RUNX_HTTP_ALLOW_PRIVATE_NETWORK";
// The open-web fetch surface presents a browser profile by default so a Cloudflare-fronted
// site does not score us as a bot. RUNX_HTTP_BROWSER=0 opts a run out (back to the plain
// client); RUNX_HTTP_USER_AGENT overrides the UA string.
const RUNX_HTTP_BROWSER_ENV: &str = "RUNX_HTTP_BROWSER";
const RUNX_HTTP_USER_AGENT_ENV: &str = "RUNX_HTTP_USER_AGENT";

/// A governed HTTP call: a method, a URL, and the request headers (auth and the
/// like, already resolved). Inputs are mapped to the query string (GET, DELETE) or
/// a JSON body (POST, PUT, PATCH).
#[derive(Clone, Debug)]
pub struct HttpCall {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<RuntimeHttpHeader>,
}

fn failure(message: String) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: HTTP_SKILL.to_owned(),
        message,
    }
}

fn scalar(value: &WireValue) -> Option<String> {
    match value {
        WireValue::String(value) => Some(value.clone()),
        WireValue::Bool(value) => Some(value.to_string()),
        WireValue::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn with_query(url: &str, inputs: &JsonObject) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    let mut any = false;
    for (key, value) in inputs {
        if let Some(value) = scalar(&serde_json::to_value(value).unwrap_or(WireValue::Null)) {
            serializer.append_pair(key, &value);
            any = true;
        }
    }
    if !any {
        return url.to_owned();
    }
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}{}", serializer.finish())
}

/// Substitute `{name}` path placeholders in the URL with matching scalar inputs,
/// returning the resolved URL and the inputs with the consumed path parameters
/// removed (so a path parameter is not also sent as a query parameter or body
/// field). A placeholder with no matching scalar input, or a value that is not a
/// safe path segment (empty or containing URL-significant characters), fails
/// closed. This lets the http source express REST resource paths like
/// `/v1/pets/{id}` without a separate spec resolver.
// rust-style-allow: long-function because the style checker's brace counter
// miscounts the '{' and '}' char literals in this placeholder scanner; the
// function itself is short.
fn resolve_path_template(
    url: &str,
    inputs: &JsonObject,
) -> Result<(String, JsonObject), RuntimeError> {
    if !url.contains('{') {
        return Ok((url.to_owned(), inputs.clone()));
    }
    let mut out = String::with_capacity(url.len());
    let mut remaining = inputs.clone();
    let mut rest = url;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after
            .find('}')
            .ok_or_else(|| failure("http url has an unclosed '{' path placeholder".to_owned()))?;
        let name = &after[..end];
        let value = inputs
            .get(name)
            .and_then(|value| scalar(&serde_json::to_value(value).unwrap_or(WireValue::Null)))
            .ok_or_else(|| {
                failure(format!(
                    "http url path placeholder {{{name}}} has no matching scalar input"
                ))
            })?;
        if value.is_empty() || value.contains(['/', '?', '#', '{', '}', ' ', '%']) {
            return Err(failure(format!(
                "http url path placeholder {{{name}}} value is not a safe path segment: {value:?}"
            )));
        }
        out.push_str(&value);
        remaining.remove(name);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok((out, remaining))
}

fn json_body(inputs: &JsonObject, secrets: &SecretEnv) -> Result<String, RuntimeError> {
    let value = substitute_json_secrets(&JsonValue::Object(inputs.clone()), secrets)?;
    serde_json::to_string(&serde_json::to_value(value).unwrap_or(WireValue::Null))
        .map_err(|error| failure(format!("serializing http request body: {error}")))
}

/// Execute a governed HTTP call and seal the response into a [`SkillOutput`]. A
/// non-2xx status is a clean failure (the body is still captured), not an error.
pub fn execute_http_call<T: RuntimeHttpTransport>(
    transport: &T,
    call: &HttpCall,
    inputs: &JsonObject,
    secrets: &SecretEnv,
) -> Result<SkillOutput, RuntimeError> {
    let (resolved_url, query_inputs) = resolve_path_template(&call.url, inputs)?;
    let mut headers = call.headers.clone();
    let (url, body) = match call.method {
        HttpMethod::Post | HttpMethod::Put | HttpMethod::Patch => {
            if !headers
                .iter()
                .any(|header| header.name.eq_ignore_ascii_case("content-type"))
            {
                headers.push(RuntimeHttpHeader::new("content-type", "application/json"));
            }
            (resolved_url, Some(json_body(&query_inputs, secrets)?))
        }
        HttpMethod::Get | HttpMethod::Delete => (with_query(&resolved_url, &query_inputs), None),
    };
    let response = transport
        .send(RuntimeHttpRequest {
            method: call.method,
            url,
            headers,
            body,
        })
        .map_err(|error| failure(format!("http request failed: {error}")))?;
    let success = (200..300).contains(&response.status);
    let mut metadata = JsonObject::new();
    metadata.insert(
        "http_status".to_owned(),
        JsonValue::String(response.status.to_string()),
    );
    Ok(SkillOutput {
        status: if success {
            InvocationStatus::Success
        } else {
            InvocationStatus::Failure
        },
        stdout: response.body,
        stderr: String::new(),
        exit_code: Some(i32::from(!success)),
        duration_ms: 0,
        metadata,
    })
}

const SECRET_PREFIX: &str = "${secret:";

/// Resolve `${secret:NAME}` references against the run's secret env, mirroring
/// how the cli-tool front lets a command reference a delivered secret. A
/// reference to a secret that was not delivered fails closed.
fn substitute_secrets(value: &str, secrets: &SecretEnv) -> Result<String, RuntimeError> {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find(SECRET_PREFIX) {
        out.push_str(&rest[..start]);
        let after = &rest[start + SECRET_PREFIX.len()..];
        let end = after
            .find('}')
            .ok_or_else(|| failure("http secret reference is missing a closing '}'".to_owned()))?;
        let name = &after[..end];
        let secret = secrets.get(name).ok_or_else(|| {
            failure(format!(
                "http references secret {name}, which was not delivered to this run"
            ))
        })?;
        out.push_str(secret);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn substitute_json_secrets(
    value: &JsonValue,
    secrets: &SecretEnv,
) -> Result<JsonValue, RuntimeError> {
    match value {
        JsonValue::String(value) => substitute_secrets(value, secrets).map(JsonValue::String),
        JsonValue::Array(values) => values
            .iter()
            .map(|value| substitute_json_secrets(value, secrets))
            .collect::<Result<Vec<_>, _>>()
            .map(JsonValue::Array),
        JsonValue::Object(object) => object
            .iter()
            .map(|(key, value)| Ok((key.clone(), substitute_json_secrets(value, secrets)?)))
            .collect::<Result<JsonObject, _>>()
            .map(JsonValue::Object),
        value => Ok(value.clone()),
    }
}

/// Build the request headers from the source's validated `headers` map, resolving
/// any `${secret:NAME}` references. Header names and values are otherwise passed
/// through verbatim; the transport validates them and redacts sensitive ones.
fn resolve_headers(
    headers: Option<&BTreeMap<String, String>>,
    secrets: &SecretEnv,
) -> Result<Vec<RuntimeHttpHeader>, RuntimeError> {
    let Some(headers) = headers else {
        return Ok(Vec::new());
    };
    headers
        .iter()
        .map(|(name, value)| {
            Ok(RuntimeHttpHeader::new(
                name.clone(),
                substitute_secrets(value, secrets)?,
            ))
        })
        .collect()
}

/// Parse a manifest method string into an [`HttpMethod`], defaulting to GET. The
/// parser already restricts `source.method` to GET, POST, PUT, PATCH, or DELETE,
/// so this is a total mapping with a fail-closed arm.
fn parse_method(raw: Option<&str>) -> Result<HttpMethod, RuntimeError> {
    match raw.map(str::to_ascii_uppercase).as_deref() {
        None | Some("GET") => Ok(HttpMethod::Get),
        Some("POST") => Ok(HttpMethod::Post),
        Some("PUT") => Ok(HttpMethod::Put),
        Some("PATCH") => Ok(HttpMethod::Patch),
        Some("DELETE") => Ok(HttpMethod::Delete),
        Some(other) => Err(failure(format!("unsupported http method {other}"))),
    }
}

/// Merge an invocation's raw and resolved inputs, with resolved inputs (the
/// materialized `$input.*` values) taking precedence.
fn merged_inputs(invocation: &SkillInvocation) -> JsonObject {
    let mut inputs = invocation.inputs.clone();
    for (key, value) in &invocation.resolved_inputs {
        inputs.insert(key.clone(), value.clone());
    }
    inputs
}

fn operator_allows_private_network(env: &BTreeMap<String, String>) -> bool {
    env.get(RUNX_HTTP_ALLOW_PRIVATE_NETWORK_ENV)
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

/// The browser User-Agent for the open-web fetch surface, or `None` (the plain client)
/// when the run opts out with `RUNX_HTTP_BROWSER=0`. `RUNX_HTTP_USER_AGENT` overrides the
/// default Chrome string. Browser-on is the default.
fn browser_user_agent(env: &BTreeMap<String, String>) -> Option<String> {
    let opted_out = env
        .get(RUNX_HTTP_BROWSER_ENV)
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "0" | "false" | "no" | "off"));
    if opted_out {
        return None;
    }
    let user_agent = env
        .get(RUNX_HTTP_USER_AGENT_ENV)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BROWSER_USER_AGENT);
    Some(user_agent.to_owned())
}

/// The governed HTTP skill adapter: reads `url`/`method`/`headers` from an `http`
/// source, resolves credential headers, and runs the call through the governed
/// transport. The default constructs a [`ReqwestHttpTransport`]; the engine itself
/// ([`execute_http_call`]) is transport-generic and unit-tested with a stub.
#[derive(Clone, Copy, Debug, Default)]
pub struct HttpSkillAdapter;

impl SkillAdapter for HttpSkillAdapter {
    fn adapter_type(&self) -> &'static str {
        HTTP_SKILL
    }

    fn invoke(&self, request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
        if request.source.source_type != SourceKind::Http {
            return Err(RuntimeError::UnsupportedAdapter {
                adapter_type: request.source.source_type.as_str().to_owned(),
            });
        }
        let http = request
            .source
            .http
            .as_ref()
            .ok_or_else(|| failure("http source is missing its http config".to_owned()))?;
        let call = HttpCall {
            method: parse_method(http.method.as_deref())?,
            url: http.url.clone(),
            headers: resolve_headers(
                http.headers.as_ref(),
                request.credential_delivery.secret_env(),
            )?,
        };
        // Default transport blocks private/loopback networks. Private-network
        // access requires both the source flag and an operator-carried runtime
        // grant so a manifest cannot self-authorize SSRF-sensitive reachability.
        let allow_private_network = http.allow_private_network.unwrap_or(false);
        if allow_private_network && !operator_allows_private_network(&request.env) {
            return Err(failure(format!(
                "http source requested private-network access but operator grant {RUNX_HTTP_ALLOW_PRIVATE_NETWORK_ENV}=1 is not set"
            )));
        }
        // The http tool is the open-web fetch surface, so it presents the browser
        // profile by default; a per-source header still overrides any browser default.
        let transport = ReqwestHttpTransport::with_options(
            allow_private_network,
            browser_user_agent(&request.env),
        )
        .map_err(|error| failure(format!("http transport unavailable: {error}")))?;
        let mut output = execute_http_call(
            &transport,
            &call,
            &merged_inputs(&request),
            request.credential_delivery.secret_env(),
        )?;
        add_credential_delivery_metadata(&mut output, &request.credential_delivery)?;
        Ok(output)
    }
}

fn add_credential_delivery_metadata(
    output: &mut SkillOutput,
    credential_delivery: &crate::credentials::CredentialDelivery,
) -> Result<(), RuntimeError> {
    let Some(observation) = credential_delivery.public_observation() else {
        return Ok(());
    };
    let value: JsonValue = serde_json::to_value(observation)
        .and_then(serde_json::from_value)
        .map_err(|error| {
            failure(format!(
                "serializing credential delivery observation: {error}"
            ))
        })?;
    output.metadata.insert(
        CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA.to_owned(),
        JsonValue::Array(vec![value]),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{RuntimeHttpError, RuntimeHttpResponse};
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    struct StubTransport {
        status: u16,
        body: String,
        requests: RefCell<Vec<RuntimeHttpRequest>>,
    }

    impl RuntimeHttpTransport for StubTransport {
        fn send(
            &self,
            request: RuntimeHttpRequest,
        ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
            self.requests.borrow_mut().push(request);
            Ok(RuntimeHttpResponse {
                status: self.status,
                body: self.body.clone(),
            })
        }
    }

    fn stub(status: u16, body: &str) -> StubTransport {
        StubTransport {
            status,
            body: body.to_owned(),
            requests: RefCell::new(Vec::new()),
        }
    }

    fn inputs(pairs: &[(&str, &str)]) -> JsonObject {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), JsonValue::String((*value).to_owned())))
            .collect()
    }

    fn empty_secrets() -> SecretEnv {
        SecretEnv::default()
    }

    fn http_invocation(
        allow_private_network: Option<bool>,
        env: BTreeMap<String, String>,
    ) -> SkillInvocation {
        SkillInvocation {
            skill_name: "fixture.http".to_owned(),
            source: runx_parser::SkillSource {
                act: None,
                source_type: SourceKind::Http,
                command: None,
                args: Vec::new(),
                cwd: None,
                timeout_seconds: None,
                input_mode: None,
                sandbox: None,
                server: None,
                catalog_ref: None,
                tool: None,
                arguments: None,
                agent_card_url: None,
                agent_identity: None,
                agent: None,
                task: None,
                hook: None,
                outputs: None,
                graph: None,
                http: Some(runx_parser::SkillHttpSource {
                    url: "http://127.0.0.1:9/metadata".to_owned(),
                    method: Some("GET".to_owned()),
                    headers: None,
                    allow_private_network,
                }),
                raw: JsonObject::new(),
            },
            inputs: JsonObject::new(),
            resolved_inputs: JsonObject::new(),
            current_context: Vec::new(),
            skill_directory: PathBuf::from("."),
            env,
            credential_delivery: crate::credentials::CredentialDelivery::none(),
        }
    }

    #[test]
    fn manifest_private_network_flag_requires_operator_grant() -> Result<(), RuntimeError> {
        let result = HttpSkillAdapter.invoke(http_invocation(Some(true), BTreeMap::new()));
        let message = match result {
            Err(RuntimeError::SkillFailed { message, .. }) => message,
            other => {
                return Err(RuntimeError::SkillFailed {
                    skill_name: "http-test".to_owned(),
                    message: format!("expected operator-gate failure, got: {other:?}"),
                });
            }
        };

        assert!(
            message.contains("operator grant RUNX_HTTP_ALLOW_PRIVATE_NETWORK=1 is not set"),
            "unexpected failure: {message}"
        );
        Ok(())
    }

    #[test]
    fn get_maps_inputs_to_query_and_seals_the_response() -> Result<(), RuntimeError> {
        let transport = stub(200, r#"{"ok":true}"#);
        let call = HttpCall {
            method: HttpMethod::Get,
            url: "https://api.example.test/v1/pets".to_owned(),
            headers: Vec::new(),
        };
        let output = execute_http_call(
            &transport,
            &call,
            &inputs(&[("id", "p-7")]),
            &empty_secrets(),
        )?;
        assert_eq!(output.status, InvocationStatus::Success);
        assert_eq!(output.stdout, r#"{"ok":true}"#);
        let sent = transport.requests.borrow();
        assert!(
            sent.len() == 1 && sent[0].url.contains("id=p-7") && sent[0].body.is_none(),
            "GET inputs must go on the query string with no body; got: {:?}",
            sent.first()
        );
        Ok(())
    }

    #[test]
    fn post_maps_inputs_to_a_json_body() -> Result<(), RuntimeError> {
        let transport = stub(201, "");
        let call = HttpCall {
            method: HttpMethod::Post,
            url: "https://api.example.test/v1/pets".to_owned(),
            headers: Vec::new(),
        };
        execute_http_call(
            &transport,
            &call,
            &inputs(&[("name", "rex")]),
            &empty_secrets(),
        )?;
        let sent = transport.requests.borrow();
        assert!(
            sent[0]
                .body
                .as_deref()
                .is_some_and(|body| body.contains(r#""name":"rex""#)),
            "POST inputs must go in the JSON body; got: {:?}",
            sent[0].body
        );
        Ok(())
    }

    #[test]
    fn post_substitutes_secret_references_in_json_body() -> Result<(), RuntimeError> {
        let delivery = crate::credentials::CredentialDelivery::from_local_descriptor(
            "api",
            "bearer",
            "API_TOKEN",
            "credential:test",
            vec!["api.call".to_owned()],
            "api_secret",
        )
        .map_err(|error| failure(format!("building test credential: {error}")))?;
        let transport = stub(201, "");
        let call = HttpCall {
            method: HttpMethod::Post,
            url: "https://api.example.test/v1/pets".to_owned(),
            headers: Vec::new(),
        };
        execute_http_call(
            &transport,
            &call,
            &inputs(&[("token", "${secret:API_TOKEN}")]),
            delivery.secret_env(),
        )?;
        let sent = transport.requests.borrow();
        assert!(
            sent[0]
                .body
                .as_deref()
                .is_some_and(|body| body.contains(r#""token":"api_secret""#)),
            "POST body should substitute delivered secret refs; got: {:?}",
            sent[0].body
        );
        Ok(())
    }

    #[test]
    fn path_template_substitutes_inputs_and_drops_them_from_the_query() -> Result<(), RuntimeError>
    {
        let transport = stub(200, "{}");
        let call = HttpCall {
            method: HttpMethod::Get,
            url: "https://api.example.test/v1/pets/{id}".to_owned(),
            headers: Vec::new(),
        };
        execute_http_call(
            &transport,
            &call,
            &inputs(&[("id", "p-7"), ("fields", "name")]),
            &empty_secrets(),
        )?;
        let sent = transport.requests.borrow();
        assert!(
            sent[0].url.contains("/v1/pets/p-7")
                && sent[0].url.contains("fields=name")
                && !sent[0].url.contains("id=p-7"),
            "the path param must fill the placeholder and not also appear in the query; got: {}",
            sent[0].url
        );
        Ok(())
    }

    #[test]
    fn path_template_fails_closed_on_a_missing_or_unsafe_placeholder_value() {
        let transport = stub(200, "{}");
        let call = HttpCall {
            method: HttpMethod::Get,
            url: "https://api.example.test/v1/pets/{id}".to_owned(),
            headers: Vec::new(),
        };
        assert!(
            execute_http_call(&transport, &call, &JsonObject::new(), &empty_secrets()).is_err(),
            "a placeholder with no matching input must fail closed"
        );
        assert!(
            execute_http_call(
                &transport,
                &call,
                &inputs(&[("id", "a/b")]),
                &empty_secrets()
            )
            .is_err(),
            "a path value with a path separator must fail closed"
        );
        assert!(
            execute_http_call(
                &transport,
                &call,
                &inputs(&[("id", "a#b")]),
                &empty_secrets()
            )
            .is_err(),
            "a path value with a fragment delimiter must fail closed"
        );
        assert!(
            execute_http_call(
                &transport,
                &call,
                &inputs(&[("id", "a%2Fb")]),
                &empty_secrets()
            )
            .is_err(),
            "a path value with an encoded path delimiter must fail closed"
        );
        assert!(
            execute_http_call(
                &transport,
                &call,
                &inputs(&[("id", "a%3Fb")]),
                &empty_secrets()
            )
            .is_err(),
            "a path value with an encoded query delimiter must fail closed"
        );
    }

    #[test]
    fn put_carries_a_json_body_and_the_method_reaches_the_wire() -> Result<(), RuntimeError> {
        let transport = stub(200, "{}");
        let call = HttpCall {
            method: HttpMethod::Put,
            url: "https://api.example.test/v1/pets/p-7".to_owned(),
            headers: Vec::new(),
        };
        execute_http_call(
            &transport,
            &call,
            &inputs(&[("name", "rex")]),
            &empty_secrets(),
        )?;
        let sent = transport.requests.borrow();
        assert!(
            sent[0].method == HttpMethod::Put
                && sent[0]
                    .body
                    .as_deref()
                    .is_some_and(|body| body.contains(r#""name":"rex""#)),
            "PUT must carry the inputs as a JSON body; got: {:?}",
            sent.first()
        );
        Ok(())
    }

    #[test]
    fn patch_carries_a_json_body_and_the_method_reaches_the_wire() -> Result<(), RuntimeError> {
        let transport = stub(200, "{}");
        let call = HttpCall {
            method: HttpMethod::Patch,
            url: "https://api.example.test/v1/pets/p-7".to_owned(),
            headers: Vec::new(),
        };
        execute_http_call(
            &transport,
            &call,
            &inputs(&[("name", "rex")]),
            &empty_secrets(),
        )?;
        let sent = transport.requests.borrow();
        assert!(
            sent[0].method == HttpMethod::Patch
                && sent[0]
                    .body
                    .as_deref()
                    .is_some_and(|body| body.contains(r#""name":"rex""#)),
            "PATCH must carry the inputs as a JSON body; got: {:?}",
            sent.first()
        );
        Ok(())
    }

    #[test]
    fn delete_maps_inputs_to_the_query_with_no_body() -> Result<(), RuntimeError> {
        let transport = stub(200, "{}");
        let call = HttpCall {
            method: HttpMethod::Delete,
            url: "https://api.example.test/v1/pets".to_owned(),
            headers: Vec::new(),
        };
        execute_http_call(
            &transport,
            &call,
            &inputs(&[("id", "p-7")]),
            &empty_secrets(),
        )?;
        let sent = transport.requests.borrow();
        assert!(
            sent[0].method == HttpMethod::Delete
                && sent[0].url.contains("id=p-7")
                && sent[0].body.is_none(),
            "DELETE inputs must go on the query string with no body; got: {:?}",
            sent.first()
        );
        Ok(())
    }

    #[test]
    fn caller_headers_reach_the_wire_and_post_keeps_an_explicit_content_type()
    -> Result<(), RuntimeError> {
        let transport = stub(200, "{}");
        let call = HttpCall {
            method: HttpMethod::Post,
            url: "https://api.example.test/v1/pets".to_owned(),
            headers: vec![
                RuntimeHttpHeader::new("authorization", "Bearer t"),
                RuntimeHttpHeader::new("content-type", "application/cbor"),
            ],
        };
        execute_http_call(
            &transport,
            &call,
            &inputs(&[("name", "rex")]),
            &empty_secrets(),
        )?;
        let sent = transport.requests.borrow();
        let content_types = sent[0]
            .headers
            .iter()
            .filter(|header| header.name.eq_ignore_ascii_case("content-type"))
            .count();
        assert!(
            sent[0]
                .headers
                .iter()
                .any(|header| header.name == "authorization" && header.value == "Bearer t")
                && content_types == 1,
            "caller headers must pass through and an explicit content-type must not be duplicated; got: {:?}",
            sent[0].headers
        );
        Ok(())
    }

    #[test]
    fn substitute_secrets_resolves_a_delivered_secret_and_fails_closed_on_a_missing_one()
    -> Result<(), RuntimeError> {
        let delivery = crate::credentials::CredentialDelivery::from_local_descriptor(
            "example-provider",
            "api_key",
            "EXAMPLE_API_TOKEN",
            "ref-1",
            Vec::new(),
            "example_secret",
        )
        .map_err(|error| failure(format!("building the test credential delivery: {error}")))?;
        let secrets = delivery.secret_env();
        assert_eq!(
            substitute_secrets("Bearer ${secret:EXAMPLE_API_TOKEN}", secrets)?,
            "Bearer example_secret"
        );
        assert!(
            substitute_secrets("Bearer ${secret:MISSING}", secrets).is_err(),
            "a reference to an undelivered secret must fail closed"
        );
        Ok(())
    }

    #[test]
    fn credential_delivery_observation_is_recorded_on_http_output() -> Result<(), RuntimeError> {
        let delivery = crate::credentials::CredentialDelivery::from_local_descriptor(
            "example-provider",
            "api_key",
            "EXAMPLE_API_TOKEN",
            "ref-1",
            vec!["read".to_owned()],
            "example_secret",
        )
        .map_err(|error| failure(format!("building the test credential delivery: {error}")))?;
        let mut output = SkillOutput {
            status: InvocationStatus::Success,
            stdout: "{}".to_owned(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 0,
            metadata: JsonObject::new(),
        };

        add_credential_delivery_metadata(&mut output, &delivery)?;

        assert!(matches!(
            output.metadata.get(CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA),
            Some(JsonValue::Array(values)) if values.len() == 1
        ));
        assert!(
            !serde_json::to_string(&output.metadata)
                .unwrap_or_default()
                .contains("example_secret"),
            "HTTP credential metadata must not expose raw secret material"
        );
        Ok(())
    }

    #[test]
    fn non_2xx_is_a_failure_but_still_captures_the_body() -> Result<(), RuntimeError> {
        let transport = stub(404, "not found");
        let call = HttpCall {
            method: HttpMethod::Get,
            url: "https://api.example.test/v1/pets/none".to_owned(),
            headers: Vec::new(),
        };
        let output = execute_http_call(&transport, &call, &JsonObject::new(), &empty_secrets())?;
        assert_eq!(output.status, InvocationStatus::Failure);
        assert_eq!(output.stdout, "not found");
        Ok(())
    }

    #[test]
    fn status_300_is_the_failure_boundary() -> Result<(), RuntimeError> {
        let transport = stub(300, "multiple choices");
        let call = HttpCall {
            method: HttpMethod::Get,
            url: "https://api.example.test/v1/pets".to_owned(),
            headers: Vec::new(),
        };
        let output = execute_http_call(&transport, &call, &JsonObject::new(), &empty_secrets())?;
        assert_eq!(
            output.status,
            InvocationStatus::Failure,
            "the 2xx success range excludes 300; it must seal as a failure"
        );
        Ok(())
    }
}

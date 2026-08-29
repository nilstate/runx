#![allow(clippy::expect_used)]

use std::collections::BTreeMap;

use runx_contracts::{JsonObject, JsonValue};

use super::super::BatchMode;
use super::super::HttpBatchInput;
use super::{RequestAuth, admitted_hosts, execute_batch};
#[cfg(feature = "catalog")]
use crate::RuntimeEffectRegistry;
use crate::credentials::CredentialDelivery;
use crate::receipts::paths::RUNX_CWD_ENV;
use crate::tool_catalogs::native::NativeInvocation;

fn inputs(host: &str) -> HttpBatchInput {
    HttpBatchInput {
        requests: Vec::new(),
        allowed_hosts: vec![host.to_owned()],
        auth: None,
        stop_on_error: true,
    }
}

fn delivery() -> Result<CredentialDelivery, Box<dyn std::error::Error>> {
    Ok(CredentialDelivery::from_local_descriptor(
        "example",
        "bearer",
        "EXAMPLE_TOKEN",
        "local:example:test",
        vec!["example:read".to_owned()],
        "credential-sentinel",
    )?
    .bind_audience(Some("https://api.example.com"))?)
}

#[test]
fn native_http_credential_binding_cannot_be_widened_by_caller_hosts()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let env = BTreeMap::from([(
        RUNX_CWD_ENV.to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    )]);
    let inputs = inputs("attacker.example");
    let delivery = delivery()?;
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

    let error = admitted_hosts(
        &invocation,
        &RequestAuth::Bearer {
            secret_env: "EXAMPLE_TOKEN".to_owned(),
        },
    )
    .expect_err("caller-selected host must not widen credential binding");
    assert!(
        error
            .to_string()
            .contains("outside the resolved credential audience")
    );
    Ok(())
}

#[test]
fn native_http_credential_binding_requires_a_resolved_audience()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let env = BTreeMap::from([(
        RUNX_CWD_ENV.to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    )]);
    let inputs = inputs("api.example.com");
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

    let error = admitted_hosts(
        &invocation,
        &RequestAuth::Bearer {
            secret_env: "EXAMPLE_TOKEN".to_owned(),
        },
    )
    .expect_err("authenticated HTTP without a credential audience must fail closed");
    assert!(
        error
            .to_string()
            .contains("requires a resolved credential audience")
    );
    Ok(())
}

#[test]
fn native_http_credential_binding_accepts_an_exact_bound_host()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let env = BTreeMap::from([(
        RUNX_CWD_ENV.to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    )]);
    let inputs = inputs("api.example.com");
    let delivery = delivery()?;
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

    let hosts = admitted_hosts(
        &invocation,
        &RequestAuth::Bearer {
            secret_env: "EXAMPLE_TOKEN".to_owned(),
        },
    )?;
    assert!(hosts.contains("api.example.com"));
    Ok(())
}

#[cfg(feature = "catalog")]
#[test]
fn harness_http_exchanges_match_complete_requests_through_catalog()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = runx_parser::harness_fixture::parse_harness_fixture(
        r#"
name: exact-body-identity
kind: skill
target: ..
caller:
  http_exchanges:
    - request:
        method: POST
        url: https://API.Example.com/π
        body: none
      response: { status: 200, body: '{"case":"none"}' }
    - request:
        method: POST
        url: https://API.Example.com/π
        body: { json: null }
      response: { status: 200, body: '{"case":"null"}' }
    - request:
        method: DELETE
        url: https://API.Example.com/π
        body: { json: null }
      response: { status: 200, body: '{"case":"delete-null"}' }
    - request:
        method: GET
        url: https://API.Example.com/π
        body: { json: { query: state } }
      response: { status: 200, body: '{"case":"get-json"}' }
"#,
    )?;
    let exchanges = runx_parser::harness_fixture::parse_harness_http_exchanges(
        fixture.caller.get("http_exchanges"),
        "caller.http_exchanges",
    )?;
    assert!(
        exchanges
            .iter()
            .all(|exchange| exchange.request.url == "https://api.example.com/%CF%80")
    );
    let effects = crate::execution::harness::effects_with_harness_http(
        &RuntimeEffectRegistry::default(),
        &BTreeMap::new(),
        &exchanges,
    );
    let request = |id: &str, method: &str, body: Option<JsonValue>| {
        let mut request = JsonObject::from([
            ("id".to_owned(), JsonValue::String(id.to_owned())),
            ("method".to_owned(), JsonValue::String(method.to_owned())),
            (
                "url".to_owned(),
                JsonValue::String("https://api.example.com/%CF%80".to_owned()),
            ),
        ]);
        if let Some(body) = body {
            request.insert("body".to_owned(), body);
        }
        JsonValue::Object(request)
    };
    let inputs = HttpBatchInput {
        requests: vec![
            request("none", "POST", None),
            request("null", "POST", Some(JsonValue::Null)),
            request("delete-null", "DELETE", Some(JsonValue::Null)),
            request(
                "get-json",
                "GET",
                Some(JsonValue::Object(JsonObject::from([(
                    "query".to_owned(),
                    JsonValue::String("state".to_owned()),
                )]))),
            ),
        ],
        allowed_hosts: vec!["api.example.com".to_owned()],
        auth: None,
        stop_on_error: true,
    };
    let workspace = tempfile::tempdir()?;
    let env = BTreeMap::from([(
        RUNX_CWD_ENV.to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    )]);
    let delivery = delivery()?;
    let invocation = NativeInvocation {
        inputs: &inputs,
        observed_at: "2026-01-01T00:00:00Z",
        data_source_binding: None,
        env: &env,
        skill_directory: workspace.path(),
        credential_delivery: &delivery,
        local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
        effects: &effects,
    };

    let output = execute_batch(&invocation, BatchMode::Execute)?;
    let responses = output
        .as_object()
        .and_then(|output| output.get("http_execution"))
        .and_then(JsonValue::as_object)
        .and_then(|execution| execution.get("responses"))
        .and_then(JsonValue::as_array)
        .ok_or_else(|| std::io::Error::other("HTTP responses missing"))?;
    let response_case = |index: usize| {
        responses
            .get(index)
            .and_then(JsonValue::as_object)
            .and_then(|response| response.get("json"))
            .and_then(JsonValue::as_object)
            .and_then(|json| json.get("case"))
            .and_then(JsonValue::as_str)
    };
    assert_eq!(response_case(0), Some("none"));
    assert_eq!(response_case(1), Some("null"));
    assert_eq!(response_case(2), Some("delete-null"));
    assert_eq!(response_case(3), Some("get-json"));
    Ok(())
}

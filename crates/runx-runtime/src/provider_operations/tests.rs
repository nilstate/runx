use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::path::Path;

use super::*;
use crate::HostedApiEnvironment;
use crate::http::{
    RuntimeHttpError, RuntimeHttpRequest as HttpRequest, RuntimeHttpResponse as HttpResponse,
};

#[derive(Default)]
struct StubTransport {
    requests: RefCell<Vec<HttpRequest>>,
    responses: RefCell<Vec<HttpResponse>>,
    idempotent_requests: Cell<usize>,
}

impl StubTransport {
    fn with_responses(responses: Vec<HttpResponse>) -> Self {
        Self {
            requests: RefCell::new(Vec::new()),
            responses: RefCell::new(responses.into_iter().rev().collect()),
            idempotent_requests: Cell::new(0),
        }
    }
}

impl Transport for StubTransport {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, RuntimeHttpError> {
        self.requests.borrow_mut().push(request);
        self.responses
            .borrow_mut()
            .pop()
            .ok_or_else(|| RuntimeHttpError::Transport {
                message: "missing stub response".to_owned(),
            })
    }

    fn send_idempotent(&self, request: HttpRequest) -> Result<HttpResponse, RuntimeHttpError> {
        self.idempotent_requests
            .set(self.idempotent_requests.get().saturating_add(1));
        self.send(request)
    }
}

#[test]
fn provider_read_uses_only_the_idempotent_transport_lane() {
    let env = BTreeMap::from([("RUNX_PUBLIC_API_TOKEN".to_owned(), "rxk_test".to_owned())]);
    let transport = StubTransport::with_responses(vec![
        HttpResponse::new(
            200,
            serde_json::json!({
                "status": "success",
                "principal": {"principal_id": "operator:test"}
            })
            .to_string(),
        ),
        HttpResponse::new(
            200,
            serde_json::json!({
                "status": "success",
                "provider": "x402",
                "operation": "payment.x402.read",
                "target": "https://vendor.example/v1/invocations",
                "access": "read",
                "readback_ref": "runx:provider-readback:payment-1",
                "result": {"status": "settled"}
            })
            .to_string(),
        ),
    ]);
    let environment =
        HostedApiEnvironment::resolve(Some("https://api.runx.test"), None, &env, Path::new("."))
            .expect("environment")
            .authenticate(&transport)
            .expect("authenticated");

    invoke_provider_operation(
        &transport,
        &environment,
        &ProviderOperationRequest {
            grant_id: "grant_x402_1".to_owned(),
            operation: "payment.x402.read".to_owned(),
            target: "https://vendor.example/v1/invocations".to_owned(),
            scopes: vec!["payment.x402.read".to_owned()],
            input: JsonObject::new(),
            expected_access: Some(ProviderOperationAccess::Read),
        },
    )
    .expect("provider read");

    assert_eq!(transport.idempotent_requests.get(), 1);
}

#[test]
fn provider_operation_authenticates_and_returns_bounded_readback() {
    let env = BTreeMap::from([("RUNX_PUBLIC_API_TOKEN".to_owned(), "rxk_test".to_owned())]);
    let transport = StubTransport::with_responses(vec![
        HttpResponse::new(
            200,
            serde_json::json!({
                "status": "success",
                "principal": {"principal_id": "operator:test"}
            })
            .to_string(),
        ),
        HttpResponse::new(
            200,
            serde_json::json!({
                "status": "success",
                "provider": "slack",
                "operation": "thread.reply",
                "target": "slack://T/C/2",
                "access": "mutate",
                "operation_id": "provider-op-1",
                "idempotency_key": "runx:test-operation",
                "readback_ref": "runx:provider-readback:provider-op-1",
                "result": {"message_locator": "slack://T/C/2"}
            })
            .to_string(),
        ),
    ]);
    let environment =
        HostedApiEnvironment::resolve(Some("https://api.runx.test"), None, &env, Path::new("."))
            .expect("environment")
            .authenticate(&transport)
            .expect("authenticated");
    let response = invoke_provider_operation(
        &transport,
        &environment,
        &ProviderOperationRequest {
            grant_id: "grant_slack_1".to_owned(),
            operation: "thread.reply".to_owned(),
            target: "slack://T/C/2".to_owned(),
            scopes: vec!["thread.reply".to_owned()],
            input: JsonObject::from([(
                "idempotency_key".to_owned(),
                JsonValue::String("runx:test-operation".to_owned()),
            )]),
            expected_access: Some(ProviderOperationAccess::Mutate),
        },
    )
    .expect("provider operation");

    assert_eq!(
        response.get("provider").and_then(JsonValue::as_str),
        Some("slack")
    );
    assert_eq!(transport.requests.borrow().len(), 2);
    assert_eq!(transport.idempotent_requests.get(), 0);
    let request_body: JsonValue = serde_json::from_str(
        transport.requests.borrow()[1]
            .body
            .as_deref()
            .expect("provider operation body"),
    )
    .expect("provider operation JSON");
    let request_body = request_body
        .as_object()
        .expect("provider operation body must be an object");
    assert_eq!(
        request_body.get("scopes"),
        Some(&JsonValue::Array(vec![JsonValue::String(
            "thread.reply".to_owned(),
        )]))
    );
}

#[test]
fn provider_grant_listing_returns_only_bounded_authority_metadata() {
    let env = BTreeMap::from([("RUNX_PUBLIC_API_TOKEN".to_owned(), "rxk_test".to_owned())]);
    let transport = StubTransport::with_responses(vec![
        HttpResponse::new(
            200,
            serde_json::json!({
                "status": "success",
                "principal": {"principal_id": "operator:test"}
            })
            .to_string(),
        ),
        HttpResponse::new(
            200,
            serde_json::json!({
                "status": "success",
                "grants": [{
                    "grant_id": "grant_slack_1",
                    "provider": "slack",
                    "scopes": [
                        "channel.post",
                        "https://provider.example/auth/custom.scope?mode=read,write",
                        "opaque capability with spaces"
                    ],
                    "status": "active",
                    "credential_material_bound": true
                }]
            })
            .to_string(),
        ),
    ]);
    let environment =
        HostedApiEnvironment::resolve(Some("https://api.runx.test"), None, &env, Path::new("."))
            .expect("environment")
            .authenticate(&transport)
            .expect("authenticated");

    let grants = list_provider_grants(&transport, &environment).expect("grants");

    assert_eq!(
        grants,
        vec![HostedProviderGrant {
            grant_id: "grant_slack_1".to_owned(),
            provider: "slack".to_owned(),
            scopes: vec![
                "channel.post".to_owned(),
                "https://provider.example/auth/custom.scope?mode=read,write".to_owned(),
                "opaque capability with spaces".to_owned(),
            ],
            status: "active".to_owned(),
            target_locator: None,
        }]
    );
    let requests = transport.requests.borrow();
    assert_eq!(requests[1].method, HttpMethod::Get);
    assert_eq!(requests[1].url, "https://api.runx.test/v1/grants");
    assert!(requests[1].body.is_none());
}

#[test]
fn provider_operation_rejects_mismatched_readback() {
    let request = ProviderOperationRequest {
        grant_id: "grant_github_1".to_owned(),
        operation: "issue.read".to_owned(),
        target: "github://runxhq/runx/issues/1".to_owned(),
        scopes: vec!["repo.read".to_owned()],
        input: JsonObject::new(),
        expected_access: Some(ProviderOperationAccess::Read),
    };
    let error = parse_provider_operation_response(
        response_object(serde_json::json!({
            "status": "success",
            "provider": "github",
            "operation": "issue.write",
            "target": "github://runxhq/runx/issues/1",
            "result": {}
        })),
        &request,
    )
    .expect_err("mismatch");
    assert!(error.to_string().contains("does not match"));
}

#[test]
fn provider_operation_rejects_mismatched_access_before_trusting_result() {
    let request = ProviderOperationRequest {
        grant_id: "grant_slack_1".to_owned(),
        operation: "thread.reply".to_owned(),
        target: "slack://T/C/2".to_owned(),
        scopes: vec!["thread.reply".to_owned()],
        input: JsonObject::new(),
        expected_access: Some(ProviderOperationAccess::Read),
    };
    let error = parse_provider_operation_response(
        response_object(serde_json::json!({
            "status": "success",
            "provider": "slack",
            "operation": "thread.reply",
            "target": "slack://T/C/2",
            "access": "mutate",
            "result": {"message_locator": "slack://T/C/2"}
        })),
        &request,
    )
    .expect_err("access mismatch");
    assert!(error.to_string().contains("response access"));
}

#[test]
fn provider_operation_requires_explicit_success_status() {
    let request = ProviderOperationRequest {
        grant_id: "grant_slack_1".to_owned(),
        operation: "thread.read".to_owned(),
        target: "slack://T/C/2".to_owned(),
        scopes: vec!["thread.read".to_owned()],
        input: JsonObject::new(),
        expected_access: Some(ProviderOperationAccess::Read),
    };
    let error = parse_provider_operation_response(
        response_object(serde_json::json!({
            "provider": "slack",
            "operation": "thread.read",
            "target": "slack://T/C/2",
            "access": "read",
            "result": {"messages": []}
        })),
        &request,
    )
    .expect_err("missing success status must fail closed");

    assert!(error.to_string().contains("status is not success"));
}

#[test]
fn provider_operation_requires_readback_evidence() {
    let request = ProviderOperationRequest {
        grant_id: "grant_slack_1".to_owned(),
        operation: "thread.read".to_owned(),
        target: "slack://T/C/2".to_owned(),
        scopes: vec!["thread.read".to_owned()],
        input: JsonObject::new(),
        expected_access: Some(ProviderOperationAccess::Read),
    };
    let error = parse_provider_operation_response(
        response_object(serde_json::json!({
            "status": "success",
            "provider": "slack",
            "operation": "thread.read",
            "target": "slack://T/C/2",
            "access": "read",
            "result": {"messages": []}
        })),
        &request,
    )
    .expect_err("provider reads require readback evidence");

    assert!(error.to_string().contains("readback_ref"));
}

#[test]
fn provider_mutation_requires_matching_runtime_idempotency_evidence() {
    let request = ProviderOperationRequest {
        grant_id: "grant_slack_1".to_owned(),
        operation: "thread.reply".to_owned(),
        target: "slack://T/C/2".to_owned(),
        scopes: vec!["thread.reply".to_owned()],
        input: JsonObject::from([(
            "idempotency_key".to_owned(),
            JsonValue::String("runx:expected".to_owned()),
        )]),
        expected_access: Some(ProviderOperationAccess::Mutate),
    };
    let error = parse_provider_operation_response(
        response_object(serde_json::json!({
            "status": "success",
            "provider": "slack",
            "operation": "thread.reply",
            "target": "slack://T/C/2",
            "access": "mutate",
            "operation_id": "provider-op-1",
            "idempotency_key": "caller-controlled",
            "readback_ref": "runx:provider-readback:provider-op-1",
            "result": {"message_locator": "slack://T/C/2"}
        })),
        &request,
    )
    .expect_err("mismatched provider idempotency must fail closed");

    assert!(error.to_string().contains("runtime-derived request key"));
}

fn response_object(value: serde_json::Value) -> JsonObject {
    serde_json::from_value::<JsonValue>(value)
        .expect("provider response fixture must convert")
        .as_object()
        .expect("provider response fixture must be an object")
        .clone()
}

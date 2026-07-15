//! Provider-neutral native client for the runx Connect service.
//!
//! OAuth custody and bounded provider calls stay in Cloud. The native CLI owns
//! environment/principal resolution and exposes the same generic grant and
//! operation contract for Slack or any other provider driver.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::process::ExitCode;

use runx_runtime::registry::{
    HttpMethod, HttpRequest, HttpResponse, RuntimeHttpError, RuntimeHttpHeader, Transport,
};
use serde_json::{Map, Value};

mod plan;

pub use plan::{
    ConnectAction, ConnectInvokePlan, ConnectPlan, ConnectStartPlan, parse_connect_plan,
};

pub fn run_native_connect(plan: ConnectPlan) -> ExitCode {
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => return fail(&plan, &format!("failed to resolve cwd: {error}")),
    };
    let env = crate::history::env_map();
    let transport = match crate::public_api::transport(crate::public_api::private_network_allowed(
        plan.allow_local_api,
        &env,
    )) {
        Ok(transport) => transport,
        Err(error) => {
            return fail(
                &plan,
                &format!("failed to initialize HTTP transport: {error}"),
            );
        }
    };
    match run_connect_with_transport(&plan, &env, &cwd, &transport) {
        Ok(output) => crate::cli_io::write_stdout_code(&output, 0),
        Err(error) => fail(&plan, &error.to_string()),
    }
}

fn run_connect_with_transport<T: Transport>(
    plan: &ConnectPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
    transport: &T,
) -> Result<String, ConnectError> {
    let environment = crate::public_api::ApiEnvironment::resolve(
        plan.api_base_url.as_deref(),
        plan.token.as_deref(),
        env,
        cwd,
    )
    .map_err(|error| ConnectError::Environment(error.to_string()))?;
    let authenticated = environment
        .authenticate(transport)
        .map_err(|error| ConnectError::Environment(error.to_string()))?;
    let response = send_connect_request(
        transport,
        authenticated.base_url(),
        authenticated.token(),
        &plan.action,
    )?;
    render_connect_result(
        plan.json,
        authenticated.base_url(),
        authenticated.principal_id(),
        &plan.action,
        response,
    )
}

fn send_connect_request<T: Transport>(
    transport: &T,
    base_url: &str,
    token: &str,
    action: &ConnectAction,
) -> Result<Value, ConnectError> {
    let (method, path, body) = connect_request(action);
    let mut headers = vec![RuntimeHttpHeader::new(
        "authorization",
        format!("Bearer {token}"),
    )];
    if body.is_some() {
        headers.push(RuntimeHttpHeader::new("content-type", "application/json"));
    }
    let response = transport.send(HttpRequest {
        method,
        url: format!("{base_url}{path}"),
        headers,
        body: body.map(|value| value.to_string()),
    })?;
    parse_connect_response(response)
}

fn connect_request(action: &ConnectAction) -> (HttpMethod, String, Option<Value>) {
    match action {
        ConnectAction::List => (HttpMethod::Get, "/v1/grants".to_owned(), None),
        ConnectAction::Status { session_id } => (
            HttpMethod::Get,
            format!("/v1/connect/sessions/{session_id}"),
            None,
        ),
        ConnectAction::Revoke { grant_id } => {
            (HttpMethod::Delete, format!("/v1/grants/{grant_id}"), None)
        }
        ConnectAction::Start(start) => {
            let mut body = Map::new();
            body.insert("provider".to_owned(), Value::String(start.provider.clone()));
            body.insert(
                "scopes".to_owned(),
                Value::Array(start.scopes.iter().cloned().map(Value::String).collect()),
            );
            insert_optional(&mut body, "scope_family", start.scope_family.as_deref());
            insert_optional(&mut body, "authority_kind", start.authority_kind.as_deref());
            insert_optional(&mut body, "target_repo", start.target_repo.as_deref());
            insert_optional(&mut body, "target_locator", start.target_locator.as_deref());
            insert_optional(&mut body, "binding_id", start.binding_id.as_deref());
            (
                HttpMethod::Post,
                "/v1/connect/sessions".to_owned(),
                Some(Value::Object(body)),
            )
        }
        ConnectAction::Invoke(invoke) => (
            HttpMethod::Post,
            "/v1/provider-operations".to_owned(),
            Some(serde_json::json!({
                "grant_id": invoke.grant_id,
                "operation": invoke.operation,
                "input": invoke.input,
            })),
        ),
    }
}

fn insert_optional(body: &mut Map<String, Value>, field: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        body.insert(field.to_owned(), Value::String(value.to_owned()));
    }
}

fn parse_connect_response(response: HttpResponse) -> Result<Value, ConnectError> {
    if !(200..=299).contains(&response.status) {
        let detail = crate::public_api::parse_error(&response.body)
            .map(|error| error.detail)
            .unwrap_or(response.body);
        return Err(ConnectError::HttpStatus {
            status: response.status,
            detail,
        });
    }
    serde_json::from_str(&response.body)
        .map_err(|error| ConnectError::InvalidJson(error.to_string()))
}

fn render_connect_result(
    json: bool,
    base_url: &str,
    principal_id: &str,
    action: &ConnectAction,
    response: Value,
) -> Result<String, ConnectError> {
    if json {
        return serde_json::to_string_pretty(&serde_json::json!({
            "status": "success",
            "environment": {
                "base_url": base_url,
                "principal_id": principal_id,
            },
            "connect": response,
        }))
        .map(|serialized| format!("{serialized}\n"))
        .map_err(|error| ConnectError::InvalidJson(error.to_string()));
    }
    let body = match action {
        ConnectAction::List => render_grants(&response)?,
        ConnectAction::Start(_) => render_start(&response),
        ConnectAction::Status { .. } | ConnectAction::Revoke { .. } => pretty_json(&response)?,
        ConnectAction::Invoke(_) => render_invoke(&response)?,
    };
    let mut output = format!("runx connect · {principal_id} · {base_url}\n");
    output.push_str(&body);
    Ok(output)
}

fn render_grants(response: &Value) -> Result<String, ConnectError> {
    let grants = response
        .get("grants")
        .and_then(Value::as_array)
        .ok_or_else(|| ConnectError::InvalidJson("grants array is missing".to_owned()))?;
    if grants.is_empty() {
        return Ok("no grants\n".to_owned());
    }
    let rows = grants.iter().map(|grant| {
        let provider = string_field(grant, "provider").unwrap_or("unknown");
        let grant_id = string_field(grant, "grant_id").unwrap_or("unknown");
        let status = string_field(grant, "status").unwrap_or("unknown");
        let scopes = grant
            .get("scopes")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        format!("{provider}  {status}  {grant_id}  {scopes}\n")
    });
    Ok(rows.collect())
}

fn render_start(response: &Value) -> String {
    let mut output = format!(
        "status: {}\n",
        string_field(response, "status").unwrap_or("unknown")
    );
    if let Some(session_id) = string_field(response, "session_id") {
        output.push_str(&format!("session: {session_id}\n"));
    }
    if let Some(url) = string_field(response, "authorization_url") {
        output.push_str(&format!("authorize: {url}\n"));
    }
    if let Some(grant_id) = response
        .get("grant")
        .and_then(|grant| string_field(grant, "grant_id"))
    {
        output.push_str(&format!("grant: {grant_id}\n"));
    }
    output
}

fn render_invoke(response: &Value) -> Result<String, ConnectError> {
    let provider = string_field(response, "provider").unwrap_or("provider");
    let operation = string_field(response, "operation").unwrap_or("operation");
    let result = pretty_json(response.get("result").unwrap_or(&Value::Null))?;
    Ok(format!("{provider} {operation}\n{result}"))
}

fn pretty_json(value: &Value) -> Result<String, ConnectError> {
    serde_json::to_string_pretty(value)
        .map(|serialized| format!("{serialized}\n"))
        .map_err(|error| ConnectError::InvalidJson(error.to_string()))
}

fn string_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn fail(plan: &ConnectPlan, message: &str) -> ExitCode {
    if plan.json {
        return crate::cli_io::write_stdout_code(
            &crate::router::json_failure_output(message, "connect_failed"),
            1,
        );
    }
    let _ignored = crate::cli_io::write_stderr(&format!("runx connect: {message}\n"));
    ExitCode::from(1)
}

#[derive(Debug)]
enum ConnectError {
    Environment(String),
    RuntimeHttp(RuntimeHttpError),
    HttpStatus { status: u16, detail: String },
    InvalidJson(String),
}

impl fmt::Display for ConnectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Environment(message) => formatter.write_str(message),
            Self::RuntimeHttp(error) => write!(formatter, "{error}"),
            Self::HttpStatus { status, detail } => {
                write!(formatter, "Connect API returned HTTP {status}: {detail}")
            }
            Self::InvalidJson(message) => {
                write!(formatter, "Connect API returned invalid JSON: {message}")
            }
        }
    }
}

impl std::error::Error for ConnectError {}

impl From<RuntimeHttpError> for ConnectError {
    fn from(error: RuntimeHttpError) -> Self {
        Self::RuntimeHttp(error)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use runx_runtime::registry::RuntimeHttpError;

    use super::*;

    #[derive(Default)]
    struct StubTransport {
        requests: RefCell<Vec<HttpRequest>>,
        responses: RefCell<Vec<HttpResponse>>,
    }

    impl StubTransport {
        fn with_responses(responses: Vec<HttpResponse>) -> Self {
            Self {
                requests: RefCell::new(Vec::new()),
                responses: RefCell::new(responses.into_iter().rev().collect()),
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
    }

    #[test]
    fn parses_provider_neutral_invoke() -> Result<(), String> {
        let plan = parse_connect_plan(&[
            "connect".into(),
            "invoke".into(),
            "--grant".into(),
            "grant_slack_1".into(),
            "--operation".into(),
            "thread.reply".into(),
            "--input".into(),
            r#"{"thread_locator":"slack://T/C/1","text":"Done"}"#.into(),
            "--json".into(),
        ])?;

        let ConnectAction::Invoke(invoke) = plan.action else {
            return Err("expected invoke action".to_owned());
        };
        assert_eq!(invoke.operation, "thread.reply");
        assert_eq!(
            invoke.input.get("text").and_then(Value::as_str),
            Some("Done")
        );
        Ok(())
    }

    #[test]
    fn rejects_unsafe_path_identifiers_and_invalid_operations() {
        let unsafe_grant = parse_connect_plan(&[
            "connect".into(),
            "revoke".into(),
            "../another-principal".into(),
        ]);
        assert!(unsafe_grant.is_err());

        let invalid_operation = parse_connect_plan(&[
            "connect".into(),
            "invoke".into(),
            "--grant".into(),
            "grant_slack_1".into(),
            "--operation".into(),
            "Thread Reply".into(),
        ]);
        assert!(invalid_operation.is_err());
    }

    #[test]
    fn authenticated_environment_and_operation_use_one_principal()
    -> Result<(), Box<dyn std::error::Error>> {
        let home = std::env::temp_dir().join(format!("runx-connect-test-{}", std::process::id()));
        std::fs::create_dir_all(&home)?;
        let env = BTreeMap::from([
            ("RUNX_HOME".to_owned(), home.to_string_lossy().into_owned()),
            ("RUNX_PUBLIC_API_TOKEN".to_owned(), "rxk_test".to_owned()),
        ]);
        let transport = StubTransport::with_responses(vec![
            HttpResponse {
                status: 200,
                body: serde_json::json!({
                    "status": "success",
                    "principal": {"principal_id": "kam", "role": "user"}
                })
                .to_string(),
            },
            HttpResponse {
                status: 200,
                body: serde_json::json!({
                    "status": "success",
                    "provider": "slack",
                    "operation": "thread.reply",
                    "result": {"message_locator": "slack://T/C/2"}
                })
                .to_string(),
            },
        ]);
        let plan = ConnectPlan {
            action: ConnectAction::Invoke(ConnectInvokePlan {
                grant_id: "grant_slack_1".to_owned(),
                operation: "thread.reply".to_owned(),
                input: Map::new(),
            }),
            api_base_url: Some("https://api.runx.test".to_owned()),
            token: None,
            allow_local_api: false,
            json: true,
        };

        let output = run_connect_with_transport(&plan, &env, &home, &transport)?;

        assert!(output.contains("\"principal_id\": \"kam\""));
        let requests = transport.requests.borrow();
        assert_eq!(requests[0].url, "https://api.runx.test/v1/me");
        assert_eq!(
            requests[1].url,
            "https://api.runx.test/v1/provider-operations"
        );
        assert!(
            requests
                .iter()
                .all(|request| request.headers.iter().any(|header| {
                    header.name == "authorization" && header.value == "Bearer rxk_test"
                }))
        );
        Ok(())
    }
}

//! Provider-neutral CLI presentation for Runx Connect grant administration.
//!
//! OAuth custody and bounded provider calls stay in Cloud. The native CLI owns
//! environment/principal resolution and grant setup, inspection, and revocation.
//! Provider calls execute only inside governed skills through native
//! `provider.read` and `provider.mutate` tools.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::process::ExitCode;

use runx_runtime::{
    HostedApiOperationError, HostedConnectAction, HostedConnectStart,
    RuntimeHttpTransport as Transport, WorkspaceEnv,
};
use serde_json::Value;

mod plan;

pub use plan::{ConnectAction, ConnectPlan, ConnectStartPlan, parse_connect_plan};

pub fn run_native_connect(plan: ConnectPlan, workspace: &WorkspaceEnv) -> ExitCode {
    let transport = match runx_runtime::hosted_api_transport(
        runx_runtime::hosted_private_network_allowed(plan.allow_local_api, workspace.env()),
    ) {
        Ok(transport) => transport,
        Err(error) => {
            return fail(
                &plan,
                &format!("failed to initialize HTTP transport: {error}"),
            );
        }
    };
    match run_connect_with_transport(&plan, workspace.env(), workspace.cwd(), &transport) {
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
    let environment = runx_runtime::HostedApiEnvironment::resolve(
        plan.api_base_url.as_deref(),
        plan.token.as_deref(),
        env,
        cwd,
    )
    .map_err(|error| ConnectError::Environment(error.to_string()))?;
    let authenticated = environment
        .authenticate(transport)
        .map_err(|error| ConnectError::Environment(error.to_string()))?;
    let response = runx_runtime::execute_hosted_connect(
        transport,
        &authenticated,
        hosted_connect_action(&plan.action),
    )?;
    render_connect_result(
        plan.json,
        authenticated.base_url(),
        authenticated.principal_id(),
        &plan.action,
        response,
    )
}

fn hosted_connect_action(action: &ConnectAction) -> HostedConnectAction<'_> {
    match action {
        ConnectAction::List => HostedConnectAction::List,
        ConnectAction::Status { session_id } => HostedConnectAction::Status { session_id },
        ConnectAction::Revoke { grant_id } => HostedConnectAction::Revoke { grant_id },
        ConnectAction::Start(start) => HostedConnectAction::Start(HostedConnectStart {
            provider: &start.provider,
            scopes: &start.scopes,
            scope_family: start.scope_family.as_deref(),
            authority_kind: start.authority_kind.as_deref(),
            target_repo: start.target_repo.as_deref(),
            target_locator: start.target_locator.as_deref(),
            binding_id: start.binding_id.as_deref(),
        }),
    }
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
    Operation(HostedApiOperationError),
    InvalidJson(String),
}

impl fmt::Display for ConnectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Environment(message) => formatter.write_str(message),
            Self::Operation(error) => write!(formatter, "{error}"),
            Self::InvalidJson(message) => {
                write!(formatter, "Connect API returned invalid JSON: {message}")
            }
        }
    }
}

impl std::error::Error for ConnectError {}

impl From<HostedApiOperationError> for ConnectError {
    fn from(error: HostedApiOperationError) -> Self {
        Self::Operation(error)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use runx_runtime::{
        HttpMethod, RuntimeHttpError, RuntimeHttpRequest, RuntimeHttpResponse, RuntimeHttpTransport,
    };

    use super::*;

    #[test]
    fn rejects_unsafe_path_identifiers_and_raw_provider_invocation() {
        let unsafe_grant = parse_connect_plan(&[
            "connect".into(),
            "revoke".into(),
            "../another-principal".into(),
        ]);
        assert!(unsafe_grant.is_err());

        let raw_invocation = parse_connect_plan(&[
            "connect".into(),
            "invoke".into(),
            "--grant".into(),
            "grant_slack_1".into(),
        ]);
        assert!(raw_invocation.is_err());
    }

    #[test]
    fn connect_list_uses_authenticated_runtime_service() -> Result<(), Box<dyn std::error::Error>> {
        let transport = StubTransport::new(vec![
            RuntimeHttpResponse::new(
                200,
                serde_json::json!({
                    "status": "success",
                    "principal": {"principal_id": "user_1"}
                })
                .to_string(),
            ),
            RuntimeHttpResponse::new(
                200,
                serde_json::json!({"status": "success", "grants": []}).to_string(),
            ),
        ]);
        let plan = ConnectPlan {
            action: ConnectAction::List,
            api_base_url: Some("https://runx.test/".to_owned()),
            token: Some("rxk_test".to_owned()),
            allow_local_api: false,
            json: true,
        };

        let output =
            run_connect_with_transport(&plan, &BTreeMap::new(), &std::env::temp_dir(), &transport)?;

        assert!(output.contains("\"connect\""));
        let requests = transport.requests.borrow();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].url, "https://runx.test/v1/me");
        assert_eq!(requests[1].url, "https://runx.test/v1/grants");
        assert_eq!(requests[1].method, HttpMethod::Get);
        Ok(())
    }

    #[test]
    fn connect_start_passes_opaque_skill_scopes_unchanged() -> Result<(), Box<dyn std::error::Error>>
    {
        let scopes = [
            "vendor.operation:v3".to_owned(),
            "https://provider.example/auth/custom.scope".to_owned(),
            "urn:runx:test:opaque".to_owned(),
            "opaque capability with spaces,commas".to_owned(),
            "vendor.operation:v3".to_owned(),
        ];
        let plan = parse_connect_plan(&[
            "connect".into(),
            "start".into(),
            "future-provider".into(),
            "--scope".into(),
            scopes[0].clone().into(),
            "--scope".into(),
            scopes[1].clone().into(),
            "--scope".into(),
            scopes[2].clone().into(),
            "--scope".into(),
            scopes[3].clone().into(),
            "--scope".into(),
            scopes[4].clone().into(),
            "--api-base-url".into(),
            "https://runx.test/".into(),
            "--token".into(),
            "rxk_test".into(),
            "--json".into(),
        ])?;
        let transport = StubTransport::new(vec![
            RuntimeHttpResponse::new(
                200,
                serde_json::json!({
                    "status": "success",
                    "principal": {"principal_id": "user_1"}
                })
                .to_string(),
            ),
            // The CLI treats the hosted start status as an opaque string; the
            // stub deliberately avoids private broker vocabulary.
            RuntimeHttpResponse::new(
                201,
                serde_json::json!({
                    "status": "pending",
                    "session_id": "flow_1"
                })
                .to_string(),
            ),
        ]);

        run_connect_with_transport(&plan, &BTreeMap::new(), &std::env::temp_dir(), &transport)?;

        let requests = transport.requests.borrow();
        let body = requests[1]
            .body
            .as_deref()
            .ok_or("connect start request body missing")?;
        let request: serde_json::Value = serde_json::from_str(body)?;
        assert_eq!(request["provider"], "future-provider");
        assert_eq!(request["scopes"], serde_json::json!(scopes));
        Ok(())
    }

    struct StubTransport {
        requests: RefCell<Vec<RuntimeHttpRequest>>,
        responses: RefCell<Vec<RuntimeHttpResponse>>,
    }

    impl StubTransport {
        fn new(responses: Vec<RuntimeHttpResponse>) -> Self {
            Self {
                requests: RefCell::new(Vec::new()),
                responses: RefCell::new(responses.into_iter().rev().collect()),
            }
        }
    }

    impl RuntimeHttpTransport for StubTransport {
        fn send(
            &self,
            request: RuntimeHttpRequest,
        ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
            self.requests.borrow_mut().push(request);
            self.responses
                .borrow_mut()
                .pop()
                .ok_or_else(|| RuntimeHttpError::Transport {
                    message: "missing stub response".to_owned(),
                })
        }
    }
}

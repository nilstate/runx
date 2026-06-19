#![cfg(feature = "mcp")]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use runx_contracts::{JsonNumber, JsonObject, JsonValue};
use runx_parser::{SkillMcpServer, SkillSandbox, SkillSource};
use runx_runtime::adapters::mcp::{
    McpAdapter, McpListToolsRequest, McpToolCallRequest, McpTransport, McpTransportError,
    ProcessMcpTransport, map_mcp_arguments,
};
use runx_runtime::sandbox::SandboxPlan;
use runx_runtime::{InvocationStatus, RuntimeError, SkillAdapter, SkillInvocation};
use serde::Deserialize;

const RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV: &str = "RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY";
const RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_VALUE: &str = "local";

#[test]
fn mcp_argument_templates_map_structured_and_embedded_values() -> Result<(), RuntimeError> {
    let mut inputs = JsonObject::new();
    inputs.insert("name".to_owned(), JsonValue::String("Ada".to_owned()));
    inputs.insert("count".to_owned(), JsonValue::Number(JsonNumber::U64(3)));

    let mut nested = JsonObject::new();
    nested.insert("ok".to_owned(), JsonValue::Bool(true));

    let mut resolved_inputs = JsonObject::new();
    resolved_inputs.insert("payload".to_owned(), JsonValue::Object(nested.clone()));

    let mut template = JsonObject::new();
    template.insert(
        "exact".to_owned(),
        JsonValue::String("{{ payload }}".to_owned()),
    );
    template.insert(
        "embedded".to_owned(),
        JsonValue::String("hello {{name}} #{{ count }}".to_owned()),
    );
    template.insert(
        "invalid".to_owned(),
        JsonValue::String("keep {{ not valid }}".to_owned()),
    );

    let mapped = map_mcp_arguments(Some(&template), &inputs, &resolved_inputs)?;

    assert_eq!(mapped.get("exact"), Some(&JsonValue::Object(nested)));
    assert_eq!(
        mapped.get("embedded"),
        Some(&JsonValue::String("hello Ada #3".to_owned()))
    );
    assert_eq!(
        mapped.get("invalid"),
        Some(&JsonValue::String("keep {{ not valid }}".to_owned()))
    );
    Ok(())
}

#[test]
fn mcp_adapter_clamps_min_timeout_and_sanitizes_tool_error() -> Result<(), RuntimeError> {
    let seen = Arc::new(Mutex::new(None));
    let adapter = McpAdapter::new(TimeoutProbeTransport {
        seen: Arc::clone(&seen),
    });
    let mut inputs = JsonObject::new();
    inputs.insert(
        "secret".to_owned(),
        JsonValue::String("sk-live-do-not-leak".to_owned()),
    );

    let output = adapter.invoke(invocation("fail", Some(0), inputs))?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(output.stderr, "MCP tool returned error -32000.");
    assert!(!output.stderr.contains("sk-live-do-not-leak"));
    let seen_timeout = seen
        .lock()
        .map_err(|_| runtime_test_error("timeout probe poisoned"))?;
    assert_eq!(*seen_timeout, Some(Duration::from_millis(50)));
    Ok(())
}

#[test]
fn mcp_adapter_malformed_json_response_is_sanitized() -> Result<(), RuntimeError> {
    let adapter = McpAdapter::new(ProcessMcpTransport::default());
    let mut inputs = JsonObject::new();
    inputs.insert(
        "secret".to_owned(),
        JsonValue::String("malformed-json-secret".to_owned()),
    );
    let mut request = invocation("malformed-json", Some(1), inputs);
    let Some(server) = request.source.server.as_mut() else {
        unreachable!("test invocation always includes MCP server metadata");
    };
    server.command = "/bin/sh".to_owned();
    server.args = vec![
        "-c".to_owned(),
        "IFS= read -r _ || true; printf 'Content-Length: 1\\r\\n\\r\\n{'; sleep 1".to_owned(),
    ];

    let output = adapter.invoke(request)?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(output.stderr, "MCP adapter failed.");
    assert!(!output.stderr.contains("malformed-json-secret"));
    assert!(output.stdout.is_empty());
    assert_eq!(output.exit_code, None);
    Ok(())
}

#[test]
fn mcp_process_transport_lists_fixture_tools_over_stdio() -> Result<(), RuntimeError> {
    let tools = ProcessMcpTransport::default()
        .list_tools(McpListToolsRequest {
            server: fixture_server()?,
            timeout: Duration::from_secs(5),
            sandbox: fixture_sandbox_plan()?,
        })
        .map_err(|error| runtime_test_error(error.sanitized_message()))?;

    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        [
            "echo",
            "fail",
            "sleep",
            "env",
            "max-response",
            "oversized-response"
        ]
    );
    let Some(echo) = tools.iter().find(|tool| tool.name == "echo") else {
        return Err(runtime_test_error("echo tool is listed"));
    };
    assert_eq!(
        echo.description.as_deref(),
        Some("Echo a message through the fixture MCP server.")
    );
    let Some(schema) = echo.input_schema.as_ref() else {
        return Err(runtime_test_error("echo input schema"));
    };
    assert_eq!(
        schema.get("required"),
        Some(&JsonValue::Array(vec![JsonValue::String(
            "message".to_owned()
        )]))
    );
    Ok(())
}

#[test]
fn mcp_process_transport_calls_fixture_echo_over_stdio() -> Result<(), RuntimeError> {
    let adapter = McpAdapter::new(ProcessMcpTransport::default());
    let mut inputs = JsonObject::new();
    inputs.insert(
        "message".to_owned(),
        JsonValue::String("hello from rust mcp".to_owned()),
    );

    let output = adapter.invoke(fixture_invocation("echo", Some(5), inputs)?)?;

    assert_eq!(output.status, InvocationStatus::Success);
    assert_eq!(output.stdout, "hello from rust mcp");
    assert_eq!(output.stderr, "");
    assert_eq!(output.exit_code, Some(0));
    assert_eq!(
        output.metadata.get("mcp").and_then(|value| match value {
            JsonValue::Object(mcp) => mcp.get("tool"),
            _ => None,
        }),
        Some(&JsonValue::String("echo".to_owned()))
    );
    Ok(())
}

#[test]
fn mcp_process_transport_reuses_session_for_matching_scope() -> Result<(), RuntimeError> {
    let marker_path = lifecycle_marker_path("session-reuse")?;
    let transport = ProcessMcpTransport::default();
    reset_transport_session_pool(&transport)?;
    transport.reset_spawn_count();
    let adapter = McpAdapter::new(transport.clone());

    let first = adapter.invoke(session_marker_invocation(
        &marker_path,
        "same-scope",
        "first",
    )?)?;
    let second = adapter.invoke(session_marker_invocation(
        &marker_path,
        "same-scope",
        "second",
    )?)?;
    assert_eq!(first.status, InvocationStatus::Success);
    assert_eq!(first.stdout, "first");
    assert_eq!(second.status, InvocationStatus::Success);
    assert_eq!(second.stdout, "second");
    assert_eq!(transport.spawned_process_count(), 1);

    reset_transport_session_pool(&transport)?;
    let _ = fs::remove_file(&marker_path);
    Ok(())
}

#[test]
fn mcp_session_isolation_by_environment_scope() -> Result<(), RuntimeError> {
    let marker_path = lifecycle_marker_path("session-scope")?;
    let transport = ProcessMcpTransport::default();
    reset_transport_session_pool(&transport)?;
    transport.reset_spawn_count();
    let adapter = McpAdapter::new(transport.clone());

    let first = adapter.invoke(session_marker_invocation(&marker_path, "scope-a", "first")?)?;
    let second = adapter.invoke(session_marker_invocation(
        &marker_path,
        "scope-b",
        "second",
    )?)?;

    assert_eq!(first.status, InvocationStatus::Success);
    assert_eq!(second.status, InvocationStatus::Success);
    assert_eq!(transport.spawned_process_count(), 2);

    reset_transport_session_pool(&transport)?;
    let _ = fs::remove_file(&marker_path);
    Ok(())
}

#[test]
fn mcp_session_isolation_rejects_process_env_secret_delivery() -> Result<(), RuntimeError> {
    let mut inputs = JsonObject::new();
    inputs.insert("name".to_owned(), JsonValue::String("API_KEY".to_owned()));
    let mut request = fixture_invocation("env", Some(5), inputs)?;
    request.credential_delivery = runx_runtime::CredentialDelivery::from_local_descriptor(
        "github",
        "api_key",
        "API_KEY",
        "local:github:test",
        vec!["repo:read".to_owned()],
        "mcp-secret-value",
    )
    .map_err(|error| runtime_test_error(error.to_string()))?;

    let transport = ProcessMcpTransport::default();
    transport.reset_spawn_count();

    let output = McpAdapter::new(transport.clone()).invoke(request)?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(output.stderr, "MCP adapter failed.");
    assert!(!output.stderr.contains("mcp-secret-value"));
    assert_eq!(transport.spawned_process_count(), 0);
    Ok(())
}

#[test]
fn mcp_process_transport_times_out_and_terminates_child() -> Result<(), RuntimeError> {
    let marker_path = lifecycle_marker_path("timeout-child")?;
    let mut inputs = JsonObject::new();
    inputs.insert(
        "markerPath".to_owned(),
        JsonValue::String(marker_path.to_string_lossy().into_owned()),
    );

    let output = McpAdapter::new(ProcessMcpTransport::default()).invoke(fixture_invocation(
        "sleep",
        Some(1),
        inputs,
    )?)?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(output.stdout, "");
    assert_eq!(output.stderr, "MCP call timed out after 1000ms.");
    assert_eq!(output.exit_code, None);

    let line_count_after_timeout =
        wait_for_lifecycle_lines(&marker_path, 2, Duration::from_secs(1))?;
    thread::sleep(Duration::from_millis(150));
    assert_eq!(
        lifecycle_line_count(&marker_path)?,
        line_count_after_timeout,
        "timed-out MCP server child stopped writing heartbeats"
    );

    let _ = fs::remove_file(&marker_path);
    Ok(())
}

#[test]
fn mcp_process_transport_accepts_response_body_at_size_limit() -> Result<(), RuntimeError> {
    let adapter = McpAdapter::new(ProcessMcpTransport::default());

    let output = adapter.invoke(fixture_invocation(
        "max-response",
        Some(5),
        JsonObject::new(),
    )?)?;

    assert_eq!(output.status, InvocationStatus::Success);
    assert!(output.stdout.len() > 1_000_000);
    assert_eq!(output.stderr, "");
    assert_eq!(output.exit_code, Some(0));
    Ok(())
}

#[test]
fn mcp_process_transport_rejects_oversized_response_body() -> Result<(), RuntimeError> {
    let adapter = McpAdapter::new(ProcessMcpTransport::default());

    let output = adapter.invoke(fixture_invocation(
        "oversized-response",
        Some(5),
        JsonObject::new(),
    )?)?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(output.stdout, "");
    assert_eq!(output.stderr, "MCP adapter failed.");
    assert_eq!(output.exit_code, None);
    Ok(())
}

#[test]
fn mcp_adapter_applies_sandbox_env_allowlist_to_process_server() -> Result<(), RuntimeError> {
    let adapter = McpAdapter::new(ProcessMcpTransport::default());

    let blocked = adapter.invoke(sandbox_env_invocation("RUNX_SECRET_VALUE")?)?;
    assert_eq!(blocked.status, InvocationStatus::Success);
    assert_eq!(blocked.stdout, "");
    assert_sandbox_allowlist_metadata(&blocked.metadata);
    assert!(!metadata_json(&blocked.metadata)?.contains("secret"));

    let allowed = adapter.invoke(sandbox_env_invocation("ALLOWED_VALUE")?)?;
    assert_eq!(allowed.status, InvocationStatus::Success);
    assert_eq!(allowed.stdout, "allowed");
    assert_sandbox_allowlist_metadata(&allowed.metadata);
    assert!(!metadata_json(&allowed.metadata)?.contains("secret"));
    Ok(())
}

#[test]
fn mcp_adapter_reports_missing_tool_metadata() -> Result<(), RuntimeError> {
    let adapter = McpAdapter::new(ProcessMcpTransport::default());
    let mut request = invocation("echo", Some(1), JsonObject::new());
    request.source.tool = None;

    let output = adapter.invoke(request)?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(
        output.stderr,
        "MCP source requires server and tool metadata."
    );
    assert!(output.metadata.is_empty());
    Ok(())
}

#[test]
fn mcp_adapter_matches_fixture_oracle_status_stdout_and_stderr()
-> Result<(), Box<dyn std::error::Error>> {
    for case_name in [
        "fixture-success",
        "fixture-failure-sanitized",
        "sandbox-env-allowed",
        "sandbox-env-blocked",
        "missing-metadata",
    ] {
        let output =
            McpAdapter::new(ProcessMcpTransport::default()).invoke(fixture_case(case_name)?)?;

        assert_eq!(
            status_text(&output.status),
            oracle_text(case_name, "status")?.trim_end(),
            "{case_name} status"
        );
        assert_eq!(
            output.stdout,
            oracle_text(case_name, "stdout")?,
            "{case_name} stdout"
        );
        assert_eq!(
            output.stderr,
            oracle_text(case_name, "stderr")?,
            "{case_name} stderr"
        );
        assert_eq!(
            normalized_output_metadata(&output.metadata)?,
            oracle_metadata(case_name)?,
            "{case_name} metadata"
        );
    }
    Ok(())
}

#[derive(Clone, Debug)]
struct TimeoutProbeTransport {
    seen: Arc<Mutex<Option<Duration>>>,
}

impl McpTransport for TimeoutProbeTransport {
    fn call_tool(&self, request: McpToolCallRequest) -> Result<JsonValue, McpTransportError> {
        assert_eq!(request.tool, "fail");
        assert_eq!(
            request.arguments.get("secret"),
            Some(&JsonValue::String("sk-live-do-not-leak".to_owned()))
        );
        let mut seen = self
            .seen
            .lock()
            .map_err(|_| McpTransportError::failed("MCP adapter failed."))?;
        *seen = Some(request.timeout);
        Err(McpTransportError::tool_error(
            -32000,
            "provider failure: sk-live-do-not-leak",
        ))
    }
}

#[derive(Deserialize)]
struct RuntimeMcpAdapterRequest {
    #[serde(rename = "skillName")]
    skill_name: String,
    source: SkillSource,
    inputs: JsonObject,
    #[serde(default, rename = "resolvedInputs")]
    resolved_inputs: JsonObject,
}

fn invocation(tool: &str, timeout_seconds: Option<u64>, inputs: JsonObject) -> SkillInvocation {
    SkillInvocation {
        skill_name: "fixture.mcp".to_owned(),
        source: SkillSource {
            act: None,
            source_type: runx_parser::SourceKind::Mcp,
            command: None,
            args: Vec::new(),
            cwd: None,
            timeout_seconds,
            input_mode: None,
            sandbox: None,
            server: Some(SkillMcpServer {
                command: "/bin/echo".to_owned(),
                args: Vec::new(),
                cwd: None,
            }),
            catalog_ref: None,
            tool: Some(tool.to_owned()),
            arguments: None,
            agent_card_url: None,
            agent_identity: None,
            agent: None,
            task: None,
            hook: None,
            outputs: None,
            graph: None,
            http: None,
            raw: JsonObject::new(),
        },
        inputs,
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: PathBuf::from("."),
        env: BTreeMap::new(),
        credential_delivery: runx_runtime::CredentialDelivery::none(),
    }
}

fn fixture_case(case_name: &str) -> Result<SkillInvocation, Box<dyn std::error::Error>> {
    let fixture: RuntimeMcpAdapterRequest =
        serde_json::from_str(&fs::read_to_string(repo_root()?.join(format!(
            "fixtures/runtime/adapters/mcp/{case_name}/request.json"
        )))?)?;
    Ok(SkillInvocation {
        skill_name: fixture.skill_name,
        source: fixture.source,
        inputs: fixture.inputs,
        resolved_inputs: fixture.resolved_inputs,
        current_context: Vec::new(),
        skill_directory: repo_root()?,
        env: oracle_env()?,
        credential_delivery: runx_runtime::CredentialDelivery::none(),
    })
}

fn fixture_invocation(
    tool: &str,
    timeout_seconds: Option<u64>,
    inputs: JsonObject,
) -> Result<SkillInvocation, RuntimeError> {
    let mut request = invocation(tool, timeout_seconds, inputs);
    request.source.server = Some(fixture_server()?);
    request.skill_directory = repo_root()?;
    request.env = process_env();
    request.env.insert(
        "RUNX_CWD".to_owned(),
        repo_root()?.to_string_lossy().into_owned(),
    );
    Ok(request)
}

fn sandbox_env_invocation(name: &str) -> Result<SkillInvocation, RuntimeError> {
    let mut inputs = JsonObject::new();
    inputs.insert("name".to_owned(), JsonValue::String(name.to_owned()));
    let mut request = fixture_invocation("env", Some(5), inputs)?;
    request.source.sandbox = Some(SkillSandbox {
        profile: runx_core::policy::SandboxProfile::Readonly,
        cwd_policy: Some(runx_core::policy::CwdPolicy::Workspace),
        env_allowlist: Some(vec!["PATH".to_owned(), "ALLOWED_VALUE".to_owned()]),
        network: None,
        writable_paths: Vec::new(),
        require_enforcement: None,
        approved_escalation: None,
        raw: JsonObject::new(),
    });
    request
        .env
        .insert("ALLOWED_VALUE".to_owned(), "allowed".to_owned());
    request
        .env
        .insert("RUNX_SECRET_VALUE".to_owned(), "secret".to_owned());
    request.env.insert(
        RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV.to_owned(),
        RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_VALUE.to_owned(),
    );
    Ok(request)
}

fn session_marker_invocation(
    _marker_path: &Path,
    scope: &str,
    message: &str,
) -> Result<SkillInvocation, RuntimeError> {
    let mut inputs = JsonObject::new();
    inputs.insert("message".to_owned(), JsonValue::String(message.to_owned()));
    let mut request = fixture_invocation("echo", Some(5), inputs)?;
    request
        .env
        .insert("RUNX_MCP_SCOPE".to_owned(), scope.to_owned());
    request.source.sandbox = Some(SkillSandbox {
        profile: runx_core::policy::SandboxProfile::UnrestrictedLocalDev,
        cwd_policy: Some(runx_core::policy::CwdPolicy::SkillDirectory),
        env_allowlist: Some(vec![
            "PATH".to_owned(),
            "HOME".to_owned(),
            "TMPDIR".to_owned(),
            "TMP".to_owned(),
            "TEMP".to_owned(),
            "SystemRoot".to_owned(),
            "WINDIR".to_owned(),
            "COMSPEC".to_owned(),
            "PATHEXT".to_owned(),
            "RUNX_MCP_SCOPE".to_owned(),
        ]),
        network: None,
        writable_paths: Vec::new(),
        require_enforcement: None,
        approved_escalation: Some(true),
        raw: JsonObject::new(),
    });
    Ok(request)
}

fn reset_transport_session_pool(transport: &ProcessMcpTransport) -> Result<(), RuntimeError> {
    transport
        .reset_session_pool()
        .map_err(|error| runtime_test_error(error.sanitized_message()))
}

fn fixture_server() -> Result<SkillMcpServer, RuntimeError> {
    let root = repo_root()?;
    Ok(SkillMcpServer {
        command: "node".to_owned(),
        args: vec![
            root.join("fixtures/runtime/adapters/mcp/stdio-server.mjs")
                .to_string_lossy()
                .into_owned(),
        ],
        cwd: Some(root.to_string_lossy().into_owned()),
    })
}

fn fixture_sandbox_plan() -> Result<SandboxPlan, RuntimeError> {
    let server = fixture_server()?;
    Ok(SandboxPlan {
        command: server.command,
        args: server.args,
        cwd: repo_root()?,
        env: process_env(),
        metadata: JsonObject::new(),
        cleanup_paths: Vec::new(),
    })
}

fn assert_sandbox_allowlist_metadata(metadata: &JsonObject) {
    let Some(JsonValue::Object(sandbox)) = metadata.get("sandbox") else {
        assert!(
            metadata.contains_key("sandbox"),
            "sandbox metadata is present"
        );
        return;
    };
    assert_eq!(
        sandbox.get("profile"),
        Some(&JsonValue::String("readonly".to_owned()))
    );
    let Some(JsonValue::Object(env)) = sandbox.get("env") else {
        assert!(
            sandbox.contains_key("env"),
            "sandbox env metadata is present"
        );
        return;
    };
    assert_eq!(
        env.get("mode"),
        Some(&JsonValue::String("allowlist".to_owned()))
    );
    assert_eq!(
        env.get("allowlist"),
        Some(&JsonValue::Array(vec![
            JsonValue::String("PATH".to_owned()),
            JsonValue::String("ALLOWED_VALUE".to_owned()),
        ]))
    );
}

fn repo_root() -> Result<PathBuf, RuntimeError> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .map_err(|error| runtime_test_error(format!("repository root is available: {error}")))
}

fn lifecycle_marker_path(name: &str) -> Result<PathBuf, RuntimeError> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| runtime_test_error(format!("system clock is before epoch: {error}")))?
        .as_nanos();
    Ok(std::env::temp_dir().join(format!(
        "runx-mcp-{name}-{}-{unique}.log",
        std::process::id()
    )))
}

fn wait_for_lifecycle_lines(
    path: &Path,
    expected_minimum: usize,
    timeout: Duration,
) -> Result<usize, RuntimeError> {
    let deadline = Instant::now() + timeout;
    loop {
        let count = lifecycle_line_count(path)?;
        if count >= expected_minimum {
            return Ok(count);
        }
        if Instant::now() >= deadline {
            return Err(runtime_test_error(format!(
                "MCP lifecycle marker reached {count} line(s), expected at least {expected_minimum}"
            )));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn lifecycle_line_count(path: &Path) -> Result<usize, RuntimeError> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(contents.lines().count()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(runtime_test_error(format!(
            "reading MCP lifecycle marker: {error}"
        ))),
    }
}

fn process_env() -> BTreeMap<String, String> {
    [
        "PATH",
        "HOME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
    ]
    .into_iter()
    .filter_map(|key| std::env::var(key).ok().map(|value| (key.to_owned(), value)))
    .collect()
}

fn oracle_env() -> Result<BTreeMap<String, String>, RuntimeError> {
    let mut env = process_env();
    env.insert("ALLOWED_VALUE".to_owned(), "allowed".to_owned());
    env.insert("RUNX_SECRET_VALUE".to_owned(), "secret".to_owned());
    env.insert(
        "RUNX_CWD".to_owned(),
        repo_root()?.to_string_lossy().into_owned(),
    );
    Ok(env)
}

fn oracle_text(case_name: &str, extension: &str) -> Result<String, Box<dyn std::error::Error>> {
    Ok(fs::read_to_string(repo_root()?.join(format!(
        "fixtures/runtime/adapters/mcp/oracles/{case_name}.{extension}"
    )))?)
}

fn oracle_metadata(case_name: &str) -> Result<Option<JsonValue>, Box<dyn std::error::Error>> {
    let oracle: JsonValue = serde_json::from_str(&oracle_text(case_name, "json")?)?;
    let JsonValue::Object(record) = oracle else {
        return Ok(None);
    };
    Ok(record.get("metadata").cloned())
}

fn normalized_output_metadata(metadata: &JsonObject) -> Result<Option<JsonValue>, RuntimeError> {
    if metadata.is_empty() {
        return Ok(None);
    }
    Ok(Some(normalize_metadata_value(
        &JsonValue::Object(metadata.clone()),
        &repo_root()?.to_string_lossy(),
    )))
}

fn normalize_metadata_value(value: &JsonValue, repo_root: &str) -> JsonValue {
    match value {
        JsonValue::String(value) => {
            JsonValue::String(value.replace('\\', "/").replace(repo_root, "<repo>"))
        }
        JsonValue::Array(values) => JsonValue::Array(
            values
                .iter()
                .map(|value| normalize_metadata_value(value, repo_root))
                .collect(),
        ),
        JsonValue::Object(record) => JsonValue::Object(
            record
                .iter()
                .map(|(key, value)| (key.clone(), normalize_metadata_value(value, repo_root)))
                .collect(),
        ),
        value => value.clone(),
    }
}

fn status_text(status: &InvocationStatus) -> &'static str {
    match status {
        InvocationStatus::Success => "sealed",
        InvocationStatus::Failure => "failure",
    }
}

fn metadata_json(metadata: &JsonObject) -> Result<String, RuntimeError> {
    serde_json::to_string(metadata)
        .map_err(|error| runtime_test_error(format!("metadata serializes: {error}")))
}

fn runtime_test_error(message: impl Into<String>) -> RuntimeError {
    RuntimeError::ReceiptInvalid {
        message: message.into(),
    }
}

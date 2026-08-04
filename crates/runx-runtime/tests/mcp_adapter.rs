#![cfg(feature = "mcp")]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use runx_contracts::{JsonNumber, JsonObject, JsonValue};
use runx_parser::{SkillMcpServer, SkillSource};
#[cfg(windows)]
use runx_runtime::SecretEnv;
use runx_runtime::adapters::mcp::{
    McpAdapter, McpListToolsRequest, McpToolCallRequest, McpTransport, McpTransportError,
    ProcessMcpTransport, map_mcp_arguments,
};
use runx_runtime::process_invocation::PreparedProcessInvocation;
use runx_runtime::{InvocationStatus, RuntimeError, SkillAdapter, SkillInvocation};
use serde::Deserialize;

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
    assert_eq!(
        output.failure_message().as_deref(),
        Some("MCP tool returned error -32000.")
    );
    assert!(
        !output
            .failure_message()
            .unwrap_or_default()
            .contains("sk-live-do-not-leak")
    );
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
    assert_eq!(
        output.failure_message().as_deref(),
        Some("MCP adapter failed.")
    );
    assert!(
        !output
            .failure_message()
            .unwrap_or_default()
            .contains("malformed-json-secret")
    );
    assert_eq!(output.value, JsonValue::Null);
    assert_eq!(output.exit_code(), None);
    Ok(())
}

#[test]
fn mcp_process_transport_lists_fixture_tools_over_stdio() -> Result<(), RuntimeError> {
    let tools = ProcessMcpTransport::default()
        .list_tools(McpListToolsRequest {
            server: fixture_server()?,
            timeout: Duration::from_secs(5),
            process: fixture_process_plan()?,
        })
        .map_err(|error| runtime_test_error(error.sanitized_message()))?;

    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        ["echo", "fail", "sleep", "env"]
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
    assert_eq!(
        output.value,
        JsonValue::String("hello from rust mcp".to_owned())
    );
    assert_eq!(output.exit_code(), None);
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
    assert_eq!(first.value, JsonValue::String("first".to_owned()));
    assert_eq!(second.status, InvocationStatus::Success);
    assert_eq!(second.value, JsonValue::String("second".to_owned()));
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
fn mcp_credential_delivery_uses_an_isolated_one_shot_session() -> Result<(), RuntimeError> {
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

    assert_eq!(output.status, InvocationStatus::Success);
    assert_eq!(
        output.value,
        JsonValue::String("[redacted-credential]".to_owned())
    );
    assert!(!metadata_json(&output.metadata)?.contains("mcp-secret-value"));
    assert_eq!(transport.spawned_process_count(), 1);
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
    assert_eq!(output.value, JsonValue::Null);
    assert_eq!(
        output.failure_message().as_deref(),
        Some("MCP call timed out after 1000ms.")
    );
    assert_eq!(output.exit_code(), None);

    let line_count_after_timeout =
        wait_for_lifecycle_lines(&marker_path, 2, Duration::from_secs(1))?;
    // Lifecycle lines embed the server's pid; wait for that pid to die instead
    // of a fixed quiescence window. A dead process cannot append further
    // heartbeats, so the count comparison below is then race-free.
    #[cfg(unix)]
    crate::support::wait_for_pid_exit(lifecycle_pid(&marker_path)?, Duration::from_secs(5))
        .map_err(|error| runtime_test_error(error.to_string()))?;
    #[cfg(not(unix))]
    thread::sleep(Duration::from_millis(150));
    assert_eq!(
        lifecycle_line_count(&marker_path)?,
        line_count_after_timeout,
        "timed-out MCP server child stopped writing heartbeats"
    );

    let _ = fs::remove_file(&marker_path);
    Ok(())
}

#[cfg(windows)]
#[test]
fn windows_mcp_session_lifecycle_terminates_descendant_trees() -> Result<(), RuntimeError> {
    for lifecycle in [
        WindowsMcpLifecycle::OneShotClose,
        WindowsMcpLifecycle::Timeout,
        WindowsMcpLifecycle::PoolReset,
    ] {
        assert_windows_mcp_lifecycle_terminates_descendant(lifecycle)?;
    }
    Ok(())
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug)]
enum WindowsMcpLifecycle {
    OneShotClose,
    Timeout,
    PoolReset,
}

#[cfg(windows)]
fn assert_windows_mcp_lifecycle_terminates_descendant(
    lifecycle: WindowsMcpLifecycle,
) -> Result<(), RuntimeError> {
    let temp = tempfile::tempdir()
        .map_err(|error| runtime_test_error(format!("creating MCP lifecycle tempdir: {error}")))?;
    let pid_path = temp.path().join("descendant.pid");
    let marker_path = temp.path().join("descendant.log");
    let mut arguments = JsonObject::new();
    arguments.insert(
        "descendantPidPath".to_owned(),
        JsonValue::String(pid_path.to_string_lossy().into_owned()),
    );
    arguments.insert(
        "descendantMarkerPath".to_owned(),
        JsonValue::String(marker_path.to_string_lossy().into_owned()),
    );

    let transport = ProcessMcpTransport::default();
    let mut plan = fixture_process_plan()?;
    let (tool, timeout) = match lifecycle {
        WindowsMcpLifecycle::OneShotClose => {
            arguments.insert(
                "message".to_owned(),
                JsonValue::String("one-shot".to_owned()),
            );
            arguments.insert(
                "responseDelayMs".to_owned(),
                JsonValue::Number(JsonNumber::U64(100)),
            );
            plan.cleanup_paths.push(temp.path().join("one-shot-owner"));
            ("echo", Duration::from_secs(5))
        }
        WindowsMcpLifecycle::Timeout => ("sleep", Duration::from_millis(150)),
        WindowsMcpLifecycle::PoolReset => {
            arguments.insert("message".to_owned(), JsonValue::String("pooled".to_owned()));
            arguments.insert(
                "responseDelayMs".to_owned(),
                JsonValue::Number(JsonNumber::U64(100)),
            );
            ("echo", Duration::from_secs(5))
        }
    };

    let result = transport.call_tool(McpToolCallRequest {
        server: fixture_server()?,
        tool: tool.to_owned(),
        arguments,
        timeout,
        process: plan,
        secret_env: SecretEnv::default(),
    });
    match lifecycle {
        WindowsMcpLifecycle::Timeout => {
            let error = result.expect_err("timeout lifecycle must time out");
            assert_eq!(error.sanitized_message(), "MCP call timed out after 150ms.");
        }
        _ => {
            result.map_err(|error| runtime_test_error(error.sanitized_message()))?;
        }
    }

    wait_for_lifecycle_lines(&marker_path, 1, Duration::from_secs(5))?;
    if matches!(lifecycle, WindowsMcpLifecycle::PoolReset) {
        reset_transport_session_pool(&transport)?;
    }
    wait_for_windows_recorded_pid_exit(&pid_path, Duration::from_secs(5))?;

    let alive = transport.call_tool(McpToolCallRequest {
        server: fixture_server()?,
        tool: "echo".to_owned(),
        arguments: [(
            "message".to_owned(),
            JsonValue::String("runtime-alive".to_owned()),
        )]
        .into(),
        timeout: Duration::from_secs(5),
        process: fixture_process_plan()?,
        secret_env: SecretEnv::default(),
    });
    alive.map_err(|error| runtime_test_error(error.sanitized_message()))?;
    reset_transport_session_pool(&transport)?;
    Ok(())
}

#[cfg(windows)]
fn wait_for_windows_recorded_pid_exit(
    pid_path: &Path,
    timeout: Duration,
) -> Result<(), RuntimeError> {
    let deadline = Instant::now() + timeout;
    let pid = loop {
        match fs::read_to_string(pid_path) {
            Ok(raw) if !raw.trim().is_empty() => break raw.trim().to_owned(),
            _ if Instant::now() >= deadline => {
                return Err(runtime_test_error(format!(
                    "MCP descendant never recorded its pid at {}",
                    pid_path.display()
                )));
            }
            _ => thread::sleep(Duration::from_millis(10)),
        }
    };
    let probe = concat!(
        "try { process.kill(Number(process.argv[1]), 0); process.exit(1); } ",
        "catch (error) { process.exit(error?.code === 'ESRCH' ? 0 : 2); }"
    );
    loop {
        let status = std::process::Command::new("node")
            .args(["-e", probe, &pid])
            .status()
            .map_err(|error| runtime_test_error(format!("probing MCP descendant pid: {error}")))?;
        if status.success() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(runtime_test_error(format!(
                "MCP descendant process {pid} survived {timeout:?}"
            )));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn lifecycle_pid(path: &Path) -> Result<i32, RuntimeError> {
    let contents = fs::read_to_string(path)
        .map_err(|error| runtime_test_error(format!("reading MCP lifecycle marker: {error}")))?;
    contents
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|pid| pid.parse().ok())
        .ok_or_else(|| runtime_test_error("MCP lifecycle marker missing server pid".to_owned()))
}

#[test]
fn mcp_adapter_passes_only_declared_environment_to_process_server() -> Result<(), RuntimeError> {
    let adapter = McpAdapter::new(ProcessMcpTransport::default());

    let blocked = adapter.invoke(declared_env_invocation("RUNX_SECRET_VALUE")?)?;
    assert_eq!(blocked.status, InvocationStatus::Success);
    assert_eq!(blocked.value, JsonValue::String(String::new()));
    assert_declared_environment_metadata(&blocked.metadata)?;
    assert!(!metadata_json(&blocked.metadata)?.contains("secret"));

    let allowed = adapter.invoke(declared_env_invocation("ALLOWED_VALUE")?)?;
    assert_eq!(allowed.status, InvocationStatus::Success);
    assert_eq!(allowed.value, JsonValue::String("allowed".to_owned()));
    assert_declared_environment_metadata(&allowed.metadata)?;
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
        output.failure_message().as_deref(),
        Some("MCP source requires server and tool metadata.")
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
        "declared-env-allowed",
        "declared-env-blocked",
        "missing-metadata",
    ] {
        let output =
            McpAdapter::new(ProcessMcpTransport::default()).invoke(fixture_case(case_name)?)?;

        assert_eq!(
            status_text(&output.status),
            oracle_text(case_name, "status")?.trim_end(),
            "{case_name} status"
        );
        assert_eq!(output.value, oracle_value(case_name)?, "{case_name} value");
        assert_eq!(
            output.failure_message(),
            oracle_failure(case_name)?,
            "{case_name} diagnostic"
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
        step_id: None,
        artifacts: None,
        allowed_tools: None,
        source: SkillSource {
            act: None,
            source_type: runx_parser::SourceKind::Mcp,
            command: None,
            module: None,
            javascript_export: None,
            pages: None,
            args: Vec::new(),
            cwd: None,
            timeout_seconds,
            input_mode: None,
            server: Some(SkillMcpServer {
                command: "/bin/echo".to_owned(),
                args: Vec::new(),
                cwd: None,
            }),
            tool: Some(tool.to_owned()),
            arguments: None,
            agent_card_url: None,
            agent_identity: None,
            agent: None,
            task: None,
            outputs: None,
            graph: None,
            external_adapter: None,
            thread_outbox_provider: None,
            environment: Default::default(),
            raw: JsonObject::new(),
        },
        inputs,
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        provenance: Vec::new(),
        skill_directory: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
        env: BTreeMap::new(),
        requirements: Default::default(),
        credential_delivery: runx_runtime::CredentialDelivery::none(),
    }
}

fn fixture_case(case_name: &str) -> Result<SkillInvocation, Box<dyn std::error::Error>> {
    let fixture: RuntimeMcpAdapterRequest =
        serde_json::from_str(&fs::read_to_string(repo_root()?.join(format!(
            "fixtures/runtime/adapters/mcp/{case_name}/request.json"
        )))?)?;
    // Mirror production resolution: the source's declared environment names
    // become the invocation's execution requirements.
    let requirements = runx_contracts::ExecutionRequirements {
        environment: fixture.source.environment.clone(),
        ..Default::default()
    };
    Ok(SkillInvocation {
        skill_name: fixture.skill_name,
        step_id: None,
        artifacts: None,
        allowed_tools: None,
        source: fixture.source,
        inputs: fixture.inputs,
        resolved_inputs: fixture.resolved_inputs,
        current_context: Vec::new(),
        provenance: Vec::new(),
        skill_directory: repo_root()?,
        env: oracle_env()?,
        requirements,
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

fn declared_env_invocation(name: &str) -> Result<SkillInvocation, RuntimeError> {
    let mut inputs = JsonObject::new();
    inputs.insert("name".to_owned(), JsonValue::String(name.to_owned()));
    let mut request = fixture_invocation("env", Some(5), inputs)?;
    request.requirements.environment.optional = vec!["ALLOWED_VALUE".to_owned()];
    request
        .env
        .insert("ALLOWED_VALUE".to_owned(), "allowed".to_owned());
    request
        .env
        .insert("RUNX_SECRET_VALUE".to_owned(), "secret".to_owned());
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
    request.requirements.environment.required = vec!["RUNX_MCP_SCOPE".to_owned()];
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
        args: vec!["fixtures/skills/mcp-echo/stdio-server.mjs".to_owned()],
        cwd: Some(root.to_string_lossy().into_owned()),
    })
}

fn fixture_process_plan() -> Result<PreparedProcessInvocation, RuntimeError> {
    let server = fixture_server()?;
    Ok(PreparedProcessInvocation {
        command: server.command,
        args: server.args,
        cwd: repo_root()?,
        env: process_env(),
        metadata: JsonObject::new(),
        cleanup_paths: Vec::new(),
    })
}

fn assert_declared_environment_metadata(metadata: &JsonObject) -> Result<(), RuntimeError> {
    let Some(JsonValue::Object(boundary)) = metadata.get("execution_boundary") else {
        return Err(runtime_test_error(
            "execution boundary metadata is not present",
        ));
    };
    if boundary.get("kind") != Some(&JsonValue::String("trusted_host_process".to_owned())) {
        return Err(runtime_test_error(
            "execution boundary metadata is not trusted_host_process",
        ));
    }
    Ok(())
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

fn oracle_value(case_name: &str) -> Result<JsonValue, Box<dyn std::error::Error>> {
    let value = oracle_text(case_name, "stdout")?;
    // An empty stdout file is Null only for failed cases; a sealed case with
    // empty text is the honest empty-string value (the two are distinguished
    // by the sibling status oracle).
    Ok(
        if value.is_empty() && oracle_text(case_name, "status")?.trim_end() != "sealed" {
            JsonValue::Null
        } else {
            JsonValue::String(value)
        },
    )
}

fn oracle_failure(case_name: &str) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let diagnostic = oracle_text(case_name, "stderr")?;
    Ok((!diagnostic.is_empty()).then_some(diagnostic))
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
    let normalized = normalize_metadata_value(
        &JsonValue::Object(metadata.clone()),
        &repo_root()?.to_string_lossy(),
    );
    Ok(Some(normalized))
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

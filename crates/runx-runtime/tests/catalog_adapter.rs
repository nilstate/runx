#![cfg(feature = "catalog")]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::{JsonObject, JsonValue};
use runx_parser::SkillSource;
use runx_runtime::adapters::catalog::CatalogAdapter;
use runx_runtime::{InvocationStatus, RuntimeError, SkillAdapter, SkillInvocation};
use tempfile::tempdir;

const RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV: &str = "RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY";

#[test]
fn catalog_adapter_reports_missing_catalog_ref_as_user_failure() -> Result<(), RuntimeError> {
    let output = CatalogAdapter::fixture_catalog().invoke(invocation(None, JsonObject::new()))?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(output.stdout, "");
    assert_eq!(
        output.stderr,
        "Catalog source requires source.catalog_ref metadata."
    );
    assert_eq!(output.exit_code, None);
    assert!(output.metadata.is_empty());
    Ok(())
}

#[test]
fn catalog_adapter_reports_missing_imported_tool_as_user_failure() -> Result<(), RuntimeError> {
    let output = CatalogAdapter::fixture_catalog().invoke(invocation(
        Some("fixture-mcp:fixture.nope"),
        JsonObject::new(),
    ))?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(
        output.stderr,
        "Imported tool 'fixture-mcp:fixture.nope' was not found in configured tool catalogs."
    );
    assert_eq!(output.exit_code, None);
    assert!(output.metadata.is_empty());
    Ok(())
}

#[test]
fn catalog_adapter_invokes_fixture_echo_tool() -> Result<(), RuntimeError> {
    let mut inputs = JsonObject::new();
    inputs.insert("message".to_owned(), JsonValue::String("hello".to_owned()));

    let output =
        CatalogAdapter::fixture_catalog().invoke(invocation(Some("fixture.echo"), inputs))?;

    assert_eq!(output.status, InvocationStatus::Success);
    assert_eq!(output.stdout, "hello");
    assert_eq!(output.stderr, "");
    assert_eq!(output.exit_code, Some(0));
    assert_eq!(
        output.metadata.get("mcp"),
        Some(&JsonValue::Object(expected_mcp_metadata("echo")))
    );
    Ok(())
}

#[test]
fn catalog_adapter_propagates_fixture_failure() -> Result<(), RuntimeError> {
    let mut inputs = JsonObject::new();
    inputs.insert("message".to_owned(), JsonValue::String("boom".to_owned()));

    let output =
        CatalogAdapter::fixture_catalog().invoke(invocation(Some("fixture.fail"), inputs))?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(output.stdout, "");
    assert_eq!(output.stderr, "MCP error -32000: fixture failure: boom");
    assert_eq!(output.exit_code, None);
    assert_eq!(
        output.metadata.get("mcp"),
        Some(&JsonValue::Object(expected_mcp_metadata("fail")))
    );
    Ok(())
}

#[test]
fn catalog_adapter_keeps_fixture_catalog_opt_in() -> Result<(), RuntimeError> {
    let output = CatalogAdapter::default().invoke(invocation(
        Some("fixture-mcp:fixture.echo"),
        JsonObject::new(),
    ))?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(
        output.stderr,
        "Imported tool 'fixture-mcp:fixture.echo' was not found in configured tool catalogs."
    );
    assert!(output.metadata.is_empty());
    Ok(())
}

#[test]
fn catalog_adapter_prefers_local_manifest_before_fixture_catalog()
-> Result<(), Box<dyn std::error::Error>> {
    let case_dir = repo_root()?.join("fixtures/runtime/adapters/catalog/local-precedence");
    let mut inputs = JsonObject::new();
    inputs.insert(
        "message".to_owned(),
        JsonValue::String("catalog fixture collision".to_owned()),
    );

    let output = CatalogAdapter::fixture_catalog().invoke(invocation_in_directory(
        Some("fixture.echo"),
        inputs,
        case_dir,
        process_env_with_local_sandbox_fallback(),
    ))?;

    assert_eq!(output.status, InvocationStatus::Success);
    assert_eq!(output.stdout, oracle_text("local-precedence", "stdout")?);
    assert_eq!(output.stderr, oracle_text("local-precedence", "stderr")?);
    assert_eq!(oracle_text("local-precedence", "status")?, "sealed\n");
    Ok(())
}

#[test]
fn catalog_adapter_invokes_local_tool_with_declared_inputs_only()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    write_catalog_tool(
        &temp.path().join("tools/test/exact-inputs"),
        r#"{
  "schema": "runx.tool.manifest.v1",
  "name": "test.exact-inputs",
  "source": {
    "type": "cli-tool",
    "command": "/bin/sh",
    "args": ["./run.sh"],
    "input_mode": "stdin"
  },
  "inputs": {
    "message": { "type": "string", "required": true }
  },
  "scopes": ["test.exact-inputs"]
}
"#,
        r#"raw="$(cat)"
case "$raw" in
  *persona*|*thread*) printf '%s\n' '{"error":"undeclared input reached tool"}'; exit 7 ;;
  *'"message":"hello"'*) printf '%s\n' '{"ok":true}' ;;
  *) printf '%s\n' '{"error":"declared input missing"}'; exit 8 ;;
esac
"#,
    )?;
    let mut inputs = JsonObject::new();
    inputs.insert("message".to_owned(), JsonValue::String("hello".to_owned()));
    inputs.insert(
        "persona".to_owned(),
        JsonValue::String("prompt-only".to_owned()),
    );
    inputs.insert(
        "thread".to_owned(),
        JsonValue::String("context-only".to_owned()),
    );

    let output = CatalogAdapter::default().invoke(invocation_in_directory(
        Some("test.exact-inputs"),
        inputs,
        temp.path().to_path_buf(),
        tool_root_env(temp.path()),
    ))?;

    assert_eq!(output.status, InvocationStatus::Success);
    assert_eq!(output.stdout.trim(), r#"{"ok":true}"#);
    Ok(())
}

#[test]
fn catalog_adapter_wraps_local_tool_outputs_for_graph_context_paths()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    write_catalog_tool(
        &temp.path().join("tools/test/wrapped"),
        r#"{
  "schema": "runx.tool.manifest.v1",
  "name": "test.wrapped",
  "source": {
    "type": "cli-tool",
    "command": "/bin/sh",
    "args": ["./run.sh"]
  },
  "runx": {
    "artifacts": {
      "wrap_as": "wrapped_packet"
    }
  },
  "scopes": ["test.wrapped"]
}
"#,
        r#"printf '%s\n' '{"schema":"test.packet.v1","data":{"message":"hello"}}'
"#,
    )?;
    let output = CatalogAdapter::default().invoke(invocation_in_directory(
        Some("test.wrapped"),
        JsonObject::new(),
        temp.path().to_path_buf(),
        tool_root_env(temp.path()),
    ))?;

    assert_eq!(output.status, InvocationStatus::Success);
    let payload: JsonValue = serde_json::from_str(&output.stdout)?;
    assert_eq!(
        json_path(&payload, &["wrapped_packet", "data", "data", "message"]),
        Some("hello")
    );
    Ok(())
}

#[test]
fn catalog_adapter_wraps_local_named_emits_for_graph_context_paths()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    write_catalog_tool(
        &temp.path().join("tools/test/named"),
        r#"{
  "schema": "runx.tool.manifest.v1",
  "name": "test.named",
  "source": {
    "type": "cli-tool",
    "command": "/bin/sh",
    "args": ["./run.sh"]
  },
  "runx": {
    "artifacts": {
      "named_emits": {
        "draft_pull_request": "draft_pull_request_packet"
      }
    }
  },
  "scopes": ["test.named"]
}
"#,
        r#"printf '%s\n' '{"draft_pull_request":{"title":"hello"}}'
"#,
    )?;
    let output = CatalogAdapter::default().invoke(invocation_in_directory(
        Some("test.named"),
        JsonObject::new(),
        temp.path().to_path_buf(),
        tool_root_env(temp.path()),
    ))?;

    assert_eq!(output.status, InvocationStatus::Success);
    let payload: JsonValue = serde_json::from_str(&output.stdout)?;
    assert_eq!(
        json_path(&payload, &["draft_pull_request", "data", "title"]),
        Some("hello")
    );
    Ok(())
}

#[cfg(feature = "http")]
#[test]
fn catalog_adapter_routes_http_tools_to_the_governed_http_adapter()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    write_catalog_tool(
        &temp.path().join("tools/test/http"),
        r#"{
  "schema": "runx.tool.manifest.v1",
  "name": "test.http",
  "source": {
    "type": "http",
    "url": "http://127.0.0.1:9/v1/ping"
  },
  "scopes": ["test.http"]
}
"#,
        "",
    )?;
    let result = CatalogAdapter::default().invoke(invocation_in_directory(
        Some("test.http"),
        JsonObject::new(),
        temp.path().to_path_buf(),
        tool_root_env(temp.path()),
    ));
    // Routed to the governed HTTP adapter: with no allow_private_network opt-in,
    // the default transport fails the loopback URL closed in the http path,
    // rather than the tool being rejected as an unsupported Rust adapter.
    let message = match result {
        Err(RuntimeError::SkillFailed { message, .. }) => message,
        other => return Err(format!("expected the http adapter to engage, got: {other:?}").into()),
    };
    assert!(
        message.contains("http request failed"),
        "expected a governed http transport failure, got: {message}"
    );
    Ok(())
}

fn invocation(catalog_ref: Option<&str>, inputs: JsonObject) -> SkillInvocation {
    invocation_in_directory(catalog_ref, inputs, PathBuf::from("."), BTreeMap::new())
}

fn invocation_in_directory(
    catalog_ref: Option<&str>,
    inputs: JsonObject,
    skill_directory: PathBuf,
    env: BTreeMap<String, String>,
) -> SkillInvocation {
    SkillInvocation {
        skill_name: "fixture.catalog".to_owned(),
        source: SkillSource {
            act: None,
            source_type: runx_parser::SourceKind::Catalog,
            command: None,
            args: Vec::new(),
            cwd: None,
            timeout_seconds: None,
            input_mode: None,
            sandbox: None,
            server: None,
            catalog_ref: catalog_ref.map(str::to_owned),
            tool: None,
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
        skill_directory,
        env,
        credential_delivery: runx_runtime::CredentialDelivery::none(),
    }
}

fn expected_mcp_metadata(tool_name: &str) -> JsonObject {
    let mut mcp = JsonObject::new();
    mcp.insert("tool".to_owned(), JsonValue::String(tool_name.to_owned()));
    mcp.insert(
        "server_args_hash".to_owned(),
        JsonValue::String(
            "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945".to_owned(),
        ),
    );
    mcp.insert(
        "server_command_hash".to_owned(),
        JsonValue::String(
            "ca74eae5707ec826732f919086a44f6e07c4cc412826f39f1dce7c3f35a784ff".to_owned(),
        ),
    );
    mcp
}

fn repo_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?)
}

fn oracle_text(case_name: &str, extension: &str) -> Result<String, Box<dyn std::error::Error>> {
    let path = repo_root()?.join(format!(
        "fixtures/runtime/adapters/catalog/oracles/{case_name}.{extension}"
    ));
    Ok(fs::read_to_string(path)?)
}

fn write_catalog_tool(
    tool_dir: &Path,
    manifest: &str,
    runner: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(tool_dir)?;
    fs::write(tool_dir.join("manifest.json"), manifest)?;
    fs::write(tool_dir.join("run.sh"), runner)?;
    Ok(())
}

fn tool_root_env(root: &Path) -> BTreeMap<String, String> {
    let mut env = process_env();
    env.insert(
        "RUNX_TOOL_ROOTS".to_owned(),
        root.join("tools").to_string_lossy().into_owned(),
    );
    env
}

fn json_path<'a>(value: &'a JsonValue, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for segment in path {
        let JsonValue::Object(object) = current else {
            return None;
        };
        current = object.get(*segment)?;
    }
    match current {
        JsonValue::String(value) => Some(value),
        _ => None,
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

fn process_env_with_local_sandbox_fallback() -> BTreeMap<String, String> {
    let mut env = process_env();
    env.insert(
        RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV.to_owned(),
        "local".to_owned(),
    );
    env
}

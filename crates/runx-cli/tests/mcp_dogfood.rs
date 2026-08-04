use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use runx_runtime::LocalReceiptStore;
use serde_json::{Value, json};

const MCP_INITIALIZE_TIMEOUT: Duration = Duration::from_secs(30);
const MCP_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[test]
fn mcp_native_binary_dogfoods_streaming_skill_calls_and_receipts()
-> Result<(), Box<dyn std::error::Error>> {
    let receipt_dir = TestTempDir::new("runx-mcp-dogfood-receipts")?;
    let skill_dir = write_unenforced_mcp_echo_skill()?;
    let skill_path = skill_dir.path().to_path_buf();
    let mut server = spawn_mcp_server(&[
        skill_path.display().to_string(),
        "--receipt-dir".to_owned(),
        receipt_dir.path().display().to_string(),
    ])?;

    write_frame(server.stdin_mut()?, &initialize_request(1))?;
    let initialize = server.read_response("initialize", MCP_INITIALIZE_TIMEOUT)?;
    assert_eq!(
        path_text(&initialize, &["result", "protocolVersion"])?,
        "2025-06-18"
    );

    write_frame(server.stdin_mut()?, &initialized_notification())?;
    write_frame(server.stdin_mut()?, &request(2, "tools/list", json!({})))?;
    let tools = server.read_response("tools/list", MCP_REQUEST_TIMEOUT)?;
    assert_eq!(
        path_text(&tools, &["result", "tools", "0", "name"])?,
        "mcp-echo"
    );

    let mut receipt_ids = Vec::new();
    for index in 0..6 {
        let message = format!("dogfood message {index}");
        write_frame(
            server.stdin_mut()?,
            &request(
                10 + index,
                "tools/call",
                json!({
                    "name": "mcp-echo",
                    "arguments": {
                        "message": message,
                    },
                }),
            ),
        )?;
        let response = server.read_response(
            &format!("tools/call dogfood message {index}"),
            MCP_REQUEST_TIMEOUT,
        )?;
        assert_eq!(
            path_text(
                &response,
                &["result", "structuredContent", "runx", "status"]
            )?,
            "completed",
            "unexpected MCP dogfood response: {response}"
        );
        assert_eq!(
            path_text(&response, &["result", "content", "0", "text"])?,
            format!("dogfood message {index}")
        );
        receipt_ids.push(
            path_text(
                &response,
                &["result", "structuredContent", "runx", "receiptId"],
            )?
            .to_owned(),
        );
    }

    server.close_stdin();
    let status = server.wait_timeout(Duration::from_secs(10))?;
    assert!(
        status.success(),
        "runx mcp serve exited with {status}; stderr: {}",
        server.stderr_string()?
    );

    assert_eq!(receipt_ids.len(), 6);
    let receipt_store = LocalReceiptStore::new(receipt_dir.path());
    for receipt_id in receipt_ids {
        let receipt_path = receipt_store.receipt_path(&receipt_id)?;
        let receipt = read_json_file(&receipt_path)?;
        assert_eq!(
            path_text(&receipt, &["schema"])?,
            runx_contracts::RECEIPT_SCHEMA
        );
        assert_eq!(path_text(&receipt, &["id"])?, receipt_id);
        assert_eq!(path_text(&receipt, &["seal", "disposition"])?, "closed");
        assert!(
            receipt.get("seal").is_some(),
            "missing receipt seal in {}",
            receipt_path.display()
        );
    }
    Ok(())
}

#[test]
fn mcp_native_binary_reports_mid_session_framing_fault() -> Result<(), Box<dyn std::error::Error>> {
    let skill_path = repo_root()?.join("fixtures/skills/mcp-echo");
    let mut server = spawn_mcp_server(&[skill_path.display().to_string()])?;

    write_frame(server.stdin_mut()?, &initialize_request(1))?;
    let initialize = server.read_response("initialize", MCP_INITIALIZE_TIMEOUT)?;
    assert_eq!(
        path_text(&initialize, &["result", "protocolVersion"])?,
        "2025-06-18"
    );

    write_frame(server.stdin_mut()?, &initialized_notification())?;
    server
        .stdin_mut()?
        .write_all(b"Content-Length: 1\r\n\r\n{")?;
    server.close_stdin();

    let status = server.wait_timeout(Duration::from_secs(10))?;
    assert!(
        !status.success(),
        "malformed mid-session MCP frame must fail closed"
    );
    let stderr = server.stderr_string()?;
    assert!(
        stderr.contains("MCP rmcp server task failed: EOF while parsing an object"),
        "unexpected stderr: {stderr}"
    );
    Ok(())
}

#[test]
fn mcp_native_binary_uses_one_workspace_env_snapshot_per_session()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = TestTempDir::new("runx-mcp-workspace-env")?;
    let runx_dir = workspace.path().join(".runx");
    fs::create_dir_all(&runx_dir)?;
    fs::write(
        runx_dir.join("project.json"),
        r#"{"version":1,"project_id":"proj_mcp_workspace_env","created_at":"2026-07-16T00:00:00Z"}"#,
    )?;
    fs::write(
        workspace.path().join(".env"),
        "MCP_DOGFOOD_MARKER=initial-snapshot\n",
    )?;
    let skill_dir = write_workspace_env_mcp_skill(workspace.path())?;
    let mut server =
        spawn_mcp_server_at(&[skill_dir.display().to_string()], workspace.path(), None)?;

    write_frame(server.stdin_mut()?, &initialize_request(1))?;
    let initialize = server.read_response("initialize", MCP_INITIALIZE_TIMEOUT)?;
    assert_eq!(
        path_text(&initialize, &["result", "protocolVersion"])?,
        "2025-06-18"
    );
    write_frame(server.stdin_mut()?, &initialized_notification())?;

    // A long-lived MCP server must keep the command-entry snapshot. Reloading
    // the file between calls would make one operator session non-deterministic.
    fs::write(
        workspace.path().join(".env"),
        "MCP_DOGFOOD_MARKER=changed-after-start\n",
    )?;
    write_frame(
        server.stdin_mut()?,
        &request(
            2,
            "tools/call",
            json!({
                "name": "mcp-workspace-env",
                "arguments": {},
            }),
        ),
    )?;
    let response = server.read_response("tools/call workspace env", MCP_REQUEST_TIMEOUT)?;
    assert_eq!(
        path_text(&response, &["result", "content", "0", "text"])?,
        "initial-snapshot"
    );

    server.close_stdin();
    let status = server.wait_timeout(Duration::from_secs(10))?;
    assert!(
        status.success(),
        "runx mcp serve exited with {status}; stderr: {}",
        server.stderr_string()?
    );
    Ok(())
}

#[test]
fn mcp_credential_readiness_fails_at_startup_with_setup_action()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = TestTempDir::new("runx-mcp-missing-credential")?;
    let skill_dir = write_credential_mcp_skill(workspace.path())?;
    let mut server =
        spawn_mcp_server_at(&[skill_dir.display().to_string()], workspace.path(), None)?;
    let status = server.wait_timeout(Duration::from_secs(10))?;
    assert!(!status.success());
    let stderr = server.stderr_string()?;
    assert!(stderr.contains("needs a example credential"));
    assert!(stderr.contains("runx credential set example --from-stdin"));
    Ok(())
}

#[test]
fn mcp_credential_readiness_uses_startup_workspace_snapshot()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = TestTempDir::new("runx-mcp-ready-credential")?;
    fs::write(
        workspace.path().join(".env"),
        "MCP_DOGFOOD_CREDENTIAL=credential-snapshot\n",
    )?;
    let skill_dir = write_credential_mcp_skill(workspace.path())?;
    let mut server =
        spawn_mcp_server_at(&[skill_dir.display().to_string()], workspace.path(), None)?;
    write_frame(server.stdin_mut()?, &initialize_request(1))?;
    let initialize = server.read_response("initialize", MCP_INITIALIZE_TIMEOUT)?;
    assert_eq!(
        path_text(&initialize, &["result", "protocolVersion"])?,
        "2025-06-18"
    );
    write_frame(server.stdin_mut()?, &initialized_notification())?;
    write_frame(
        server.stdin_mut()?,
        &request(
            2,
            "tools/call",
            json!({"name": "mcp-credential", "arguments": {}}),
        ),
    )?;
    let response = server.read_response("default credential runner", MCP_REQUEST_TIMEOUT)?;
    assert_eq!(
        path_text(&response, &["result", "content", "0", "text"])?,
        "default:[redacted-credential]"
    );
    assert!(!response.to_string().contains("credential-snapshot"));
    server.close_stdin();
    assert!(server.wait_timeout(Duration::from_secs(10))?.success());
    assert!(!server.stderr_string()?.contains("credential-snapshot"));
    Ok(())
}

#[test]
fn mcp_selected_runner_matches_its_credential_snapshot() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = TestTempDir::new("runx-mcp-selected-credential")?;
    fs::write(
        workspace.path().join(".env"),
        "MCP_DOGFOOD_CREDENTIAL=selected-runner-secret\n",
    )?;
    let skill_dir = write_credential_mcp_skill(workspace.path())?;
    let mut server = spawn_mcp_server_at(
        &[
            skill_dir.display().to_string(),
            "--runner".to_owned(),
            "alternate".to_owned(),
        ],
        workspace.path(),
        None,
    )?;

    write_frame(server.stdin_mut()?, &initialize_request(1))?;
    let initialize = server.read_response("initialize", MCP_INITIALIZE_TIMEOUT)?;
    assert_eq!(
        path_text(&initialize, &["result", "protocolVersion"])?,
        "2025-06-18"
    );
    write_frame(server.stdin_mut()?, &initialized_notification())?;
    write_frame(
        server.stdin_mut()?,
        &request(
            2,
            "tools/call",
            json!({"name": "mcp-credential", "arguments": {}}),
        ),
    )?;
    let response = server.read_response("alternate credential runner", MCP_REQUEST_TIMEOUT)?;
    assert_eq!(
        path_text(&response, &["result", "content", "0", "text"])?,
        "alternate:[redacted-credential]"
    );
    assert!(!response.to_string().contains("selected-runner-secret"));

    server.close_stdin();
    assert!(server.wait_timeout(Duration::from_secs(10))?.success());
    assert!(!server.stderr_string()?.contains("selected-runner-secret"));
    Ok(())
}

fn spawn_mcp_server(args: &[String]) -> Result<McpProcess, Box<dyn std::error::Error>> {
    let repo_root = repo_root()?;
    spawn_mcp_server_at(args, &repo_root, Some(&repo_root))
}

fn spawn_mcp_server_at(
    args: &[String],
    cwd: &Path,
    runx_cwd: Option<&Path>,
) -> Result<McpProcess, Box<dyn std::error::Error>> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_runx"));
    crate::support::apply_fixture_signing(&mut command, "mcp-dogfood-test-key");
    command.current_dir(cwd).env_remove("MCP_DOGFOOD_MARKER");
    if let Some(runx_cwd) = runx_cwd {
        command.env("RUNX_CWD", runx_cwd);
    } else {
        command.env_remove("RUNX_CWD");
    }
    let mut child = command
        .arg("mcp")
        .arg("serve")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdin = child.stdin.take().ok_or("runx child stdin was not piped")?;
    let stdout = spawn_stdout_reader(
        child
            .stdout
            .take()
            .ok_or("runx child stdout was not piped")?,
    );
    let stderr = child
        .stderr
        .take()
        .ok_or("runx child stderr was not piped")?;
    Ok(McpProcess {
        child,
        stdin: Some(stdin),
        stdout,
        stderr: Some(stderr),
    })
}

struct McpProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Receiver<Result<Value, String>>,
    stderr: Option<ChildStderr>,
}

impl McpProcess {
    fn stdin_mut(&mut self) -> Result<&mut ChildStdin, Box<dyn std::error::Error>> {
        self.stdin
            .as_mut()
            .ok_or_else(|| "runx child stdin is closed".into())
    }

    fn read_response(
        &mut self,
        label: &str,
        timeout: Duration,
    ) -> Result<Value, Box<dyn std::error::Error>> {
        match self.stdout.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => {
                let _ignored = self.child.kill();
                let _ignored = self.child.wait();
                Err(format!("{label}: {error}; stderr: {}", self.stderr_string()?).into())
            }
            Err(RecvTimeoutError::Timeout) => {
                let _ignored = self.child.kill();
                Err(format!(
                    "timed out waiting for runx mcp serve response to {label}; stderr: {}",
                    self.stderr_string()?
                )
                .into())
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(format!("runx mcp serve stdout reader disconnected before {label}").into())
            }
        }
    }

    fn close_stdin(&mut self) {
        let _closed = self.stdin.take();
    }

    fn wait_timeout(
        &mut self,
        timeout: Duration,
    ) -> Result<ExitStatus, Box<dyn std::error::Error>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return Ok(status);
            }
            if Instant::now() >= deadline {
                let _ignored = self.child.kill();
                let _ignored = self.child.wait();
                return Err("timed out waiting for runx mcp serve to exit".into());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn stderr_string(&mut self) -> Result<String, Box<dyn std::error::Error>> {
        let mut text = String::new();
        if let Some(mut stderr) = self.stderr.take() {
            stderr.read_to_string(&mut text)?;
        }
        Ok(text)
    }
}

impl Drop for McpProcess {
    fn drop(&mut self) {
        let _closed = self.stdin.take();
        let _ignored = self.child.kill();
        let _ignored = self.child.wait();
    }
}

fn write_frame(stdin: &mut ChildStdin, message: &Value) -> Result<(), Box<dyn std::error::Error>> {
    let body = serde_json::to_vec(message)?;
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len())?;
    stdin.write_all(&body)?;
    stdin.flush()?;
    Ok(())
}

fn spawn_stdout_reader(mut stdout: ChildStdout) -> Receiver<Result<Value, String>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        loop {
            match read_frame(&mut stdout) {
                Ok(value) => {
                    if sender.send(Ok(value)).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ignored = sender.send(Err(error));
                    return;
                }
            }
        }
    });
    receiver
}

fn read_frame(stdout: &mut ChildStdout) -> Result<Value, String> {
    let mut header = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        stdout
            .read_exact(&mut byte)
            .map_err(|error| error.to_string())?;
        header.push(byte[0]);
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
        if header.len() > 8192 {
            return Err("MCP response header exceeded 8192 bytes".to_owned());
        }
    }

    let header_text = std::str::from_utf8(&header).map_err(|error| error.to_string())?;
    let length = header_text
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .ok_or_else(|| "missing MCP response Content-Length header".to_owned())?
        .parse::<usize>()
        .map_err(|error| error.to_string())?;
    let mut body = vec![0_u8; length];
    stdout
        .read_exact(&mut body)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}

fn initialize_request(id: i64) -> Value {
    request(
        id,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {
                "name": "runx-cli-dogfood-test",
                "version": "0.0.0",
            },
        }),
    )
}

fn initialized_notification() -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {},
    })
}

fn request(id: i64, method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

fn path_text<'a>(value: &'a Value, path: &[&str]) -> Result<&'a str, Box<dyn std::error::Error>> {
    let mut current = value;
    for segment in path {
        current = match current {
            Value::Array(values) => values
                .get(segment.parse::<usize>()?)
                .ok_or_else(|| format!("missing JSON array index {segment} in {value}"))?,
            Value::Object(record) => record
                .get(*segment)
                .ok_or_else(|| format!("missing JSON object key {segment} in {value}"))?,
            _ => {
                return Err(
                    format!("cannot descend into JSON path segment {segment} in {value}").into(),
                );
            }
        };
    }
    current
        .as_str()
        .ok_or_else(|| format!("JSON path {path:?} is not a string in {value}").into())
}

fn read_json_file(path: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn write_unenforced_mcp_echo_skill() -> Result<TestTempDir, Box<dyn std::error::Error>> {
    let skill_dir = TestTempDir::new("runx-mcp-dogfood-skill")?;
    copy_mcp_fixture_server(skill_dir.path())?;
    fs::write(
        skill_dir.path().join("SKILL.md"),
        r#"---
name: mcp-echo
description: Echo a message through a local MCP stdio fixture server.
---

Echo the provided message through a local MCP server fixture.
"#,
    )?;
    fs::write(
        skill_dir.path().join("X.yaml"),
        r#"skill: mcp-echo
runners:
  default:
    default: true
    type: mcp
    server:
      command: node
      args:
        - ./stdio-server.mjs
    tool: echo
    arguments:
      message: "{{message}}"
    timeout_seconds: 15
    inputs:
      message:
        type: string
        required: true
        description: Message to echo through MCP
"#,
    )?;
    Ok(skill_dir)
}

fn write_workspace_env_mcp_skill(workspace: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let skill_dir = workspace.join("mcp-workspace-env");
    fs::create_dir_all(&skill_dir)?;
    copy_mcp_fixture_server(&skill_dir)?;
    fs::write(
        skill_dir.join("SKILL.md"),
        r#"---
name: mcp-workspace-env
description: Return an allowlisted workspace value through an MCP server.
---

Return the allowlisted workspace marker.
"#,
    )?;
    fs::write(
        skill_dir.join("X.yaml"),
        r#"skill: mcp-workspace-env
runners:
  default:
    default: true
    type: mcp
    server:
      command: node
      args:
        - ./stdio-server.mjs
    tool: env
    arguments:
      name: MCP_DOGFOOD_MARKER
    timeout_seconds: 15
    environment:
      required:
        - MCP_DOGFOOD_MARKER
"#,
    )?;
    Ok(skill_dir)
}

fn copy_mcp_fixture_server(skill_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::copy(
        repo_root()?.join("fixtures/skills/mcp-echo/stdio-server.mjs"),
        skill_dir.join("stdio-server.mjs"),
    )?;
    Ok(())
}

fn write_credential_mcp_skill(workspace: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let skill_dir = workspace.join("mcp-credential");
    fs::create_dir_all(&skill_dir)?;
    fs::write(
        skill_dir.join("SKILL.md"),
        r#"---
name: mcp-credential
description: Credential readiness fixture.
---

Credential readiness fixture.
"#,
    )?;
    fs::write(
        skill_dir.join("X.yaml"),
        r#"
skill: mcp-credential
credentials:
  example:
    provider: example
    auth:
      api_key:
        delivery:
          env: MCP_DOGFOOD_CREDENTIAL
runners:
  default:
    default: true
    type: cli-tool
    command: sh
    args:
      - ./default.sh
    input_mode: none
    credential: example
  alternate:
    type: cli-tool
    command: sh
    args:
      - ./alternate.sh
    input_mode: none
    credential: example
"#,
    )?;
    fs::write(
        skill_dir.join("default.sh"),
        "printf 'default:%s' \"$MCP_DOGFOOD_CREDENTIAL\"\n",
    )?;
    fs::write(
        skill_dir.join("alternate.sh"),
        "printf 'alternate:%s' \"$MCP_DOGFOOD_CREDENTIAL\"\n",
    )?;
    Ok(skill_dir)
}

fn repo_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?)
}

struct TestTempDir {
    path: PathBuf,
}

impl TestTempDir {
    fn new(prefix: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestTempDir {
    fn drop(&mut self) {
        let _ignored = fs::remove_dir_all(&self.path);
    }
}

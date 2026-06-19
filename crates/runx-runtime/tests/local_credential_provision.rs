//! Local, no-network per-run credential provision boundary.
//!
//! `cli-tool` execution no longer accepts process-env local credentials. This
//! keeps the secret boundary fail-closed until a non-env delivery channel exists.

#![cfg(feature = "cli-tool")]

use std::collections::BTreeMap;
use std::fs;
#[cfg(feature = "http")]
use std::io::{Read, Write};
#[cfg(feature = "http")]
use std::net::TcpListener;
use std::path::{Path, PathBuf};
#[cfg(feature = "http")]
use std::thread;
#[cfg(feature = "http")]
use std::time::{Duration, Instant};

#[cfg(feature = "http")]
use runx_contracts::{JsonValue, sha256_hex};
#[cfg(feature = "http")]
use runx_runtime::RunStatus;
use runx_runtime::orchestrator::LocalCredentialDescriptor;
use runx_runtime::{LocalOrchestrator, RunResult, SkillRunRequest};
use tempfile::tempdir;

const SECRET: &str = "ghs_local_provision_secret_value";
const RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV: &str = "RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY";
const RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_VALUE: &str = "local";
#[cfg(feature = "http")]
type HttpFixtureHandle = thread::JoinHandle<Result<String, std::io::Error>>;
#[test]
fn local_credential_for_cli_tool_is_rejected_before_spawn() -> Result<(), Box<dyn std::error::Error>>
{
    let temp = tempdir()?;
    let skill_dir = write_echo_token_skill(temp.path())?;
    let receipt_dir = temp.path().join("receipts");

    let request = SkillRunRequest {
        skill_path: skill_dir,
        receipt_dir: Some(receipt_dir.clone()),
        run_id: None,
        answers_path: None,
        inputs: BTreeMap::new(),
        env: BTreeMap::new(),
        cwd: temp.path().to_path_buf(),
        local_credential: Some(LocalCredentialDescriptor {
            provider: "github".to_owned(),
            auth_mode: "bearer".to_owned(),
            env_var: "GITHUB_TOKEN".to_owned(),
            material_ref: "local://github/main".to_owned(),
            scopes: vec!["repo".to_owned()],
            secret: SECRET.to_owned(),
        }),
    };

    let error = match run_skill(request) {
        Ok(_) => {
            return Err(
                std::io::Error::other("cli-tool local credential unexpectedly succeeded").into(),
            );
        }
        Err(error) => error,
    };
    let message = error.to_string();
    assert!(
        message.contains("local credential process-env delivery is not supported for cli-tool"),
        "unexpected error: {message}",
    );
    assert!(
        !message.contains(SECRET),
        "raw secret leaked into the error output",
    );
    assert!(
        !receipt_dir.exists(),
        "rejected credential run must not write receipts",
    );

    Ok(())
}

#[test]
fn run_without_descriptor_delivers_no_credential() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let skill_dir = write_echo_token_skill(temp.path())?;

    let request = SkillRunRequest {
        skill_path: skill_dir,
        receipt_dir: Some(temp.path().join("receipts")),
        run_id: None,
        answers_path: None,
        inputs: BTreeMap::new(),
        env: local_sandbox_fallback_env(),
        cwd: temp.path().to_path_buf(),
        local_credential: None,
    };

    let result = run_skill(request)?;
    let serialized = serde_json::to_string(&result.output)?;
    assert!(
        !serialized.contains(SECRET),
        "no credential was provided, the secret must not appear anywhere",
    );
    Ok(())
}

#[cfg(feature = "http")]
#[test]
fn graph_http_step_uses_local_credential_without_exposing_secret()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let (base_url, server) = start_one_shot_http_server(format!("Bearer {SECRET}"))?;
    let skill_dir = write_credentialed_http_graph(temp.path(), &base_url)?;
    let receipt_dir = temp.path().join("receipts");

    let request = SkillRunRequest {
        skill_path: skill_dir,
        receipt_dir: Some(receipt_dir.clone()),
        run_id: None,
        answers_path: None,
        inputs: [(
            "account_id".to_owned(),
            JsonValue::String("acct-42".to_owned()),
        )]
        .into_iter()
        .collect(),
        env: http_private_network_grant_env(),
        cwd: temp.path().to_path_buf(),
        local_credential: Some(LocalCredentialDescriptor {
            provider: "example-crm".to_owned(),
            auth_mode: "api_key".to_owned(),
            env_var: "RUNX_EXAMPLE_CRM_TOKEN".to_owned(),
            material_ref: "local-demo".to_owned(),
            scopes: vec!["crm.account.read".to_owned()],
            secret: SECRET.to_owned(),
        }),
    };

    let result = run_skill(request)?;
    let observed_auth = server
        .join()
        .map_err(|_| std::io::Error::other("HTTP fixture server panicked"))??;
    let serialized = serde_json::to_string(&result.output)?;
    let graph_state = read_single_graph_state(&receipt_dir)?;

    assert_eq!(result.status, RunStatus::Sealed);
    assert_eq!(observed_auth, format!("Bearer {SECRET}"));
    assert!(serialized.contains("acct-42"));
    assert!(graph_state.contains("credential_delivery_observations"));
    assert!(graph_state.contains(&format!(
        "runx:credential:local:{}",
        sha256_hex("local-demo".as_bytes())
    )));
    assert!(
        !serialized.contains(SECRET) && !graph_state.contains(SECRET),
        "graph HTTP credential delivery must not expose raw secret material"
    );
    Ok(())
}

fn run_skill(mut request: SkillRunRequest) -> Result<RunResult, Box<dyn std::error::Error>> {
    crate::support::insert_test_signing_env(&mut request.env);
    LocalOrchestrator::default()
        .run_skill(&request)
        .map_err(Into::into)
}

#[cfg(feature = "http")]
fn http_private_network_grant_env() -> BTreeMap<String, String> {
    [("RUNX_HTTP_ALLOW_PRIVATE_NETWORK".to_owned(), "1".to_owned())].into()
}

fn local_sandbox_fallback_env() -> BTreeMap<String, String> {
    [(
        RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV.to_owned(),
        RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_VALUE.to_owned(),
    )]
    .into()
}

/// A cli-tool skill that echoes the delivered `$GITHUB_TOKEN`. The command is a
/// local shell process: no network, no hosted dependency.
fn write_echo_token_skill(root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let skill_dir = root.join("echo-token");
    fs::create_dir_all(&skill_dir)?;
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: echo-token\n---\n# Echo Token\n",
    )?;
    fs::write(
        skill_dir.join("X.yaml"),
        r#"
skill: echo-token
runners:
  echo:
    default: true
    type: cli-tool
    command: sh
    args:
      - "-c"
      - "printf '%s' \"$GITHUB_TOKEN\""
    sandbox:
      profile: readonly
"#,
    )?;
    Ok(skill_dir)
}

#[cfg(feature = "http")]
fn write_credentialed_http_graph(
    root: &Path,
    base_url: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let skill_dir = root.join("credentialed-http-graph");
    let tool_dir = skill_dir.join("http-read");
    fs::create_dir_all(&tool_dir)?;
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: credentialed-http-graph\n---\n# Credentialed HTTP Graph\n",
    )?;
    fs::write(
        skill_dir.join("X.yaml"),
        r#"
skill: credentialed-http-graph
runners:
  main:
    default: true
    type: graph
    inputs:
      account_id:
        type: string
        required: true
    graph:
      name: credentialed-http-graph
      steps:
        - id: read_account
          skill: ./http-read
          inputs:
            account_id: "$input.account_id"
"#,
    )?;
    fs::write(
        tool_dir.join("SKILL.md"),
        format!(
            r#"---
name: http-read
source:
  type: http
  url: {base_url}/v1/accounts/{{account_id}}
  method: GET
  allow_private_network: true
  headers:
    authorization: "Bearer ${{secret:RUNX_EXAMPLE_CRM_TOKEN}}"
inputs:
  account_id:
    type: string
    required: true
---
# HTTP Read
"#,
        ),
    )?;
    Ok(skill_dir)
}

#[cfg(feature = "http")]
fn read_single_graph_state(receipt_dir: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let runs_dir = receipt_dir.join("runs");
    let mut files = fs::read_dir(&runs_dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".graph-state.json"))
        })
        .collect::<Vec<_>>();
    files.sort();
    let [path] = files.as_slice() else {
        return Err(std::io::Error::other(format!(
            "expected exactly one graph-state file in {}, found {}",
            runs_dir.display(),
            files.len()
        ))
        .into());
    };
    fs::read_to_string(path).map_err(Into::into)
}

#[cfg(feature = "http")]
fn start_one_shot_http_server(
    expected_auth: String,
) -> Result<(String, HttpFixtureHandle), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let addr = listener.local_addr()?;
    let handle = thread::spawn(move || {
        let started = Instant::now();
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(value) => break value,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if started.elapsed() > Duration::from_secs(10) {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "timed out waiting for HTTP fixture request",
                        ));
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error),
            }
        };
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let mut request_bytes = Vec::new();
        let mut bytes = [0_u8; 1024];
        loop {
            let read = stream.read(&mut bytes)?;
            if read == 0 {
                break;
            }
            request_bytes.extend_from_slice(&bytes[..read]);
            if request_bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let request = String::from_utf8_lossy(&request_bytes);
        let auth = request
            .lines()
            .find_map(|line| {
                line.strip_prefix("authorization: ")
                    .or_else(|| line.strip_prefix("Authorization: "))
                    .map(ToOwned::to_owned)
            })
            .unwrap_or_default();
        let (status, body) = if auth == expected_auth {
            (
                "200 OK",
                r#"{"id":"acct-42","name":"account-acct-42","plan":"portfolio"}"#,
            )
        } else {
            ("401 Unauthorized", r#"{"error":"unauthorized"}"#)
        };
        write!(
            stream,
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )?;
        Ok(auth)
    });
    Ok((format!("http://{addr}"), handle))
}

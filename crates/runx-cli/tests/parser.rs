use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[test]
fn parser_eval_accepts_stdin_json() -> Result<(), Box<dyn std::error::Error>> {
    let mut child = runx_command()
        .args(["parser", "eval", "--input", "-", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(
            br#"{"kind":"parser.validateSkillMarkdown","markdown":"---\nname: portable-agent\ndescription: Portable agent skill\ninputs:\n  prompt:\n    type: string\n    required: true\n---\n# Portable agent\n"}"#,
        )?;
    }

    let output = child.wait_with_output()?;
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr)?, "");
    let value = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    assert_eq!(value["status"], "success");
    assert_eq!(value["result"]["kind"], "output");
    assert_eq!(value["result"]["value"]["name"], "portable-agent");
    assert_eq!(value["result"]["value"]["source"]["type"], "agent");
    Ok(())
}

#[test]
fn parser_eval_validates_graph_yaml() -> Result<(), Box<dyn std::error::Error>> {
    let mut child = runx_command()
        .args(["parser", "eval", "--input", "-", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(
            br#"{"kind":"parser.validateGraphYaml","yaml":"name: gx\nsteps:\n  - id: one\n    run:\n      type: cli-tool\n      command: node\n      args: [\"-e\", \"process.stdout.write('{}')\"]\n"}"#,
        )?;
    }

    let output = child.wait_with_output()?;
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr)?, "");
    let value = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    assert_eq!(value["status"], "success");
    assert_eq!(value["result"]["value"]["name"], "gx");
    assert_eq!(value["result"]["value"]["steps"][0]["id"], "one");
    Ok(())
}

#[test]
fn parser_eval_usage_errors_exit_64() -> Result<(), Box<dyn std::error::Error>> {
    let output = runx_command()
        .args(["parser", "eval", "--input", "-"])
        .output()?;

    assert_eq!(output.status.code(), Some(64));
    assert!(String::from_utf8(output.stderr)?.contains("runx parser eval requires --json"));
    Ok(())
}

#[test]
fn parser_eval_unknown_kind_returns_structured_error() -> Result<(), Box<dyn std::error::Error>> {
    let mut child = runx_command()
        .args(["parser", "eval", "--input", "-", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(br#"{"kind":"parser.unknown"}"#)?;
    }

    let output = child.wait_with_output()?;
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8(output.stderr)?, "");
    let value = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    assert_eq!(value["status"], "failure");
    assert_eq!(value["error"]["code"], "invalid_input");
    assert!(
        value["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("unsupported parser input kind"))
    );
    Ok(())
}

#[test]
fn parser_eval_batches_documents_and_returns_independent_errors()
-> Result<(), Box<dyn std::error::Error>> {
    let mut child = runx_command()
        .args(["parser", "eval", "--input", "-", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(
            br#"{
              "inputs": [
                {
                  "kind": "parser.validateHarnessFixtureYaml",
                  "yaml": "name: ready\nkind: skill\ntarget: ..\nexpect:\n  status: sealed\n"
                },
                {
                  "kind": "parser.validateHarnessFixtureYaml",
                  "yaml": "not: a-fixture\n"
                }
              ],
              "returnErrors": true
            }"#,
        )?;
    }

    let output = child.wait_with_output()?;
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr)?, "");
    let value = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    assert_eq!(value["result"]["value"][0]["status"], "success");
    assert_eq!(value["result"]["value"][0]["value"]["name"], "ready");
    assert_eq!(value["result"]["value"][1]["status"], "failure");
    assert_eq!(
        value["result"]["value"][1]["error"]["code"],
        "validation_error"
    );
    Ok(())
}

fn runx_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_runx"));
    command.env("NO_COLOR", "1");
    if let Ok(root) = repo_root() {
        command.env("RUNX_CWD", root);
    }
    command
}

fn repo_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?)
}

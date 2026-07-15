use std::fs;
use std::process::Command;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[test]
fn scaffolded_next_steps_run_without_signer_env() -> TestResult {
    let root = crate::support::temp_root("runx-new-next-steps");
    fs::create_dir_all(&root)?;
    let skill_dir = root.join("receipt-demo");

    let scaffold = unsigned_runx_command()?
        .current_dir(&root)
        .args([
            "new",
            "receipt-demo",
            "--directory",
            skill_dir.to_str().ok_or("non-utf8 skill dir")?,
            "--json",
        ])
        .output()?;
    assert_eq!(
        scaffold.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&scaffold.stderr)
    );

    let harness = unsigned_runx_command()?
        .current_dir(&skill_dir)
        .args(["harness", ".", "--json"])
        .output()?;
    assert_eq!(
        harness.status.code(),
        Some(0),
        "stdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&harness.stdout),
        String::from_utf8_lossy(&harness.stderr)
    );
    let harness_json = serde_json::from_slice::<serde_json::Value>(&harness.stdout)?;
    assert_eq!(harness_json["status"], "passed");

    let skill = unsigned_runx_command()?
        .current_dir(&skill_dir)
        .args([
            "skill",
            ".",
            "--input",
            "message=hello",
            "--json",
            "--skip-operator-context",
        ])
        .output()?;
    assert_eq!(
        skill.status.code(),
        Some(0),
        "stdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&skill.stdout),
        String::from_utf8_lossy(&skill.stderr)
    );
    let skill_json = serde_json::from_slice::<serde_json::Value>(&skill.stdout)?;
    assert_eq!(skill_json["status"], "sealed");

    Ok(())
}

#[test]
fn package_mode_runs_inline_and_conventional_fixture_cases() -> TestResult {
    let root = crate::support::temp_root("runx-package-harness-union");
    let skill_dir = root.join("skill");
    let receipt_dir = root.join("receipts");
    fs::create_dir_all(skill_dir.join("fixtures"))?;
    write_cli_tool_skill(&skill_dir)?;
    fs::write(
        skill_dir.join("fixtures/conventional.yaml"),
        r#"
name: conventional
kind: skill
target: ..
runner: default
expect:
  status: sealed
"#,
    )?;

    let output = unsigned_runx_command()?
        .env("RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY", "local")
        .args([
            "harness",
            skill_dir.to_str().ok_or("non-utf8 skill dir")?,
            "--receipt-dir",
            receipt_dir.to_str().ok_or("non-utf8 receipt dir")?,
            "--json",
        ])
        .output()?;

    assert_eq!(
        output.status.code(),
        Some(0),
        "stdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    assert_eq!(report["status"], "passed");
    assert_eq!(report["case_count"], 2);
    let names = report["case_names"]
        .as_array()
        .ok_or("missing case_names")?;
    assert!(names.contains(&serde_json::Value::String("smoke".to_owned())));
    assert!(names.contains(&serde_json::Value::String("conventional".to_owned())));
    Ok(())
}

#[test]
fn harness_help_is_native() -> TestResult {
    let output = unsigned_runx_command()?
        .args(["harness", "--help"])
        .output()?;

    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8(output.stdout)?;
    assert!(stdout.contains("runx harness"));
    assert!(stdout.contains("fixtures/*.yaml"));
    assert!(output.stderr.is_empty());
    Ok(())
}

#[test]
fn package_harness_partial_signer_config_prints_actionable_hint() -> TestResult {
    let root = crate::support::temp_root("runx-inline-harness-hint");
    let skill_dir = root.join("skill");
    let receipt_dir = root.join("receipts");
    fs::create_dir_all(&skill_dir)?;
    write_cli_tool_skill(&skill_dir)?;

    let mut command = unsigned_runx_command()?;
    command.env("RUNX_RECEIPT_SIGN_KID", "partial-explicit-key");
    let output = command
        .args([
            "harness",
            skill_dir.to_str().ok_or("non-utf8 skill dir")?,
            "--receipt-dir",
            receipt_dir.to_str().ok_or("non-utf8 receipt dir")?,
            "--json",
        ])
        .output()?;

    assert_eq!(output.status.code(), Some(1));
    let report = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    assert_eq!(report["status"], "failed");
    let stderr = String::from_utf8(output.stderr)?;
    assert!(stderr.contains("package harnesses seal signed receipts"));
    assert!(stderr.contains("RUNX_RECEIPT_SIGN_KID"));

    Ok(())
}

fn unsigned_runx_command() -> TestResult<Command> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_runx"));
    command.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    command.env("NO_COLOR", "1");
    command.current_dir(crate::support::repo_root()?);
    Ok(command)
}

fn write_cli_tool_skill(skill_dir: &std::path::Path) -> TestResult {
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: harness-hint\n---\n# Harness Hint\n",
    )?;
    fs::write(
        skill_dir.join("X.yaml"),
        r#"
skill: harness-hint
version: "0.1.0"

harness:
  cases:
    - name: smoke
      runner: default
      expect:
        status: sealed

runners:
  default:
    default: true
    type: cli-tool
    command: sh
    args:
      - -c
      - 'printf "{\"ok\":true}"'
    timeout_seconds: 5
    sandbox:
      profile: readonly
      cwd_policy: skill-directory
      require_enforcement: false
"#,
    )?;
    Ok(())
}

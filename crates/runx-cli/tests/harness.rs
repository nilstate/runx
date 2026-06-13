use std::fs;
use std::process::Command;

#[test]
fn inline_harness_missing_signer_prints_actionable_hint() -> Result<(), Box<dyn std::error::Error>>
{
    let root = crate::support::temp_root("runx-inline-harness-hint");
    let skill_dir = root.join("skill");
    let receipt_dir = root.join("receipts");
    fs::create_dir_all(&skill_dir)?;
    write_cli_tool_skill(&skill_dir)?;

    let output = unsigned_runx_command()?
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
    assert!(stderr.contains("inline harnesses seal signed receipts"));
    assert!(stderr.contains("RUNX_RECEIPT_SIGN_KID"));
    assert!(stderr.contains("run.sh"));

    Ok(())
}

fn unsigned_runx_command() -> Result<Command, Box<dyn std::error::Error>> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_runx"));
    command.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    command.env("NO_COLOR", "1");
    command.current_dir(crate::support::repo_root()?);
    Ok(command)
}

fn write_cli_tool_skill(skill_dir: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
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

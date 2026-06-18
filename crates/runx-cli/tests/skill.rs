use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine;
use ring::signature::KeyPair;
use serde_json::json;

const TEST_MANIFEST_KEY_ID: &str = "runx-registry-skill-test-key";
const TEST_MANIFEST_SIGNER_ID: &str = "runx-registry-skill-test-signer";
const TEST_MANIFEST_SEED: [u8; 32] = [7; 32];

#[test]
fn native_skill_pauses_and_resumes_with_run_id() -> Result<(), Box<dyn std::error::Error>> {
    let root = crate::support::temp_root("runx-skill");
    let skill_dir = write_agent_task_skill(&root)?;
    let receipt_dir = root.join("receipts");

    let pause = runx_command()
        .args([
            "skill",
            skill_dir.to_str().ok_or("non-utf8 skill dir")?,
            "--receipt-dir",
            receipt_dir.to_str().ok_or("non-utf8 receipt dir")?,
            "--json",
            "--non-interactive",
            "--thread-title",
            "Docs bug",
        ])
        .output()?;
    let pause_json = assert_json(&pause, Some(2))?;
    assert_eq!(pause_json["status"], "needs_agent");
    assert_eq!(pause_json["run_id"], "run_agent_task-issue-intake-output");
    assert_eq!(pause_json["requests"][0]["kind"], "agent_act");

    let answers_path = root.join("answers.json");
    fs::write(
        &answers_path,
        serde_json::json!({
            "answers": {
                "agent_task.issue-intake.output": {
                    "intake_report": {
                        "summary": "Docs bug is bounded."
                    }
                }
            }
        })
        .to_string(),
    )?;

    let resume = runx_command()
        .args([
            "skill",
            skill_dir.to_str().ok_or("non-utf8 skill dir")?,
            "--receipt-dir",
            receipt_dir.to_str().ok_or("non-utf8 receipt dir")?,
            "--run-id",
            "issue-intake-run",
            "--answers",
            answers_path.to_str().ok_or("non-utf8 answers path")?,
            "--json",
            "--non-interactive",
        ])
        .output()?;
    let resume_json = assert_json(&resume, Some(0))?;
    assert_eq!(resume_json["status"], "sealed");
    assert_eq!(resume_json["run_id"], "issue-intake-run");
    assert_eq!(resume_json["closure"]["disposition"], "closed");
    assert_eq!(resume_json["receipt"]["schema"], "runx.receipt.v1");
    let receipt_id = resume_json["receipt_id"]
        .as_str()
        .ok_or("missing receipt_id")?;
    assert!(receipt_dir.join(format!("{receipt_id}.json")).exists());

    Ok(())
}

#[test]
fn native_skill_resolves_bare_local_skill_and_documented_input_flags()
-> Result<(), Box<dyn std::error::Error>> {
    let root = crate::support::temp_root("runx-skill-bare-ref");
    let skills_root = root.join("skills");
    fs::create_dir_all(&skills_root)?;
    let skill_dir = write_agent_task_skill(&skills_root)?;
    let receipt_dir = root.join("receipts");

    let output = runx_command()
        .current_dir(&root)
        .args([
            "skill",
            "issue-intake",
            "--receipt-dir",
            receipt_dir.to_str().ok_or("non-utf8 receipt dir")?,
            "--input",
            "thread-title=Docs bug",
            "--input",
            "severity",
            "low",
            "--json",
            "--non-interactive",
        ])
        .output()?;
    let output_json = assert_json(&output, Some(2))?;
    let inputs = &output_json["requests"][0]["invocation"]["envelope"]["inputs"];
    assert_eq!(inputs["thread_title"], "Docs bug");
    assert_eq!(inputs["severity"], "low");
    let actual_skill_dir = PathBuf::from(
        output_json["requests"][0]["invocation"]["envelope"]["execution_location"]
            ["skill_directory"]
            .as_str()
            .ok_or("missing skill directory")?,
    );
    assert_eq!(actual_skill_dir.canonicalize()?, skill_dir.canonicalize()?);

    Ok(())
}

#[test]
fn native_skill_runner_flag_selects_non_default_runner() -> Result<(), Box<dyn std::error::Error>> {
    let root = crate::support::temp_root("runx-skill-runner-flag");
    let skill_dir = write_multi_runner_skill(&root)?;
    let receipt_dir = root.join("receipts");

    let output = runx_command()
        .args([
            "skill",
            skill_dir.to_str().ok_or("non-utf8 skill dir")?,
            "--runner",
            "second",
            "--receipt-dir",
            receipt_dir.to_str().ok_or("non-utf8 receipt dir")?,
            "--json",
            "--non-interactive",
        ])
        .output()?;
    let output_json = assert_json(&output, Some(2))?;
    assert_eq!(
        output_json["requests"][0]["id"],
        "agent_task.second-task.output"
    );

    Ok(())
}

#[test]
fn native_skill_exported_shim_resolves_to_source_skill() -> Result<(), Box<dyn std::error::Error>> {
    let root = crate::support::temp_root("runx-skill-exported-shim");
    let source_dir = write_agent_task_skill(&root.join("source with spaces"))?;
    let shim_dir = root.join("claude").join("issue-intake");
    fs::create_dir_all(&shim_dir)?;
    fs::write(
        shim_dir.join("SKILL.md"),
        format!(
            "---\nname: issue-intake\n---\n# issue-intake\n<!-- runx-export:claude source={} - generated, do not edit -->\n",
            source_dir.display()
        ),
    )?;

    let output = runx_command()
        .args([
            "skill",
            shim_dir.to_str().ok_or("non-utf8 shim dir")?,
            "--thread-title",
            "Docs bug",
            "--json",
            "--non-interactive",
        ])
        .output()?;
    let output_json = assert_json(&output, Some(2))?;
    let actual_source_dir = PathBuf::from(
        output_json["requests"][0]["invocation"]["envelope"]["execution_location"]
            ["skill_directory"]
            .as_str()
            .ok_or("missing skill directory")?,
    );
    assert_eq!(
        actual_source_dir.canonicalize()?,
        source_dir.canonicalize()?
    );

    Ok(())
}

#[test]
fn native_skill_resolves_trusted_registry_ref() -> Result<(), Box<dyn std::error::Error>> {
    let root = crate::support::temp_root("runx-skill-registry-ref");
    let registry_dir = publish_registry_echo_version(&root, "1.0.0", "# Echo\n", true)?;
    let output = trusted_registry_runx_command(&root)?
        .args([
            "skill",
            "acme/echo@1.0.0",
            "--registry",
            registry_dir.to_str().ok_or("non-utf8 registry dir")?,
            "--json",
            "--non-interactive",
        ])
        .output()?;
    let output_json = assert_json(&output, Some(2))?;
    let skill_dir = needs_agent_skill_directory(&output_json)?;
    assert!(skill_dir.join("SKILL.md").exists());
    assert!(skill_dir.join("X.yaml").exists());
    assert!(skill_dir.to_string_lossy().contains("registry-skills"));
    assert!(skill_dir.to_string_lossy().contains("1.0.0"));

    Ok(())
}

#[test]
fn native_skill_registry_run_reports_provenance() -> Result<(), Box<dyn std::error::Error>> {
    let root = crate::support::temp_root("runx-skill-registry-provenance");
    let registry_dir = publish_registry_echo_version(&root, "1.0.0", "# Echo\n", true)?;

    let json_output = trusted_registry_runx_command(&root)?
        .args([
            "skill",
            "acme/echo@1.0.0",
            "--registry",
            registry_dir.to_str().ok_or("non-utf8 registry dir")?,
            "--json",
            "--non-interactive",
        ])
        .output()?;
    let output_json = assert_json(&json_output, Some(2))?;
    let provenance = output_json["registry_provenance"]
        .as_object()
        .ok_or("missing registry provenance")?;
    assert_eq!(provenance["skill_id"], "acme/echo");
    assert_eq!(provenance["version"], "1.0.0");
    assert_eq!(provenance["trust_tier"], "community");
    assert_eq!(provenance["registry_key_id"], TEST_MANIFEST_KEY_ID);
    assert_eq!(provenance["trust_state"], "trusted");
    assert_eq!(
        provenance["registry_source"],
        format!("local {}", registry_dir.display())
    );
    assert!(
        provenance["digest"]
            .as_str()
            .is_some_and(|value| value.starts_with("sha256:"))
    );
    assert!(
        provenance["profile_digest"]
            .as_str()
            .is_some_and(|value| value.starts_with("sha256:"))
    );
    assert!(
        provenance["registry_source_fingerprint"]
            .as_str()
            .is_some_and(|value| value.len() == 16)
    );

    let text_output = trusted_registry_runx_command(&root)?
        .args([
            "skill",
            "acme/echo@1.0.0",
            "--registry",
            registry_dir.to_str().ok_or("non-utf8 registry dir")?,
            "--non-interactive",
        ])
        .output()?;
    assert_eq!(text_output.status.code(), Some(2));
    let stdout = String::from_utf8(text_output.stdout)?;
    assert!(stdout.contains("registry:"));
    assert!(stdout.contains("  skill_id: acme/echo"));
    assert!(stdout.contains("  version: 1.0.0"));
    assert!(stdout.contains(&format!(
        "  registry_source: local {}",
        registry_dir.display()
    )));
    assert!(stdout.contains("  trust_tier: community"));
    assert!(stdout.contains("  registry_key_id: runx-registry-skill-test-key"));

    Ok(())
}

#[test]
fn native_skill_registry_run_reports_provenance_on_execution_error()
-> Result<(), Box<dyn std::error::Error>> {
    let root = crate::support::temp_root("runx-skill-registry-error-provenance");
    let registry_dir = publish_registry_echo_version(&root, "1.0.0", "# Echo\n", true)?;

    let json_output = trusted_registry_runx_command(&root)?
        .args([
            "skill",
            "acme/echo@1.0.0",
            "--registry",
            registry_dir.to_str().ok_or("non-utf8 registry dir")?,
            "--runner",
            "missing-runner",
            "--json",
            "--non-interactive",
        ])
        .output()?;
    let output_json = assert_json(&json_output, Some(1))?;
    assert_eq!(output_json["status"], "failure");
    let provenance = output_json["registry_provenance"]
        .as_object()
        .ok_or("missing registry provenance")?;
    assert_eq!(provenance["skill_id"], "acme/echo");
    assert_eq!(provenance["version"], "1.0.0");
    assert_eq!(provenance["trust_state"], "trusted");

    Ok(())
}

#[test]
fn native_skill_resolves_registry_versions_side_by_side() -> Result<(), Box<dyn std::error::Error>>
{
    let root = crate::support::temp_root("runx-skill-registry-versions");
    let registry_dir = root.join("registry");
    publish_registry_echo_version_into(&root, &registry_dir, "1.0.0", "# Echo\n", true)?;
    publish_registry_echo_version_into(
        &root,
        &registry_dir,
        "1.1.0",
        "# Echo\n\nVersion two.\n",
        true,
    )?;

    let v1 = trusted_registry_runx_command(&root)?
        .args([
            "skill",
            "acme/echo@1.0.0",
            "--registry",
            registry_dir.to_str().ok_or("non-utf8 registry dir")?,
            "--json",
            "--non-interactive",
        ])
        .output()?;
    let v1_json = assert_json(&v1, Some(2))?;
    let v1_dir = needs_agent_skill_directory(&v1_json)?;

    let v2 = trusted_registry_runx_command(&root)?
        .args([
            "skill",
            "acme/echo@1.1.0",
            "--registry",
            registry_dir.to_str().ok_or("non-utf8 registry dir")?,
            "--json",
            "--non-interactive",
        ])
        .output()?;
    let v2_json = assert_json(&v2, Some(2))?;
    let v2_dir = needs_agent_skill_directory(&v2_json)?;

    assert_ne!(v1_dir, v2_dir);
    assert!(v1_dir.to_string_lossy().contains("1.0.0"));
    assert!(v2_dir.to_string_lossy().contains("1.1.0"));
    assert_eq!(
        fs::read_to_string(v1_dir.join("SKILL.md"))?,
        "---\nname: echo\n---\n# Echo\n"
    );
    assert_eq!(
        fs::read_to_string(v2_dir.join("SKILL.md"))?,
        "---\nname: echo\n---\n# Echo\n\nVersion two.\n"
    );

    Ok(())
}

#[test]
fn native_skill_rejects_untrusted_registry_refs() -> Result<(), Box<dyn std::error::Error>> {
    let unsigned_root = crate::support::temp_root("runx-skill-registry-unsigned");
    let unsigned_registry =
        publish_registry_echo_version(&unsigned_root, "1.0.0", "# Echo\n", false)?;
    let unsigned = trusted_registry_runx_command(&unsigned_root)?
        .args([
            "skill",
            "acme/echo@1.0.0",
            "--registry",
            unsigned_registry.to_str().ok_or("non-utf8 registry dir")?,
            "--json",
            "--non-interactive",
        ])
        .output()?;
    let unsigned_json = assert_json(&unsigned, Some(1))?;
    assert_eq!(unsigned_json["status"], "failure");
    assert_eq!(unsigned_json["error"]["code"], "skill_error");
    assert!(
        unsigned_json["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("registry signed manifest is required"))
    );
    assert!(!unsigned_root.join("home").join("registry-skills").exists());

    let mismatch_root = crate::support::temp_root("runx-skill-registry-digest-mismatch");
    let mismatch_registry =
        publish_registry_echo_version(&mismatch_root, "1.0.0", "# Echo\n", true)?;
    let mismatch = trusted_registry_runx_command(&mismatch_root)?
        .args([
            "skill",
            "acme/echo@1.0.0",
            "--registry",
            mismatch_registry.to_str().ok_or("non-utf8 registry dir")?,
            "--digest",
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "--json",
            "--non-interactive",
        ])
        .output()?;
    let mismatch_json = assert_json(&mismatch, Some(1))?;
    assert_eq!(mismatch_json["status"], "failure");
    assert_eq!(mismatch_json["error"]["code"], "skill_error");
    assert!(
        mismatch_json["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("digest mismatch"))
    );
    assert!(!mismatch_root.join("home").join("registry-skills").exists());

    Ok(())
}

#[test]
fn native_skill_json_parse_failure_uses_failure_envelope() -> Result<(), Box<dyn std::error::Error>>
{
    let output = runx_command().args(["skill", "--json"]).output()?;

    let value = assert_json(&output, Some(64))?;
    assert_eq!(value["status"], "failure");
    assert_eq!(value["error"]["code"], "invalid_args");
    assert!(
        value["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("runx skill requires a skill package path"))
    );

    Ok(())
}

#[test]
fn native_skill_text_output_is_concise_for_pending_agent_request()
-> Result<(), Box<dyn std::error::Error>> {
    let root = crate::support::temp_root("runx-skill-text-output");
    let skill_dir = write_agent_task_skill(&root)?;

    let output = runx_command()
        .args([
            "skill",
            skill_dir.to_str().ok_or("non-utf8 skill dir")?,
            "--thread-title",
            "Docs bug",
            "--non-interactive",
        ])
        .output()?;

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(String::from_utf8(output.stderr)?, "");
    let stdout = String::from_utf8(output.stdout)?;
    assert!(stdout.contains("status: needs_agent"));
    assert!(stdout.contains("pending_requests: 1"));
    assert!(stdout.contains("agent_task.issue-intake.output"));
    assert!(stdout.contains(skill_dir.to_str().ok_or("non-utf8 skill dir")?));
    assert!(stdout.contains("--run-id run_agent_task-issue-intake-output --answers answers.json"));
    assert!(!stdout.contains("<answers.json>"));
    assert!(!stdout.trim_start().starts_with('{'));

    Ok(())
}

#[test]
fn native_skill_text_output_includes_copy_paste_resume_command()
-> Result<(), Box<dyn std::error::Error>> {
    native_skill_text_output_is_concise_for_pending_agent_request()
}

#[test]
fn native_skill_rejects_answers_without_run_id() -> Result<(), Box<dyn std::error::Error>> {
    let root = crate::support::temp_root("runx-skill-reject-answers");
    let skill_dir = write_agent_task_skill(&root)?;
    let answers_path = root.join("answers.json");
    fs::write(&answers_path, "{}")?;
    let output = runx_command()
        .args([
            "skill",
            skill_dir.to_str().ok_or("non-utf8 skill dir")?,
            "--answers",
            answers_path.to_str().ok_or("non-utf8 answers path")?,
        ])
        .output()?;

    assert_eq!(output.status.code(), Some(64));
    assert!(String::from_utf8(output.stderr)?.contains("runx skill --answers requires --run-id"));
    assert_eq!(String::from_utf8(output.stdout)?, "");

    Ok(())
}

#[test]
fn native_skill_rejects_run_id_without_answers() -> Result<(), Box<dyn std::error::Error>> {
    let root = crate::support::temp_root("runx-skill-reject-run-id");
    let skill_dir = write_agent_task_skill(&root)?;
    let output = runx_command()
        .args([
            "skill",
            skill_dir.to_str().ok_or("non-utf8 skill dir")?,
            "--run-id",
            "issue-intake-run",
        ])
        .output()?;

    assert_eq!(output.status.code(), Some(64));
    assert!(String::from_utf8(output.stderr)?.contains("runx skill --run-id requires --answers"));
    assert_eq!(String::from_utf8(output.stdout)?, "");

    Ok(())
}

#[test]
fn native_skill_rejects_retired_receipt_options() -> Result<(), Box<dyn std::error::Error>> {
    let root = crate::support::temp_root("runx-skill-reject-retired-receipt");
    let skill_dir = write_agent_task_skill(&root)?;
    let receipt_dir = root.join("receipts");
    let retired_receipt = format!("--{}", "receipt");
    let retired_receipt_dir = format!("--{}", ["receipt", "Dir"].concat());
    let retired_receipt_dir_equals = format!(
        "{}={}",
        retired_receipt_dir,
        receipt_dir.to_str().ok_or("non-utf8 receipt dir")?
    );

    for args in [
        vec![
            "skill".to_owned(),
            skill_dir.to_str().ok_or("non-utf8 skill dir")?.to_owned(),
            retired_receipt,
            receipt_dir
                .to_str()
                .ok_or("non-utf8 receipt dir")?
                .to_owned(),
        ],
        vec![
            "skill".to_owned(),
            skill_dir.to_str().ok_or("non-utf8 skill dir")?.to_owned(),
            retired_receipt_dir,
            receipt_dir
                .to_str()
                .ok_or("non-utf8 receipt dir")?
                .to_owned(),
        ],
        vec![
            "skill".to_owned(),
            skill_dir.to_str().ok_or("non-utf8 skill dir")?.to_owned(),
            retired_receipt_dir_equals,
        ],
    ] {
        let output = runx_command().args(args).output()?;
        assert_eq!(output.status.code(), Some(64));
        assert!(String::from_utf8(output.stderr)?.contains("retired runx skill receipt option"));
        assert_eq!(String::from_utf8(output.stdout)?, "");
    }

    Ok(())
}

fn runx_command() -> Command {
    crate::support::signed_runx_command("skill-test-key")
}

fn trusted_registry_runx_command(root: &Path) -> Result<Command, Box<dyn std::error::Error>> {
    let mut command = crate::support::signed_runx_command("skill-test-key");
    let key_pair = test_manifest_key_pair()?;
    command.env("RUNX_HOME", root.join("home"));
    command.env(
        runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ENV,
        base64::engine::general_purpose::STANDARD.encode(key_pair.public_key().as_ref()),
    );
    command.env(
        runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID_ENV,
        TEST_MANIFEST_KEY_ID,
    );
    command.env(
        runx_runtime::registry::RUNX_REGISTRY_MANIFEST_TRUST_OWNER_ENV,
        "acme",
    );
    Ok(command)
}

fn assert_json(
    output: &std::process::Output,
    expected_status: Option<i32>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    if let Some(expected_status) = expected_status {
        assert_eq!(
            output.status.code(),
            Some(expected_status),
            "stderr={}\nstdout={}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
    }
    assert!(
        output.status.success() || expected_status.is_some(),
        "status={:?}\nstderr={}\nstdout={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(String::from_utf8(output.stderr.clone())?, "");
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn write_agent_task_skill(root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let skill_dir = root.join("issue-intake");
    fs::create_dir_all(&skill_dir)?;
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: issue-intake\n---\n# Issue Intake\n",
    )?;
    fs::write(
        skill_dir.join("X.yaml"),
        r#"
skill: issue-intake
runners:
  intake:
    default: true
    type: agent-task
    agent: builder
    task: issue-intake
    outputs:
      intake_report: object
    inputs:
      thread_title:
        type: string
        required: false
"#,
    )?;
    Ok(skill_dir)
}

fn write_multi_runner_skill(root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let skill_dir = root.join("multi-runner");
    fs::create_dir_all(&skill_dir)?;
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: multi-runner\n---\n# Multi Runner\n",
    )?;
    fs::write(
        skill_dir.join("X.yaml"),
        r#"
skill: multi-runner
runners:
  first:
    default: true
    type: agent-task
    agent: builder
    task: first-task
    outputs:
      result: object
  second:
    type: agent-task
    agent: builder
    task: second-task
    outputs:
      result: object
"#,
    )?;
    Ok(skill_dir)
}

fn publish_registry_echo_version(
    root: &Path,
    version: &str,
    markdown_body: &str,
    signed: bool,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let registry_dir = root.join("registry");
    publish_registry_echo_version_into(root, &registry_dir, version, markdown_body, signed)?;
    Ok(registry_dir)
}

fn publish_registry_echo_version_into(
    root: &Path,
    registry_dir: &Path,
    version: &str,
    markdown_body: &str,
    signed: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let skill_dir = root.join(format!("skill-{version}"));
    fs::create_dir_all(&skill_dir)?;
    fs::write(
        skill_dir.join("SKILL.md"),
        format!("---\nname: echo\n---\n{markdown_body}"),
    )?;
    fs::write(
        skill_dir.join("X.yaml"),
        include_str!("../../../fixtures/registry/install/echo-X.yaml"),
    )?;
    let publish = trusted_registry_runx_command(root)?
        .args([
            "registry",
            "publish",
            skill_dir.to_str().ok_or("non-utf8 skill dir")?,
            "--registry-dir",
            registry_dir.to_str().ok_or("non-utf8 registry dir")?,
            "--owner",
            "acme",
            "--version",
            version,
            "--json",
        ])
        .output()?;
    assert!(
        publish.status.success(),
        "stderr={}\nstdout={}",
        String::from_utf8_lossy(&publish.stderr),
        String::from_utf8_lossy(&publish.stdout)
    );
    if signed {
        sign_registry_version(registry_dir, version)?;
    }
    Ok(())
}

fn sign_registry_version(
    registry_dir: &Path,
    version: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let version_path = registry_dir
        .join("acme")
        .join("echo")
        .join(format!("{version}.json"));
    let mut version_record =
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&version_path)?)?;
    version_record["signed_manifest"] = signed_manifest(&version_record)?;
    fs::write(
        version_path,
        format!("{}\n", serde_json::to_string_pretty(&version_record)?),
    )?;
    Ok(())
}

fn signed_manifest(
    version_record: &serde_json::Value,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let skill_id = version_record["skill_id"]
        .as_str()
        .ok_or("missing skill_id")?;
    let version = version_record["version"]
        .as_str()
        .ok_or("missing version")?;
    let digest = version_record["digest"].as_str().ok_or("missing digest")?;
    let profile_digest = version_record["profile_digest"].as_str();
    let package_digest = version_record["package_digest"].as_str();
    let payload =
        registry_manifest_payload(skill_id, version, digest, profile_digest, package_digest);
    let signature = test_manifest_key_pair()?.sign(payload.as_bytes());
    Ok(json!({
        "schema": runx_runtime::registry::REGISTRY_SIGNED_MANIFEST_SCHEMA,
        "skill_id": skill_id,
        "version": version,
        "digest": digest,
        "profile_digest": profile_digest,
        "package_digest": package_digest,
        "signer": {
            "id": TEST_MANIFEST_SIGNER_ID,
            "key_id": TEST_MANIFEST_KEY_ID,
        },
        "signature": {
            "alg": "ed25519",
            "value": format!(
                "base64:{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.as_ref())
            ),
        },
    }))
}

fn registry_manifest_payload(
    skill_id: &str,
    version: &str,
    digest: &str,
    profile_digest: Option<&str>,
    package_digest: Option<&str>,
) -> String {
    format!(
        "{}\nskill_id={skill_id}\nversion={version}\ndigest={digest}\nprofile_digest={}\npackage_digest={}\nsigner_id={TEST_MANIFEST_SIGNER_ID}\nkey_id={TEST_MANIFEST_KEY_ID}\n",
        runx_runtime::registry::REGISTRY_SIGNED_MANIFEST_SCHEMA,
        profile_digest.unwrap_or(""),
        package_digest.unwrap_or("")
    )
}

fn test_manifest_key_pair() -> Result<ring::signature::Ed25519KeyPair, io::Error> {
    ring::signature::Ed25519KeyPair::from_seed_unchecked(&TEST_MANIFEST_SEED).map_err(|error| {
        io::Error::other(format!("static registry manifest seed rejected: {error:?}"))
    })
}

fn needs_agent_skill_directory(
    value: &serde_json::Value,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(PathBuf::from(
        value["requests"][0]["invocation"]["envelope"]["execution_location"]["skill_directory"]
            .as_str()
            .ok_or("missing skill directory")?,
    ))
}

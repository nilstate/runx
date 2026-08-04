use std::fs;
use std::path::Path;
use std::process::{Command, Output};

use serde_json::Value;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[test]
fn skill_author_journey_discovers_harnesses_runs_verifies_and_reads_history() -> TestResult {
    let root = crate::support::temp_root("runx-operator-author-journey");
    let skills_dir = root.join("skills");
    let skill_dir = skills_dir.join("digest-note");
    let receipt_dir = root.join(".runx/receipts");
    fs::create_dir_all(&skill_dir)?;
    fs::write(
        skill_dir.join("SKILL.md"),
        crate::new_skill_authoring::digest_note_manual(),
    )?;
    fs::write(
        skill_dir.join("X.yaml"),
        crate::new_skill_authoring::digest_note_manifest(),
    )?;

    let list = command(&root)
        .args(["list", "skills", "--ok-only", "--json"])
        .output()?;
    let list = assert_json(&list, 0)?;
    let listed = list["items"]
        .as_array()
        .ok_or("list items must be an array")?
        .iter()
        .find(|item| item["name"] == "digest-note")
        .ok_or("authored skill was not discoverable")?;
    assert_eq!(listed["status"], "ok");

    let inspect = command(&root)
        .arg("skill")
        .arg("inspect")
        .arg(&skill_dir)
        .arg("--json")
        .output()?;
    let inspect = assert_json(&inspect, 0)?;
    assert_eq!(inspect["status"], "ok");
    assert_eq!(inspect["readiness"]["status"], "ready");
    assert_eq!(inspect["capabilities"]["execution"], "read");
    assert_eq!(inspect["capabilities"]["completion"], "runtime_receipt");
    assert_eq!(inspect["runner"]["type"], "graph");
    assert!(
        inspect["runner"]["inputs"]
            .as_array()
            .is_some_and(|inputs| inputs.iter().any(|input| input["name"] == "note"))
    );

    let harness = command(&root)
        .arg("harness")
        .arg(&skill_dir)
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .arg("--json")
        .output()?;
    let harness = assert_json(&harness, 0)?;
    assert_eq!(harness["status"], "passed");
    assert_eq!(harness["case_count"], 1);

    let run = command(&root)
        .arg("skill")
        .arg(&skill_dir)
        .args(["--input", "note=hello"])
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .args(["--json"])
        .output()?;
    let run = assert_json(&run, 0)?;
    assert_eq!(run["status"], "sealed");
    let receipt_id = json_string(&run, "receipt_id")?;

    assert_receipt_verifies(&root, &receipt_dir, receipt_id)?;
    assert_history_contains_local_receipt(&root, &receipt_dir, receipt_id)?;

    Ok(())
}

#[test]
fn agent_handoff_journey_pauses_recovers_resumes_verifies_and_clears_history() -> TestResult {
    let root = crate::support::temp_root("runx-operator-agent-handoff-journey");
    let skill_dir = crate::support::write_agent_task_skill(&root.join("skills"))?;
    let receipt_dir = root.join(".runx/receipts");

    let pause = command(&root)
        .arg("skill")
        .arg(&skill_dir)
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .args(["--thread-title", "Docs bug", "--non-interactive"])
        .output()?;
    assert_exit(&pause, 2)?;
    let pause_text = String::from_utf8(pause.stdout)?;
    assert!(pause_text.contains("status: needs_agent"));
    assert!(pause_text.contains("pending_requests: 1"));
    assert!(pause_text.contains("agent_task.issue-intake.output"));
    assert!(!pause_text.contains("<answers.json>"));
    assert!(!pause_text.trim_start().starts_with('{'));
    let run_id = pause_text
        .lines()
        .find_map(|line| line.strip_prefix("run_id: "))
        .ok_or("pending run omitted run_id")?
        .to_owned();
    assert!(run_id.starts_with("run_agent_task-issue-intake-output_"));
    assert!(pause_text.contains(&format!("runx resume {run_id} answers.json")));

    let pending = history_json(&root, &receipt_dir, &run_id)?;
    assert!(
        pending["pendingRuns"]
            .as_array()
            .is_some_and(|runs| runs.iter().any(|run| run["id"] == run_id))
    );

    let malformed_answers = root.join("malformed-answers.json");
    fs::write(
        &malformed_answers,
        serde_json::json!({
            "answers": {
                "agent_task.issue-intake.output": {
                    "intake_report": "not-an-object"
                }
            }
        })
        .to_string(),
    )?;
    let malformed = command(&root)
        .arg("resume")
        .arg(&run_id)
        .arg(&malformed_answers)
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .arg("--json")
        .output()?;
    let malformed = assert_json(&malformed, 1)?;
    assert_eq!(malformed["status"], "failure");

    let answers = root.join("answers.json");
    fs::write(
        &answers,
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
    let resume = command(&root)
        .arg("resume")
        .arg(&run_id)
        .arg(&answers)
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .arg("--json")
        .output()?;
    let resume = assert_json(&resume, 0)?;
    assert_eq!(resume["status"], "sealed");
    assert_eq!(resume["schema"], "runx.skill_run.v1");
    assert_eq!(resume["run_id"], run_id);
    assert_eq!(resume["closure"]["disposition"], "closed");
    assert!(resume.get("receipt").is_none());
    assert!(resume.get("execution").is_none());
    let receipt_id = json_string(&resume, "receipt_id")?;

    assert_receipt_verifies(&root, &receipt_dir, receipt_id)?;
    let history = assert_history_contains_local_receipt(&root, &receipt_dir, receipt_id)?;
    assert!(
        history["pendingRuns"]
            .as_array()
            .is_some_and(|runs| runs.iter().all(|run| run["id"] != run_id))
    );

    Ok(())
}

#[test]
fn declined_and_superseded_agent_runs_preserve_receipts_and_exit_nonzero() -> TestResult {
    let root = crate::support::temp_root("runx-operator-terminal-disposition-journey");

    for disposition in ["declined", "superseded"] {
        let case_root = root.join(disposition);
        let skill_dir = crate::support::write_agent_task_skill(&case_root.join("skills"))?;
        let receipt_dir = case_root.join(".runx/receipts");

        let pause = command(&case_root)
            .arg("skill")
            .arg(&skill_dir)
            .arg("--receipt-dir")
            .arg(&receipt_dir)
            .args(["--json", "--non-interactive"])
            .output()?;
        let pause = assert_json(&pause, 2)?;
        let run_id = json_string(&pause, "run_id")?;
        let request_id = pause["requests"]
            .as_array()
            .and_then(|requests| requests.first())
            .and_then(|request| request["id"].as_str())
            .ok_or("pending run omitted its request id")?;
        let answers = case_root.join("answers.json");
        fs::write(
            &answers,
            serde_json::json!({
                "answers": {
                    request_id: {
                        "intake_report": {
                            "summary": format!("Operator chose {disposition}.")
                        },
                        "closure": {
                            "disposition": disposition
                        }
                    }
                }
            })
            .to_string(),
        )?;

        let resume = command(&case_root)
            .arg("resume")
            .arg(run_id)
            .arg(&answers)
            .arg("--receipt-dir")
            .arg(&receipt_dir)
            .arg("--json")
            .output()?;
        let resume = assert_json(&resume, 1)?;
        assert_eq!(resume["status"], "sealed");
        assert_eq!(resume["closure"]["disposition"], disposition);
        assert!(resume.get("receipt").is_none());
        let receipt_id = json_string(&resume, "receipt_id")?;
        assert_receipt_verifies(&case_root, &receipt_dir, receipt_id)?;
        assert_history_contains_local_receipt(&case_root, &receipt_dir, receipt_id)?;
    }

    Ok(())
}

#[test]
fn composite_business_ops_journey_runs_verifies_and_reads_receipt_tree() -> TestResult {
    let root = crate::support::temp_root("runx-operator-business-ops-journey");
    let skill_dir = crate::support::repo_root()?.join("skills/business-ops");
    let receipt_dir = root.join(".runx/receipts");
    fs::create_dir_all(&root)?;

    let run = command(&root)
        .arg("skill")
        .arg(&skill_dir)
        .args([
            "--input",
            "signal=Launch readiness for API v2 with docs, release, customer comms, and spend checks.",
            "--input",
            "operator_context=Live sends route through send-as; payment movement requires a spend gate and provider readback.",
        ])
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .args(["--json"])
        .output()?;
    let run = assert_json(&run, 0)?;

    assert_eq!(run["status"], "sealed");
    assert_eq!(run["closure"]["disposition"], "closed");
    assert_eq!(run["trace"]["graph"], "business-ops");
    assert_eq!(run["trace"]["status"], "succeeded");
    assert_eq!(
        run["trace"]["steps"].as_array().map(|steps| steps
            .iter()
            .map(|step| step["step_id"].clone())
            .collect::<Vec<_>>()),
        Some(
            [
                "classify",
                "docs",
                "release",
                "issue",
                "send",
                "spend",
                "audit",
                "package-route",
            ]
            .into_iter()
            .map(serde_json::Value::from)
            .collect()
        )
    );
    assert!(run.get("receipt").is_none());
    assert!(run.get("execution").is_none());
    let receipt_id = json_string(&run, "receipt_id")?;

    assert_receipt_verifies(&root, &receipt_dir, receipt_id)?;
    assert_history_contains_local_receipt(&root, &receipt_dir, receipt_id)?;

    Ok(())
}

#[test]
fn provider_skill_journey_reports_readiness_and_seals_missing_authority() -> TestResult {
    let root = crate::support::temp_root("runx-operator-provider-readiness-journey");
    let skill_dir = crate::support::repo_root()?.join("skills/google-analytics");
    let receipt_dir = root.join(".runx/receipts");
    fs::create_dir_all(&root)?;

    let incomplete = command(&root)
        .env("RUNX_PROVIDER_PERMISSION_GRANT_ID", "grant_google_read")
        .env(
            "RUNX_PROVIDER_PERMISSION_GRANTED_SCOPES",
            r#"["properties.read","reports.read"]"#,
        )
        .arg("skill")
        .arg("inspect")
        .arg(&skill_dir)
        .arg("properties")
        .arg("--json")
        .output()?;
    let incomplete = assert_json(&incomplete, 0)?;
    assert_ne!(incomplete["provider"]["status"], "ready");

    let inspect = command(&root)
        .env("RUNX_PROVIDER_PERMISSION_GRANT_ID", "grant_google_read")
        .env(
            "RUNX_PROVIDER_PERMISSION_GRANTED_SCOPES",
            r#"["properties.read","reports.read"]"#,
        )
        .env(
            "RUNX_PROVIDER_PERMISSION_PRINCIPAL_REF",
            "runx:principal:operator:test",
        )
        .arg("skill")
        .arg("inspect")
        .arg(&skill_dir)
        .arg("properties")
        .arg("--json")
        .output()?;
    let inspect = assert_json(&inspect, 0)?;
    assert_eq!(inspect["readiness"]["status"], "ready");
    assert_eq!(inspect["provider"]["status"], "ready");
    assert_eq!(
        inspect["provider"]["requirements"][0]["provider"],
        "google-analytics"
    );
    assert_eq!(
        inspect["provider"]["requirements"][0]["operation"],
        "properties.list"
    );
    assert_eq!(
        inspect["provider"]["requirements"][0]["grant_ref"],
        "runx:grant:grant_google_read"
    );

    let denied = command(&root)
        .env(
            "RUNX_PROVIDER_PERMISSION_GRANT_ID",
            "grant_google_wrong_scope",
        )
        .env(
            "RUNX_PROVIDER_PERMISSION_GRANTED_SCOPES",
            r#"["reports.read"]"#,
        )
        .env(
            "RUNX_PROVIDER_PERMISSION_PRINCIPAL_REF",
            "runx:principal:operator:test",
        )
        .arg("skill")
        .arg(&skill_dir)
        .arg("properties")
        .arg("--receipt-dir")
        .arg(&receipt_dir)
        .args(["--json"])
        .output()?;
    let denied = assert_json(&denied, 1)?;
    assert_eq!(denied["status"], "sealed");
    assert_eq!(denied["closure"]["disposition"], "blocked");
    assert_eq!(denied["closure"]["reason_code"], "authority_denied");
    assert_eq!(denied["trace"]["status"], "blocked");
    let receipt_id = json_string(&denied, "receipt_id")?;
    assert_receipt_verifies(&root, &receipt_dir, receipt_id)?;
    assert_history_contains_local_receipt(&root, &receipt_dir, receipt_id)?;

    Ok(())
}

fn command(root: &Path) -> Command {
    crate::support::unsigned_runx_command_at(root)
}

fn assert_receipt_verifies(root: &Path, receipt_dir: &Path, receipt_id: &str) -> TestResult {
    let verify = command(root)
        .arg("verify")
        .arg(receipt_id)
        .arg("--receipt-dir")
        .arg(receipt_dir)
        .args(["--allow-local-development-signatures", "--json"])
        .output()?;
    let verify = assert_json(&verify, 0)?;
    assert_eq!(verify["valid"], true);
    assert!(verify["trees"].as_array().is_some_and(|trees| {
        trees
            .iter()
            .any(|tree| tree["root_receipt_id"] == receipt_id && tree["valid"] == true)
    }));
    Ok(())
}

fn assert_history_contains_local_receipt(
    root: &Path,
    receipt_dir: &Path,
    receipt_id: &str,
) -> TestResult<Value> {
    let history = history_json(root, receipt_dir, receipt_id)?;
    let receipt = history["receipts"]
        .as_array()
        .and_then(|receipts| receipts.iter().find(|receipt| receipt["id"] == receipt_id))
        .ok_or("history did not return the sealed receipt")?;
    // History does not silently opt into local-development signature trust.
    // The explicit verify step above proves the receipt; passive history stays
    // fail-closed and labels the same local receipt as unverified.
    assert_eq!(receipt["verification"]["status"], "unverified");
    Ok(history)
}

fn history_json(root: &Path, receipt_dir: &Path, query: &str) -> TestResult<Value> {
    let output = command(root)
        .arg("history")
        .arg(query)
        .arg("--receipt-dir")
        .arg(receipt_dir)
        .arg("--json")
        .output()?;
    assert_json(&output, 0)
}

fn assert_json(output: &Output, expected_exit: i32) -> TestResult<Value> {
    assert_exit(output, expected_exit)?;
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn assert_exit(output: &Output, expected_exit: i32) -> TestResult {
    assert_eq!(
        output.status.code(),
        Some(expected_exit),
        "stderr={}\nstdout={}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    crate::support::assert_json_stderr(&output.stderr)?;
    Ok(())
}

fn json_string<'a>(value: &'a Value, field: &str) -> TestResult<&'a str> {
    value[field]
        .as_str()
        .ok_or_else(|| format!("missing string field {field}").into())
}

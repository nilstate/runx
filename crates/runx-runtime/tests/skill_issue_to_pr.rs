#![cfg(feature = "cli-tool")]

use std::path::{Path, PathBuf};

use runx_contracts::{ClosureDisposition, JsonValue};
use runx_receipts::{validate_receipt, validate_receipt_tree};
use runx_runtime::{
    HarnessExpectedStatus, HarnessReplayOutput, adapters::cli_tool::CliToolAdapter,
    load_harness_fixture, run_harness_fixture_with_adapter,
};

#[test]
fn issue_to_pr_generated_fixtures_replay_to_needs_agent_receipts()
-> Result<(), Box<dyn std::error::Error>> {
    for case_name in [
        "issue-to-pr-dispatches-first-step",
        "issue-to-pr-reaches-fix-boundary",
    ] {
        let output = run_case(case_name)?;
        assert_eq!(
            output.status,
            HarnessExpectedStatus::NeedsAgent,
            "{case_name}"
        );
        assert_eq!(
            output.receipt.seal.disposition,
            ClosureDisposition::Deferred
        );
        validate_receipt(&output.receipt)
            .map_err(|verification| format!("{case_name}: {:?}", verification.findings))?;
        validate_receipt_tree(&output.receipt, &output.step_receipts)
            .map_err(|verification| format!("{case_name}: {:?}", verification.findings))?;
        assert!(
            output.receipt.id.starts_with("sha256:"),
            "{case_name}: graph receipt id must be content-addressed"
        );
        assert!(
            output
                .step_receipts
                .iter()
                .all(|receipt| receipt.id.starts_with("sha256:")),
            "{case_name}: child receipt ids must be content-addressed"
        );
        assert_eq!(output.receipt.acts.len(), 0);
        // The flat graph receipt carries no inline decisions; governance
        // reasoning lives on the per-step child receipts.
        assert_eq!(output.receipt.decisions.len(), 0);
        assert!(
            !output
                .receipt
                .lineage
                .as_ref()
                .map(|l| l.children.as_slice())
                .unwrap_or_default()
                .is_empty(),
            "{case_name}: graph receipt should cite child receipts"
        );
    }
    Ok(())
}

#[test]
fn issue_to_pr_graph_replay_preserves_agent_request_boundaries()
-> Result<(), Box<dyn std::error::Error>> {
    let first = run_case("issue-to-pr-dispatches-first-step")?;
    assert_eq!(first.step_receipts.len(), 1);
    assert_eq!(
        first.step_receipts[0].seal.disposition,
        ClosureDisposition::Deferred
    );
    assert!(
        first.step_receipts[0]
            .seal
            .summary
            .contains("agent_task.issue-to-pr-author-spec.output")
    );

    let fix_boundary = run_case("issue-to-pr-reaches-fix-boundary")?;
    assert_eq!(fix_boundary.step_receipts.len(), 2);
    assert_eq!(
        fix_boundary.step_receipts[0].seal.disposition,
        ClosureDisposition::Closed
    );
    assert_eq!(
        fix_boundary.step_receipts[1].seal.disposition,
        ClosureDisposition::Deferred
    );
    assert!(
        fix_boundary.step_receipts[1]
            .seal
            .summary
            .contains("agent_task.issue-to-pr-apply-fix.output")
    );
    Ok(())
}

#[test]
fn issue_to_pr_reaches_fix_boundary_preserves_author_spec_answer()
-> Result<(), Box<dyn std::error::Error>> {
    let output = run_case("issue-to-pr-reaches-fix-boundary")?;
    let payload = skill_payload(&output)?;
    let spec_contents = string_field(&payload, "spec_contents")?;

    assert!(spec_contents.contains("task_id: issue-to-pr-reach-fix"));
    assert!(spec_contents.contains("Files impacted:"));
    assert!(spec_contents.contains("README.md"));
    Ok(())
}

#[test]
fn issue_to_pr_generated_fixtures_preserve_product_graph_metadata()
-> Result<(), Box<dyn std::error::Error>> {
    let skill = std::fs::read_to_string(repo_root().join("skills/issue-to-pr/SKILL.md"))?;
    assert!(skill.contains("name: issue-to-pr"));
    assert!(skill.contains("scafld 2.4-compatible"));

    for case_name in [
        "issue-to-pr-dispatches-first-step",
        "issue-to-pr-reaches-fix-boundary",
    ] {
        let fixture = load_harness_fixture(case_path(case_name))?;
        assert_eq!(
            fixture.metadata.get("product_skill"),
            Some(&JsonValue::String("issue-to-pr".to_owned()))
        );
        assert_eq!(
            fixture.metadata.get("runner_kind"),
            Some(&JsonValue::String("graph".to_owned()))
        );
    }
    Ok(())
}

fn run_case(case_name: &str) -> Result<HarnessReplayOutput, Box<dyn std::error::Error>> {
    Ok(run_harness_fixture_with_adapter(
        case_path(case_name),
        CliToolAdapter,
        crate::support::local_harness_runtime_options(),
    )?)
}

fn skill_payload(output: &HarnessReplayOutput) -> Result<JsonValue, Box<dyn std::error::Error>> {
    let skill_output = output
        .skill_output
        .as_ref()
        .ok_or("agent-task fixture did not produce skill output")?;
    Ok(skill_output.value.clone())
}

fn string_field<'a>(
    payload: &'a JsonValue,
    field: &str,
) -> Result<&'a str, Box<dyn std::error::Error>> {
    let JsonValue::Object(object) = payload else {
        return Err("payload is not an object".into());
    };
    match object.get(field) {
        Some(JsonValue::String(value)) => Ok(value),
        Some(_) => Err(format!("{field} is not a string").into()),
        None => Err(format!("{field} is missing").into()),
    }
}

fn case_path(case_name: &str) -> PathBuf {
    fixture_root().join(format!("{case_name}.yaml"))
}

fn fixture_root() -> PathBuf {
    repo_root().join("fixtures/runtime/skills/issue-to-pr/cases")
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

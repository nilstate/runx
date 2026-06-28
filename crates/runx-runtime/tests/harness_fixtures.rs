#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::path::{Path, PathBuf};

use runx_contracts::{ClosureDisposition, JsonObject, JsonValue, ReceiptSchema};
use runx_receipts::canonical_receipt_json;
use runx_runtime::{
    HarnessExpectedStatus, HarnessFixtureError, HarnessFixtureKind, InvocationStatus,
    RuntimeOptions, SkillAdapter, SkillInvocation, SkillOutput, load_harness_fixture,
    parse_harness_fixture, run_harness_fixture_with_adapter,
};

const FIXTURE_CREATED_AT: &str = "2026-05-18T00:00:00Z";

#[test]
fn loads_active_harness_fixtures_without_retired_receipt_fields() -> Result<(), HarnessFixtureError>
{
    for (path, expected_status, expected_disposition) in [
        (
            "fixtures/harness/echo-skill.yaml",
            HarnessExpectedStatus::Sealed,
            ClosureDisposition::Closed,
        ),
        (
            "fixtures/harness/sequential-graph.yaml",
            HarnessExpectedStatus::Sealed,
            ClosureDisposition::Closed,
        ),
    ] {
        let fixture = load_harness_fixture(fixture_path(path))?;
        assert_eq!(fixture.expect.status, Some(expected_status));
        let receipt = fixture
            .expect
            .receipt
            .ok_or(HarnessFixtureError::Required {
                field: "expect.receipt".to_owned(),
            })?;
        assert_eq!(receipt.schema, ReceiptSchema::V1);
        // A suspended (deferred) run carries the "deferred" state; every
        // terminal seal carries "sealed".
        let expected_state = if expected_disposition == ClosureDisposition::Deferred {
            "deferred"
        } else {
            "sealed"
        };
        assert_eq!(receipt.state.as_deref(), Some(expected_state));
        assert_eq!(receipt.disposition, Some(expected_disposition));
    }
    Ok(())
}

#[test]
fn parses_harness_skill_fixture_contract() -> Result<(), HarnessFixtureError> {
    let fixture = load_harness_fixture(fixture_path("fixtures/harness/echo-skill.yaml"))?;

    assert_eq!(fixture.name, "echo-skill");
    assert_eq!(fixture.kind, HarnessFixtureKind::Skill);
    assert_eq!(fixture.target, "../skills/echo");
    let receipt = fixture
        .expect
        .receipt
        .ok_or(HarnessFixtureError::Required {
            field: "expect.receipt".to_owned(),
        })?;
    assert_eq!(receipt.harness_id.as_deref(), Some("hrn_echo-skill_echo"));
    assert_eq!(receipt.reason_code.as_deref(), Some("process_closed"));
    assert_eq!(receipt.act_ids, vec!["act_echo"]);
    Ok(())
}

#[test]
fn parses_harness_graph_fixture_contract() -> Result<(), HarnessFixtureError> {
    let fixture = load_harness_fixture(fixture_path("fixtures/harness/sequential-graph.yaml"))?;

    assert_eq!(fixture.name, "sequential-graph");
    assert_eq!(fixture.kind, HarnessFixtureKind::Graph);
    assert_eq!(fixture.target, "../graphs/sequential/graph.yaml");
    assert_eq!(fixture.expect.steps, vec!["first", "second"]);
    let receipt = fixture
        .expect
        .receipt
        .ok_or(HarnessFixtureError::Required {
            field: "expect.receipt".to_owned(),
        })?;
    assert_eq!(
        receipt.harness_id.as_deref(),
        Some("hrn_sequential-echo_graph")
    );
    assert_eq!(
        receipt.child_receipt_refs,
        vec![
            "runx:receipt:sha256:4bf91309813b3b409c340168892c6b3803602772010b4e8b47d9f7a3153f5da7",
            "runx:receipt:sha256:a94a3b142e795c9c448bf43046eb6c0b9d47b5d4858f483f1bd1bb91bf5dc863"
        ]
    );
    Ok(())
}

#[test]
fn rejects_retired_receipt_kind_field_with_stable_path() {
    for field in [
        "kind".to_owned(),
        retired_execution_receipt_field("skill"),
        retired_execution_receipt_field("graph"),
    ] {
        let result = parse_harness_fixture(&format!(
            r#"
name: old
kind: skill
target: ../skills/echo
expect:
  receipt:
    {field}: value
"#,
        ));

        assert!(matches!(
            result,
            Err(HarnessFixtureError::RetiredReceiptField { field_path })
                if field_path == format!("expect.receipt.{field}")
        ));
    }
}

#[test]
fn retired_receipt_expectations_are_rejected() {
    for field in [
        retired_execution_receipt_field("skill"),
        retired_execution_receipt_field("graph"),
        "skill_name".to_owned(),
        "source_type".to_owned(),
        "graph_name".to_owned(),
        "owner".to_owned(),
    ] {
        let result = parse_harness_fixture(&format!(
            r#"
name: old
kind: skill
target: ../skills/echo
expect:
  receipt:
    {field}: value
"#,
        ));

        assert!(matches!(
            result,
            Err(HarnessFixtureError::RetiredReceiptField { field_path })
                if field_path == format!("expect.receipt.{field}")
        ));
    }
}

#[test]
fn rejects_unsupported_fixture_mode_with_stable_path() {
    let result = parse_harness_fixture(
        r#"
name: old
kind: mcp
target: ../skills/echo
expect:
  status: sealed
"#,
    );

    assert!(matches!(
        result,
        Err(HarnessFixtureError::UnsupportedFixtureMode { mode, field_path })
            if mode == "mcp" && field_path == "kind"
    ));
}

#[test]
fn replays_active_harness_skill_fixture() -> Result<(), Box<dyn std::error::Error>> {
    let output = run_fixture_with_test_adapter("fixtures/harness/echo-skill.yaml")?;

    assert_eq!(output.status, HarnessExpectedStatus::Sealed);
    assert_eq!(output.receipt.subject.reference.uri, "hrn_echo-skill_echo");
    assert_eq!(output.receipt.seal.disposition, ClosureDisposition::Closed);
    let skill_output = output.skill_output.ok_or(HarnessFixtureError::Required {
        field: "skill_output".to_owned(),
    })?;
    assert_eq!(skill_output.stdout, "{\"message\":\"hello from harness\"}");
    Ok(())
}

#[test]
fn replays_active_harness_graph_fixture() -> Result<(), Box<dyn std::error::Error>> {
    let output = run_fixture_with_test_adapter("fixtures/harness/sequential-graph.yaml")?;

    assert_eq!(output.status, HarnessExpectedStatus::Sealed);
    assert_eq!(
        output.receipt.subject.reference.uri,
        "hrn_sequential-echo_graph"
    );
    assert_eq!(output.receipt.seal.disposition, ClosureDisposition::Closed);
    assert_eq!(output.step_receipts.len(), 2);
    assert_eq!(output.step_receipts[0].acts[0].id, "act_first");
    assert_eq!(output.step_receipts[1].acts[0].id, "act_second");
    Ok(())
}

#[test]
fn replay_receipts_match_checked_in_canonical_oracles() -> Result<(), Box<dyn std::error::Error>> {
    let echo = run_fixture_with_test_adapter("fixtures/harness/echo-skill.yaml")?;
    assert_oracle(
        "fixtures/harness/oracle/echo-skill.receipt.json",
        &canonical_receipt_json(&echo.receipt)?,
    )?;

    let graph = run_fixture_with_test_adapter("fixtures/harness/sequential-graph.yaml")?;
    assert_oracle(
        "fixtures/harness/oracle/sequential-graph.receipt.json",
        &canonical_receipt_json(&graph.receipt)?,
    )?;
    assert_oracle(
        "fixtures/harness/oracle/sequential-graph.first.json",
        &canonical_receipt_json(&graph.step_receipts[0])?,
    )?;
    assert_oracle(
        "fixtures/harness/oracle/sequential-graph.second.json",
        &canonical_receipt_json(&graph.step_receipts[1])?,
    )?;

    Ok(())
}

#[test]
#[cfg(not(feature = "cli-tool"))]
fn default_harness_runner_reports_disabled_cli_tool_feature() {
    let result =
        runx_runtime::run_harness_fixture(fixture_path("fixtures/harness/echo-skill.yaml"));

    assert!(matches!(
        result,
        Err(runx_runtime::HarnessReplayError::CliToolFeatureDisabled)
    ));
}

fn run_fixture_with_test_adapter(
    relative_path: &str,
) -> Result<runx_runtime::HarnessReplayOutput, runx_runtime::HarnessReplayError> {
    run_harness_fixture_with_adapter(
        fixture_path(relative_path),
        TestAdapter,
        fixture_runtime_options(),
    )
}

fn fixture_runtime_options() -> RuntimeOptions {
    RuntimeOptions {
        created_at: FIXTURE_CREATED_AT.to_owned(),
        ..RuntimeOptions::local_development()
    }
}

struct TestAdapter;

impl SkillAdapter for TestAdapter {
    fn adapter_type(&self) -> &'static str {
        "cli-tool"
    }

    fn invoke(&self, request: SkillInvocation) -> Result<SkillOutput, runx_runtime::RuntimeError> {
        let message = request
            .inputs
            .get("message")
            .and_then(|value| match value {
                JsonValue::String(value) => Some(value.as_str()),
                _ => None,
            })
            .unwrap_or_default()
            .to_owned();
        // Emit a structured `{ "message": ... }` claim so the producing step's
        // declared artifact contract (for example json-output's `result` packet)
        // is addressable by downstream context edges under the contract model.
        let mut claim = JsonObject::default();
        claim.insert("message".to_owned(), JsonValue::String(message));
        let stdout = serde_json::to_string(&JsonValue::Object(claim))
            .expect("serialize harness test adapter claim");
        Ok(SkillOutput {
            status: InvocationStatus::Success,
            stdout,
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 0,
            metadata: JsonObject::default(),
        })
    }
}

fn fixture_path(relative_path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative_path)
}

fn assert_oracle(relative_path: &str, actual: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path = fixture_path(relative_path);
    if std::env::var("RUNX_REGEN_FIXTURES").is_ok() {
        std::fs::write(&path, format!("{actual}\n"))?;
        return Ok(());
    }
    let expected = std::fs::read_to_string(path)?;
    assert_eq!(expected, format!("{actual}\n"), "{relative_path}");
    Ok(())
}

fn retired_execution_receipt_field(prefix: &str) -> String {
    format!("{prefix}_{}", "execution")
}

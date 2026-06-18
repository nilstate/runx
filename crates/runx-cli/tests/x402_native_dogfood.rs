use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use serde_json::Value;

#[test]
fn native_x402_mock_dogfood_fixtures_run_without_typescript()
-> Result<(), Box<dyn std::error::Error>> {
    let approved = run_harness_fixture(
        "fixtures/harness/x402-pay-approval.yaml",
        &[
            "credential_envelope",
            "rail_session_material",
            "rail-session-material:mock:payment-execution-001",
        ],
    )?;
    assert_eq!(approved["schema"], "runx.receipt.v1");
    assert_eq!(approved["seal"]["disposition"], "closed");
    assert_child_receipts(&approved, 2)?;

    let denied = run_harness_fixture(
        "fixtures/harness/x402-pay-approval-denied.yaml",
        &[
            "credential_envelope",
            "rail_session_material",
            "rail-session-material:mock:payment-execution-001",
        ],
    )?;
    assert_eq!(denied["schema"], "runx.receipt.v1");
    assert_eq!(denied["seal"]["disposition"], "blocked");
    assert_eq!(denied["seal"]["reason_code"], "graph_blocked");
    assert_child_receipts(&denied, 1)?;

    Ok(())
}

#[test]
fn native_x402_paid_echo_fixture_passes_only_refs_downstream()
-> Result<(), Box<dyn std::error::Error>> {
    let receipt = run_harness_fixture(
        "fixtures/harness/x402-pay-paid-echo.yaml",
        &[
            "credential_envelope",
            "rail_session_material",
            "rail-session-material:mock:paid-echo-001",
        ],
    )?;

    assert_eq!(receipt["schema"], "runx.receipt.v1");
    assert_eq!(receipt["seal"]["disposition"], "closed");
    assert_child_receipts(&receipt, 5)?;

    Ok(())
}

#[test]
fn native_x402_ledger_projection() -> Result<(), Box<dyn std::error::Error>> {
    let receipt_dir = isolated_receipt_dir()?;
    let fixture =
        crate::support::governed_harness_fixture("fixtures/harness/x402-pay-paid-echo.yaml")?;
    let output = native_command()?
        .env("RUNX_RECEIPT_DIR", &receipt_dir)
        .args(["harness", fixture.path_str()?, "--json"])
        .output()?;
    assert_success(&output)?;
    let stdout = String::from_utf8(output.stdout)?;
    for denied in [
        "credential_envelope",
        "rail_session_material",
        "rail-session-material:mock:paid-echo-001",
    ] {
        assert!(
            !stdout.contains(denied),
            "native CLI receipt output must not expose raw payment material: {denied}"
        );
    }

    let receipt: Value = serde_json::from_str(&stdout)?;
    assert_eq!(receipt["seal"]["disposition"], "closed");
    let receipt_ref = receipt_ref(&receipt)?;
    let receipt_id = receipt_id(&receipt)?;

    let projection_path = receipt_dir
        .join("artifacts")
        .join("payment-ledger")
        .join("x402-pay")
        .join(format!("{receipt_id}.json"));
    let projection: Value = serde_json::from_str(&fs::read_to_string(&projection_path)?)?;
    assert_eq!(
        projection["schema_version"],
        "runx.payment_ledger_projection.v1"
    );
    assert_eq!(projection["payment_profile"], "x402-pay");
    assert_eq!(projection["scenario_id"], "P1.5");
    assert_eq!(projection["disposition"], "settled");
    assert_eq!(projection["accrual"]["amount_minor"], 125);

    let ledger_path = receipt_dir
        .join("ledgers")
        .join("gx_x402-pay-paid-echo.jsonl");
    let ledger = fs::read_to_string(&ledger_path)?;
    let lines = ledger.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1);
    let event: Value = serde_json::from_str(lines[0])?;
    assert_eq!(event["entry"]["type"], "run_event");
    assert_eq!(event["entry"]["data"]["kind"], "payment_ledger_projected");
    assert_eq!(
        event["entry"]["data"]["detail"]["projection_artifact_id"],
        format!("x402-pay:{receipt_ref}")
    );
    assert_eq!(
        event["entry"]["data"]["detail"]["source_receipt_id"],
        receipt_ref
    );

    fs::remove_dir_all(&receipt_dir).ok();
    Ok(())
}

#[test]
fn native_x402_refusal_ledger_projection() -> Result<(), Box<dyn std::error::Error>> {
    let receipt_dir = isolated_receipt_dir()?;
    let fixture = crate::support::governed_harness_fixture(
        "fixtures/harness/x402-pay-ledger-governed-refusal.yaml",
    )?;
    let output = native_command()?
        .env("RUNX_RECEIPT_DIR", &receipt_dir)
        .args(["harness", fixture.path_str()?, "--json"])
        .output()?;
    assert_success(&output)?;

    let receipt: Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(receipt["seal"]["disposition"], "blocked");
    let receipt_ref = receipt_ref(&receipt)?;
    let receipt_id = receipt_id(&receipt)?;

    let projection_path = receipt_dir
        .join("artifacts")
        .join("payment-ledger")
        .join("x402-pay")
        .join(format!("{receipt_id}.json"));
    let projection: Value = serde_json::from_str(&fs::read_to_string(&projection_path)?)?;
    assert_eq!(
        projection["schema_version"],
        "runx.payment_ledger_projection.v1"
    );
    assert_eq!(projection["payment_profile"], "x402-pay");
    assert_eq!(projection["scenario_id"], "P1.3");
    assert_eq!(projection["disposition"], "refused");
    assert_eq!(projection["accrual"]["amount_minor"], 0);
    assert_eq!(
        projection["accrual"]["rail_proof_refs"]
            .as_array()
            .map(Vec::len),
        Some(0)
    );
    assert_eq!(projection["refusal"]["reason_code"], "cap_exceeded");
    assert_eq!(projection["refusal"]["rail_call_performed"], false);
    assert_eq!(projection["refusal"]["ledger_spend_recorded"], false);

    let ledger_path = receipt_dir
        .join("ledgers")
        .join("gx_x402-pay-ledger-governed-refusal.jsonl");
    let ledger = fs::read_to_string(&ledger_path)?;
    let lines = ledger.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1);
    let event: Value = serde_json::from_str(lines[0])?;
    assert_eq!(event["entry"]["type"], "run_event");
    assert_eq!(event["entry"]["data"]["kind"], "payment_ledger_projected");
    assert_eq!(
        event["entry"]["data"]["detail"]["projection_artifact_id"],
        format!("x402-pay:{receipt_ref}")
    );
    assert_eq!(event["entry"]["data"]["detail"]["disposition"], "refused");

    fs::remove_dir_all(&receipt_dir).ok();
    Ok(())
}

#[test]
fn native_x402_stripe_spt_happy_path_runs_without_typescript()
-> Result<(), Box<dyn std::error::Error>> {
    let receipt = run_harness_fixture(
        "fixtures/harness/stripe-spt-payment.yaml",
        &[
            "credential_envelope",
            "rail_session_material",
            "rail-session-material:stripe-spt:demo-search-001",
            "client_secret",
            "webhook_secret",
            "card_number",
        ],
    )?;

    assert_eq!(receipt["schema"], "runx.receipt.v1");
    assert_eq!(receipt["seal"]["disposition"], "closed");
    assert_child_receipts(&receipt, 4)?;

    Ok(())
}

#[test]
fn native_x402_negative_fixtures_refuse_without_settlement()
-> Result<(), Box<dyn std::error::Error>> {
    let malformed = run_harness_fixture(
        "fixtures/harness/x402-pay-negative-malformed-challenge.yaml",
        &["runx:receipt:hrn_rcpt_x402-pay-negative-malformed-challenge_reserve"],
    )?;
    assert_eq!(malformed["schema"], "runx.receipt.v1");
    assert_eq!(malformed["seal"]["disposition"], "blocked");
    assert_eq!(malformed["seal"]["reason_code"], "graph_blocked");
    assert_child_receipts(&malformed, 1)?;

    let ambiguous = run_harness_fixture(
        "fixtures/harness/x402-pay-negative-ambiguous-bounds.yaml",
        &[
            "runx:receipt:hrn_rcpt_x402-pay-negative-ambiguous-bounds_approve-spend",
            "runx:receipt:hrn_rcpt_x402-pay-negative-ambiguous-bounds_fulfill",
        ],
    )?;
    assert_eq!(ambiguous["schema"], "runx.receipt.v1");
    assert_eq!(ambiguous["seal"]["disposition"], "blocked");
    assert_eq!(ambiguous["seal"]["reason_code"], "graph_blocked");
    assert_child_receipts(&ambiguous, 2)?;

    // Payment authority denials (cap exceeded, non-subset child, quote drift) are
    // refused at admission: the run is policy_denied (blocked) with reason_code
    // authority_denied, before the rail executes and without exposing rail material.
    let cap_exceeded = run_harness_fixture(
        "fixtures/harness/x402-pay-negative-cap-exceeded.yaml",
        &[
            "pay-fulfill-rail",
            "credential:mock:paid-echo-001",
            "rail-session-material:mock:paid-echo-001",
        ],
    )?;
    assert_eq!(cap_exceeded["seal"]["disposition"], "blocked");
    assert_eq!(cap_exceeded["seal"]["reason_code"], "authority_denied");

    let broader_child = run_harness_fixture(
        "fixtures/harness/x402-pay-negative-authority-broader-child.yaml",
        &[
            "pay-fulfill-rail",
            "credential:mock:paid-echo-001",
            "rail-session-material:mock:paid-echo-001",
            "hrn_rcpt_x402-pay-negative-authority-broader-child_fulfill",
        ],
    )?;
    assert_eq!(broader_child["seal"]["disposition"], "blocked");
    assert_eq!(broader_child["seal"]["reason_code"], "authority_denied");

    let quote_drift = run_harness_fixture(
        "fixtures/harness/x402-pay-negative-quote-drift.yaml",
        &[
            "pay-fulfill-rail",
            "credential:mock:paid-echo-001",
            "rail-session-material:mock:paid-echo-001",
            "hrn_rcpt_x402-pay-negative-quote-drift_fulfill",
        ],
    )?;
    assert_eq!(quote_drift["seal"]["disposition"], "blocked");
    assert_eq!(quote_drift["seal"]["reason_code"], "authority_denied");

    let proofless = run_harness_fixture(
        "fixtures/harness/x402-pay-negative-proofless-rail.yaml",
        &["hrn_rcpt_x402-pay-negative-proofless-rail_echo"],
    )?;
    assert_eq!(proofless["seal"]["disposition"], "blocked");
    assert_eq!(proofless["seal"]["reason_code"], "authority_denied");

    Ok(())
}

fn run_harness_fixture(
    fixture: &str,
    denied_fragments: &[&str],
) -> Result<Value, Box<dyn std::error::Error>> {
    let fixture = crate::support::governed_harness_fixture(fixture)?;
    let output = native_command()?
        .args(["harness", fixture.path_str()?, "--json"])
        .output()?;
    assert_success(&output)?;
    let stdout = String::from_utf8(output.stdout)?;
    for denied in denied_fragments {
        assert!(
            !stdout.contains(denied),
            "native CLI receipt output must not expose raw payment material: {denied}"
        );
    }
    Ok(serde_json::from_str(&stdout)?)
}

fn native_command() -> Result<Command, Box<dyn std::error::Error>> {
    let mut command = crate::support::isolated_runx_command("x402-native-dogfood-test-key")?;
    command.env("RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY", "local");
    Ok(command)
}

fn assert_success(output: &Output) -> Result<(), Box<dyn std::error::Error>> {
    assert!(
        output.status.success(),
        "status={:?}\nstderr={}\nstdout={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(String::from_utf8(output.stderr.clone())?, "");
    Ok(())
}

fn child_receipt_uris(receipt: &Value) -> Vec<String> {
    receipt["lineage"]["children"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|reference| reference["uri"].as_str().map(str::to_owned))
        .collect()
}

fn assert_child_receipts(
    receipt: &Value,
    expected_count: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    let uris = child_receipt_uris(receipt);
    assert_eq!(
        uris.len(),
        expected_count,
        "unexpected child refs: {uris:?}"
    );
    let unique = uris.iter().collect::<std::collections::BTreeSet<_>>().len();
    assert_eq!(
        unique, expected_count,
        "child refs must be unique: {uris:?}"
    );
    for uri in uris {
        assert!(
            uri.starts_with("runx:receipt:sha256:"),
            "child ref must be a receipt digest URI: {uri}"
        );
    }
    Ok(())
}

fn receipt_id(receipt: &Value) -> Result<&str, Box<dyn std::error::Error>> {
    receipt["id"]
        .as_str()
        .ok_or_else(|| "receipt id must be a string".into())
}

fn receipt_ref(receipt: &Value) -> Result<String, Box<dyn std::error::Error>> {
    Ok(format!("runx:receipt:{}", receipt_id(receipt)?))
}

fn isolated_receipt_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = crate::support::isolated_target_temp_root("x402-ledger-projection")?;
    fs::create_dir_all(&path)?;
    Ok(path)
}

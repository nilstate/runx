#![allow(clippy::expect_used)]

use super::*;

#[test]
fn validates_receipt_and_output_expectations() -> Result<(), HarnessFixtureError> {
    let fixture = parse_harness_fixture(
        r#"
name: echo-skill
kind: skill
target: ../skills/echo
expect:
  status: sealed
  receipt:
    schema: runx.receipt.v1
    state: sealed
    disposition: closed
  output:
    subset: { status: ready }
"#,
    )?;

    assert_eq!(fixture.kind, HarnessFixtureKind::Skill);
    assert!(fixture.setup.receipts.is_empty());
    assert!(fixture.expect.receipt.is_some());
    assert!(fixture.expect.output.is_some());
    Ok(())
}

#[test]
fn inline_expectations_use_the_conventional_contract() -> Result<(), HarnessFixtureError> {
    let expectation = parse_harness_expectation(JsonObject::from([
        ("status".to_owned(), JsonValue::String("sealed".to_owned())),
        (
            "receipt".to_owned(),
            JsonValue::Object(JsonObject::from([
                (
                    "schema".to_owned(),
                    JsonValue::String("runx.receipt.v1".to_owned()),
                ),
                (
                    "disposition".to_owned(),
                    JsonValue::String("closed".to_owned()),
                ),
            ])),
        ),
        (
            "step_outputs".to_owned(),
            JsonValue::Object(JsonObject::from([(
                "inspect".to_owned(),
                JsonValue::Object(JsonObject::from([(
                    "subset".to_owned(),
                    JsonValue::Object(JsonObject::from([(
                        "status".to_owned(),
                        JsonValue::String("ready".to_owned()),
                    )])),
                )])),
            )])),
        ),
    ]))?;

    assert_eq!(expectation.status, Some(HarnessExpectedStatus::Sealed));
    assert_eq!(
        expectation
            .receipt
            .as_ref()
            .and_then(|receipt| receipt.disposition.as_ref()),
        Some(&ClosureDisposition::Closed)
    );
    assert!(expectation.step_outputs.contains_key("inspect"));
    Ok(())
}

#[test]
fn rejects_retired_receipt_fields() {
    for field in [
        "kind",
        "skill_execution",
        "graph_execution",
        "skill_name",
        "source_type",
        "graph_name",
        "owner",
    ] {
        let error = parse_harness_fixture(&format!(
            "name: old\nkind: skill\ntarget: ..\nexpect:\n  receipt:\n    {field}: value\n"
        ))
        .expect_err("retired receipt field must fail");
        assert!(matches!(
            error,
            HarnessFixtureError::RetiredReceiptField { field_path }
                if field_path == format!("expect.receipt.{field}")
        ));
    }
}

#[test]
fn rejects_unsupported_fixture_kind_at_parser_boundary() {
    let error =
        parse_harness_fixture("name: old\nkind: mcp\ntarget: ..\nexpect:\n  status: sealed\n")
            .expect_err("unsupported fixture kind must fail");

    assert!(matches!(
        error,
        HarnessFixtureError::UnsupportedFixtureMode { mode, field_path }
            if mode == "mcp" && field_path == "kind"
    ));
}

#[test]
fn validates_package_relative_receipt_setup() -> Result<(), HarnessFixtureError> {
    let fixture = parse_harness_fixture(
        "name: receipt-proof\nkind: skill\ntarget: ..\nsetup:\n  receipts:\n    - fixtures/receipt-store/sha256-demo.json\n",
    )?;

    assert_eq!(
        fixture.setup.receipts,
        vec!["fixtures/receipt-store/sha256-demo.json"]
    );
    Ok(())
}

#[test]
fn rejects_receipt_setup_path_escape() {
    let error = parse_harness_fixture(
        "name: receipt-proof\nkind: skill\ntarget: ..\nsetup:\n  receipts:\n    - ../receipt.json\n",
    )
    .expect_err("receipt setup path escape must fail");

    assert!(
        matches!(error, HarnessFixtureError::Invalid { field, .. } if field == "setup.receipts[0]")
    );
}

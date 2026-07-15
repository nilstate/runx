use serde::Deserialize;

use runx_contracts::{
    ExecutionSemantics, GovernedDisposition, InputContextCapture, OutcomeState, ReceiptOutcome,
    ReceiptSurfaceRef,
};

use crate::fixture_support::roundtrip;

const FIXTURES: &[&str] = &[
    include_str!("../../../fixtures/contracts/execution/execution-full.json"),
    include_str!("../../../fixtures/contracts/execution/governed-disposition.json"),
    include_str!("../../../fixtures/contracts/execution/input-context-capture.json"),
    include_str!("../../../fixtures/contracts/execution/outcome-state.json"),
    include_str!("../../../fixtures/contracts/execution/receipt-outcome.json"),
    include_str!("../../../fixtures/contracts/execution/receipt-surface-ref.json"),
];

#[derive(Debug, Deserialize)]
struct Fixture {
    fixture_kind: FixtureKind,
    expected: serde_json::Value,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FixtureKind {
    ExecutionSemantics,
    GovernedDisposition,
    InputContextCapture,
    OutcomeState,
    ReceiptOutcome,
    ReceiptSurfaceRef,
}

#[test]
fn execution_fixtures_match_typescript_wire_shapes() -> Result<(), serde_json::Error> {
    for fixture_json in FIXTURES {
        let fixture: Fixture = serde_json::from_str(fixture_json)?;
        assert_roundtrip(fixture)?;
    }
    Ok(())
}

fn assert_roundtrip(fixture: Fixture) -> Result<(), serde_json::Error> {
    match fixture.fixture_kind {
        FixtureKind::ExecutionSemantics => roundtrip::<ExecutionSemantics>(fixture.expected),
        FixtureKind::GovernedDisposition => roundtrip::<GovernedDisposition>(fixture.expected),
        FixtureKind::InputContextCapture => roundtrip::<InputContextCapture>(fixture.expected),
        FixtureKind::OutcomeState => roundtrip::<OutcomeState>(fixture.expected),
        FixtureKind::ReceiptOutcome => roundtrip::<ReceiptOutcome>(fixture.expected),
        FixtureKind::ReceiptSurfaceRef => roundtrip::<ReceiptSurfaceRef>(fixture.expected),
    }
}

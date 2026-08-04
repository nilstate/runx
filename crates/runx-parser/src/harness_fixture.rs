//! Pure parsing and validation for conventional package harness fixtures.

use std::collections::BTreeMap;

use runx_contracts::{ClosureDisposition, JsonObject, JsonValue, ReceiptSchema};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{ParseError, parse_yaml_document};

const RETIRED_RECEIPT_FIELDS: &[&str] =
    &["kind", "skill_name", "source_type", "graph_name", "owner"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessFixtureKind {
    Skill,
    Graph,
    Mcp,
    A2a,
    Agent,
    #[serde(rename = "agent_task")]
    AgentStep,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessExpectedStatus {
    Sealed,
    Failure,
    NeedsAgent,
    PolicyDenied,
    Escalated,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HarnessFixture {
    pub name: String,
    pub kind: HarnessFixtureKind,
    pub target: String,
    pub runner: Option<String>,
    pub setup: HarnessSetup,
    pub inputs: JsonObject,
    pub env: BTreeMap<String, String>,
    pub caller: JsonObject,
    pub expect: HarnessExpectation,
    pub metadata: JsonObject,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HarnessSetup {
    #[serde(default)]
    pub receipts: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct HarnessExpectation {
    pub status: Option<HarnessExpectedStatus>,
    pub receipt: Option<ReceiptExpectation>,
    pub steps: Vec<String>,
    pub output: Option<HarnessJsonExpectation>,
    pub step_outputs: BTreeMap<String, HarnessJsonExpectation>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HarnessJsonExpectation {
    pub exact: Option<JsonValue>,
    pub subset: Option<JsonValue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReceiptExpectation {
    pub schema: ReceiptSchema,
    pub body_digest: Option<String>,
    pub receipt_id: Option<String>,
    pub receipt_digest: Option<String>,
    pub harness_id: Option<String>,
    pub state: Option<String>,
    pub disposition: Option<ClosureDisposition>,
    pub reason_code: Option<String>,
    pub act_ids: Vec<String>,
    pub decision_ids: Vec<String>,
    pub child_receipt_refs: Vec<String>,
    pub child_receipt_count: Option<usize>,
    pub verification_refs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawHarnessFixture {
    name: String,
    kind: HarnessFixtureKind,
    #[serde(default)]
    target: Option<String>,
    runner: Option<String>,
    #[serde(default)]
    setup: HarnessSetup,
    #[serde(default)]
    inputs: JsonObject,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    caller: JsonObject,
    #[serde(default)]
    expect: RawHarnessExpectation,
    #[serde(default)]
    metadata: JsonObject,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawHarnessExpectation {
    status: Option<HarnessExpectedStatus>,
    receipt: Option<RawReceiptExpectation>,
    #[serde(default)]
    steps: Vec<String>,
    output: Option<HarnessJsonExpectation>,
    #[serde(default)]
    step_outputs: BTreeMap<String, HarnessJsonExpectation>,
}

#[derive(Debug, Deserialize)]
struct RawReceiptExpectation {
    #[serde(default = "default_receipt_schema")]
    schema: ReceiptSchema,
    body_digest: Option<String>,
    receipt_id: Option<String>,
    receipt_digest: Option<String>,
    harness_id: Option<String>,
    state: Option<String>,
    disposition: Option<ClosureDisposition>,
    reason_code: Option<String>,
    #[serde(default)]
    act_ids: Vec<String>,
    #[serde(default)]
    decision_ids: Vec<String>,
    #[serde(default)]
    child_receipt_refs: Vec<String>,
    child_receipt_count: Option<usize>,
    #[serde(default)]
    verification_refs: Vec<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde::de::IgnoredAny>,
}

#[derive(Debug, Error)]
pub enum HarnessFixtureError {
    #[error("failed to parse harness fixture YAML: {0}")]
    Parse(#[from] ParseError),
    #[error("harness fixture {field} is required")]
    Required { field: String },
    #[error("harness fixture {field} must not be empty")]
    Empty { field: &'static str },
    #[error("invalid harness fixture {field}: {message}")]
    Invalid { field: String, message: String },
    #[error("retired receipt expectation field {field_path}")]
    RetiredReceiptField { field_path: String },
    #[error("unknown receipt expectation field {field_path}")]
    UnknownReceiptField { field_path: String },
    #[error("harness fixture mode {mode} at {field_path} is not yet supported by the Rust harness")]
    UnsupportedFixtureMode { mode: String, field_path: String },
}

pub fn parse_harness_fixture(contents: &str) -> Result<HarnessFixture, HarnessFixtureError> {
    validate_fixture(parse_yaml_document::<RawHarnessFixture>(contents)?)
}

/// Validate an inline runner-harness expectation through the same contract as
/// a conventional fixture. Inline `X.yaml` cases and standalone fixture files
/// must not acquire parallel expectation vocabularies.
pub fn parse_harness_expectation(
    value: JsonObject,
) -> Result<HarnessExpectation, HarnessFixtureError> {
    let value = serde_json::to_value(value).map_err(|error| HarnessFixtureError::Invalid {
        field: "expect".to_owned(),
        message: error.to_string(),
    })?;
    let expectation = serde_json::from_value::<RawHarnessExpectation>(value).map_err(|error| {
        HarnessFixtureError::Invalid {
            field: "expect".to_owned(),
            message: error.to_string(),
        }
    })?;
    validate_expectation(expectation)
}

fn validate_fixture(fixture: RawHarnessFixture) -> Result<HarnessFixture, HarnessFixtureError> {
    require_non_empty(&fixture.name, "name")?;
    validate_supported_fixture_kind(&fixture.kind, "kind")?;
    let target = fixture.target.unwrap_or_default();
    if !matches!(fixture.kind, HarnessFixtureKind::AgentStep) {
        require_non_empty(&target, "target")?;
    }
    if let Some(runner) = &fixture.runner {
        require_non_empty(runner, "runner")?;
    }
    Ok(HarnessFixture {
        name: fixture.name,
        kind: fixture.kind,
        target,
        runner: fixture.runner,
        setup: validate_setup(fixture.setup)?,
        inputs: fixture.inputs,
        env: fixture.env,
        caller: fixture.caller,
        expect: validate_expectation(fixture.expect)?,
        metadata: fixture.metadata,
    })
}

fn validate_setup(setup: HarnessSetup) -> Result<HarnessSetup, HarnessFixtureError> {
    const MAX_RECEIPTS: usize = 32;
    if setup.receipts.len() > MAX_RECEIPTS {
        return Err(HarnessFixtureError::Invalid {
            field: "setup.receipts".to_owned(),
            message: format!("must contain at most {MAX_RECEIPTS} receipt files"),
        });
    }
    let mut seen = std::collections::BTreeSet::new();
    for (index, path) in setup.receipts.iter().enumerate() {
        let field = format!("setup.receipts[{index}]");
        if path.is_empty()
            || path.len() > 512
            || path.starts_with('/')
            || path.contains('\\')
            || !path.ends_with(".json")
            || path
                .split('/')
                .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
        {
            return Err(HarnessFixtureError::Invalid {
                field,
                message: "must be a normalized package-relative .json path".to_owned(),
            });
        }
        if !seen.insert(path.clone()) {
            return Err(HarnessFixtureError::Invalid {
                field,
                message: "must not duplicate another receipt path".to_owned(),
            });
        }
    }
    Ok(setup)
}

fn validate_expectation(
    expectation: RawHarnessExpectation,
) -> Result<HarnessExpectation, HarnessFixtureError> {
    Ok(HarnessExpectation {
        status: expectation.status,
        receipt: expectation
            .receipt
            .map(validate_receipt_expectation)
            .transpose()?,
        steps: expectation.steps,
        output: expectation
            .output
            .map(|expectation| validate_json_expectation(expectation, "expect.output"))
            .transpose()?,
        step_outputs: expectation
            .step_outputs
            .into_iter()
            .map(|(step_id, expectation)| {
                let field = format!("expect.step_outputs.{step_id}");
                validate_json_expectation(expectation, &field)
                    .map(|expectation| (step_id, expectation))
            })
            .collect::<Result<_, _>>()?,
    })
}

fn validate_json_expectation(
    expectation: HarnessJsonExpectation,
    field: &str,
) -> Result<HarnessJsonExpectation, HarnessFixtureError> {
    if expectation.exact.is_none() && expectation.subset.is_none() {
        return Err(HarnessFixtureError::Required {
            field: format!("{field}.exact or {field}.subset"),
        });
    }
    Ok(expectation)
}

fn validate_receipt_expectation(
    receipt: RawReceiptExpectation,
) -> Result<ReceiptExpectation, HarnessFixtureError> {
    if let Some(field) = receipt.extra.keys().next() {
        let field_path = format!("expect.receipt.{field}");
        if is_retired_receipt_field(field) {
            return Err(HarnessFixtureError::RetiredReceiptField { field_path });
        }
        return Err(HarnessFixtureError::UnknownReceiptField { field_path });
    }
    Ok(ReceiptExpectation {
        schema: receipt.schema,
        body_digest: receipt.body_digest,
        receipt_id: receipt.receipt_id,
        receipt_digest: receipt.receipt_digest,
        harness_id: receipt.harness_id,
        state: receipt.state,
        disposition: receipt.disposition,
        reason_code: receipt.reason_code,
        act_ids: receipt.act_ids,
        decision_ids: receipt.decision_ids,
        child_receipt_refs: receipt.child_receipt_refs,
        child_receipt_count: receipt.child_receipt_count,
        verification_refs: receipt.verification_refs,
    })
}

fn is_retired_receipt_field(field: &str) -> bool {
    RETIRED_RECEIPT_FIELDS.contains(&field)
        || field == retired_execution_receipt_field("skill")
        || field == retired_execution_receipt_field("graph")
}

fn retired_execution_receipt_field(prefix: &str) -> String {
    format!("{prefix}_{}", "execution")
}

fn validate_supported_fixture_kind(
    kind: &HarnessFixtureKind,
    field_path: &'static str,
) -> Result<(), HarnessFixtureError> {
    match kind {
        HarnessFixtureKind::Skill
        | HarnessFixtureKind::Graph
        | HarnessFixtureKind::A2a
        | HarnessFixtureKind::Agent
        | HarnessFixtureKind::AgentStep => Ok(()),
        HarnessFixtureKind::Mcp => Err(HarnessFixtureError::UnsupportedFixtureMode {
            mode: fixture_kind_name(kind).to_owned(),
            field_path: field_path.to_owned(),
        }),
    }
}

#[must_use]
pub fn fixture_kind_name(kind: &HarnessFixtureKind) -> &'static str {
    match kind {
        HarnessFixtureKind::Skill => "skill",
        HarnessFixtureKind::Graph => "graph",
        HarnessFixtureKind::Mcp => "mcp",
        HarnessFixtureKind::A2a => "a2a",
        HarnessFixtureKind::Agent => "agent",
        HarnessFixtureKind::AgentStep => "agent_task",
    }
}

fn require_non_empty(value: &str, field: &'static str) -> Result<(), HarnessFixtureError> {
    if value.is_empty() {
        Err(HarnessFixtureError::Empty { field })
    } else {
        Ok(())
    }
}

fn default_receipt_schema() -> ReceiptSchema {
    ReceiptSchema::V1
}

#[cfg(test)]
mod tests;

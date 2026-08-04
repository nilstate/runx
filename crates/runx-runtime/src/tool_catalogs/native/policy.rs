use runx_contracts::{JsonObject, JsonValue};
use serde::{Deserialize, Serialize};

use crate::{
    CapabilityAdmission, CapabilityApproval, CapabilityArtifacts, CapabilityDefinition,
    CapabilityEffect, CapabilityField, CapabilityInput, CapabilityOutput,
};

use super::NativeInvocation;
use super::capability::{NativeCapability, TypedNativeCapability, decode_typed_output};
use crate::RuntimeError;

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct PolicyLintInput {
    policy: JsonObject,
}

impl CapabilityInput for PolicyLintInput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct PolicyLintOutput {
    policy_lint: PolicyLintPacket,
}

impl CapabilityOutput for PolicyLintOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct PolicyLintPacket {
    status: String,
    engine: String,
    findings: Vec<PolicyLintFinding>,
    readback: Option<JsonObject>,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct PolicyLintFinding {
    code: String,
    path: String,
    message: String,
}

const FIELDS: &[CapabilityField] = &[CapabilityField {
    name: "policy",
    description: "Exact in-memory runx.operational_policy.v1 candidate.",
}];

static LINT: TypedNativeCapability<PolicyLintInput, PolicyLintOutput> = TypedNativeCapability::new(
    CapabilityDefinition {
        id: "policy.lint",
        owner: "runx-core/policy",
        summary: "Parse and lint one operational policy through the canonical policy engine.",
        scopes: &[],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Named {
            output: "policy_lint",
            packet: "runx.policy.lint.v1",
        },
        admission: CapabilityAdmission::RuntimeInvariant(
            "policy authoring and policy admission must use the same engine",
        ),
        fields: FIELDS,
    },
    lint_policy,
);

pub(super) const CAPABILITIES: &[&dyn NativeCapability] = &[&LINT];

fn lint_policy(
    invocation: &NativeInvocation<'_, PolicyLintInput>,
) -> Result<PolicyLintOutput, RuntimeError> {
    let parsed = serde_json::from_slice::<runx_contracts::OperationalPolicy>(
        &serde_json::to_vec(&invocation.inputs.policy)
            .map_err(|source| RuntimeError::json("serializing policy lint input", source))?,
    );
    let lint = match parsed {
        Ok(policy) => match runx_contracts::project_operational_policy_readback(&policy) {
            Ok(readback) => {
                let valid = readback.valid;
                let findings = json_value(&readback.findings, "policy lint findings")?;
                let readback = json_value(&readback, "policy lint readback")?;
                JsonObject::from([
                    (
                        "status".to_owned(),
                        JsonValue::String(if valid { "pass" } else { "fail" }.to_owned()),
                    ),
                    (
                        "engine".to_owned(),
                        JsonValue::String("runx policy".to_owned()),
                    ),
                    ("findings".to_owned(), findings),
                    ("readback".to_owned(), readback),
                ])
            }
            Err(error) => lint_failure(
                error.finding().code.as_str(),
                error.finding().path.as_str(),
                error.finding().message.as_str(),
            ),
        },
        Err(error) => lint_failure(
            "policy.contract.invalid",
            "$",
            &format!("policy does not match runx.operational_policy.v1: {error}"),
        ),
    };
    decode_typed_output(
        "policy.lint",
        JsonValue::Object(JsonObject::from([(
            "policy_lint".to_owned(),
            JsonValue::Object(lint),
        )])),
    )
}

fn lint_failure(code: &str, path: &str, message: &str) -> JsonObject {
    JsonObject::from([
        ("status".to_owned(), JsonValue::String("fail".to_owned())),
        (
            "engine".to_owned(),
            JsonValue::String("runx policy".to_owned()),
        ),
        (
            "findings".to_owned(),
            JsonValue::Array(vec![JsonValue::Object(JsonObject::from([
                ("code".to_owned(), JsonValue::String(code.to_owned())),
                ("path".to_owned(), JsonValue::String(path.to_owned())),
                ("message".to_owned(), JsonValue::String(message.to_owned())),
            ]))]),
        ),
        ("readback".to_owned(), JsonValue::Null),
    ])
}

fn json_value(value: &impl Serialize, context: &str) -> Result<JsonValue, RuntimeError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|source| RuntimeError::json(format!("serializing {context}"), source))?;
    serde_json::from_slice(&bytes)
        .map_err(|source| RuntimeError::json(format!("projecting {context}"), source))
}

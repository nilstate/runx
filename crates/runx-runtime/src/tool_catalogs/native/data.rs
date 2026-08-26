use runx_contracts::{JsonObject, JsonValue};
use serde::{Deserialize, Serialize};

use crate::{
    CapabilityApproval, CapabilityArtifacts, CapabilityDefinition, CapabilityEffect,
    CapabilityField, CapabilityInput, CapabilityOutput,
};

use super::capability::{NativeCapability, TypedNativeCapability};
use super::{NativeInvocation, invalid_input};
use crate::RuntimeError;

const DIGEST_TOOL: &str = "data.digest";

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct DigestInput {
    value: JsonValue,
    encoding: String,
}

impl CapabilityInput for DigestInput {
    fn defaults() -> JsonObject {
        JsonObject::from([(
            "encoding".to_owned(),
            JsonValue::String("canonical_json".to_owned()),
        )])
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct CompareInput {
    actual: JsonValue,
    expected: JsonValue,
}

impl CapabilityInput for CompareInput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct HarnessContextInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    harness: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision: Option<JsonObject>,
}

impl CapabilityInput for HarnessContextInput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct DigestOutput {
    digest_result: DigestResult,
}

impl CapabilityOutput for DigestOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct DigestResult {
    algorithm: String,
    digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct CompareOutput {
    comparison: Comparison,
}

impl CapabilityOutput for CompareOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct Comparison {
    equal: bool,
    actual_digest: String,
    expected_digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct HarnessContextOutput {
    present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    harness: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision: Option<JsonObject>,
    harness_context: HarnessContext,
}

impl CapabilityOutput for HarnessContextOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct HarnessContext {
    captured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    harness: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision: Option<JsonObject>,
}

const DIGEST_FIELDS: &[CapabilityField] = &[
    field("value", "Exact JSON value or UTF-8 string to hash."),
    field("encoding", "Digest encoding: canonical_json or utf8_text."),
];

const COMPARE_FIELDS: &[CapabilityField] = &[
    field("actual", "Resolved value observed at execution time."),
    field("expected", "Resolved value the operation is bound to."),
];

const CONTEXT_FIELDS: &[CapabilityField] = &[
    field("harness", "Optional current runx.harness.v1 packet."),
    field(
        "signal",
        "Optional runx.signal.v1 packet that informed the run.",
    ),
    field(
        "decision",
        "Optional runx.decision.v1 packet selecting the next action.",
    ),
];

const fn field(name: &'static str, description: &'static str) -> CapabilityField {
    CapabilityField { name, description }
}

static DIGEST: TypedNativeCapability<DigestInput, DigestOutput> = TypedNativeCapability::new(
    CapabilityDefinition {
        id: "data.digest",
        owner: "runx-runtime/data",
        summary: "Compute a stable SHA-256 digest over canonical JSON or exact UTF-8 text.",
        scopes: &[],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Named {
            output: "digest_result",
            packet: "runx.data.digest.v1",
        },
        fields: DIGEST_FIELDS,
    },
    digest_value,
);

static COMPARE: TypedNativeCapability<CompareInput, CompareOutput> = TypedNativeCapability::new(
    CapabilityDefinition {
        id: "data.compare",
        owner: "runx-runtime/data",
        summary: "Compare two resolved JSON values without copying them into output.",
        scopes: &[],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Named {
            output: "comparison",
            packet: "runx.data.comparison.v1",
        },
        fields: COMPARE_FIELDS,
    },
    compare_values,
);

static HARNESS_CONTEXT: TypedNativeCapability<HarnessContextInput, HarnessContextOutput> =
    TypedNativeCapability::new(
        CapabilityDefinition {
            id: "control.capture_harness_context",
            owner: "runx-runtime/control",
            summary: "Capture supplied harness, signal, and decision packets as explicit context.",
            scopes: &["runx:control:read"],
            effect: CapabilityEffect::Read,
            approval: CapabilityApproval::None,
            artifacts: CapabilityArtifacts::Named {
                output: "harness_context",
                packet: "runx.control.harness_context.v1",
            },
            fields: CONTEXT_FIELDS,
        },
        capture_harness_context,
    );

pub(super) const CAPABILITIES: &[&dyn NativeCapability] = &[&DIGEST, &COMPARE, &HARNESS_CONTEXT];

fn digest_value(
    invocation: &NativeInvocation<'_, DigestInput>,
) -> Result<DigestOutput, RuntimeError> {
    let bytes = digest_bytes(&invocation.inputs.value, &invocation.inputs.encoding)?;
    Ok(DigestOutput {
        digest_result: DigestResult {
            algorithm: "sha256".to_owned(),
            digest: runx_contracts::sha256_prefixed(&bytes),
        },
    })
}

fn compare_values(
    invocation: &NativeInvocation<'_, CompareInput>,
) -> Result<CompareOutput, RuntimeError> {
    let actual = &invocation.inputs.actual;
    let expected = &invocation.inputs.expected;
    let actual_bytes = digest_bytes(actual, "canonical_json")?;
    let expected_bytes = digest_bytes(expected, "canonical_json")?;
    Ok(CompareOutput {
        comparison: Comparison {
            equal: actual == expected,
            actual_digest: runx_contracts::sha256_prefixed(&actual_bytes),
            expected_digest: runx_contracts::sha256_prefixed(&expected_bytes),
        },
    })
}

fn capture_harness_context(
    invocation: &NativeInvocation<'_, HarnessContextInput>,
) -> Result<HarnessContextOutput, RuntimeError> {
    let harness = invocation.inputs.harness.as_ref();
    let signal = invocation.inputs.signal.as_ref();
    let decision = invocation.inputs.decision.as_ref();
    let present = harness.is_some() || signal.is_some() || decision.is_some();
    Ok(HarnessContextOutput {
        present,
        harness: harness.cloned(),
        signal: signal.cloned(),
        decision: decision.cloned(),
        harness_context: HarnessContext {
            captured: present,
            harness: harness.cloned(),
            signal: signal.cloned(),
            decision: decision.cloned(),
        },
    })
}

fn digest_bytes(value: &JsonValue, encoding: &str) -> Result<Vec<u8>, RuntimeError> {
    match encoding {
        "canonical_json" => serde_json::to_vec(value)
            .map_err(|source| RuntimeError::json("serializing native digest input", source)),
        "utf8_text" => value
            .as_str()
            .map(|value| value.as_bytes().to_vec())
            .ok_or_else(|| {
                invalid_input(DIGEST_TOOL, "utf8_text encoding requires a string value")
            }),
        other => Err(invalid_input(
            DIGEST_TOOL,
            format!("encoding {other:?} is unsupported"),
        )),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use runx_contracts::JsonValue;

    use super::digest_bytes;

    #[test]
    fn digest_preserves_json_compatibility_and_exact_text() {
        let text = JsonValue::String("hello".to_owned());
        assert_eq!(
            digest_bytes(&text, "canonical_json").expect("canonical JSON bytes"),
            b"\"hello\""
        );
        assert_eq!(
            digest_bytes(&text, "utf8_text").expect("UTF-8 bytes"),
            b"hello"
        );
    }
}

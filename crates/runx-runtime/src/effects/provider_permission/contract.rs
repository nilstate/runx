use runx_contracts::{JsonObject, JsonValue, sha256_prefixed};
use serde::{Deserialize, Serialize};

use crate::{
    CapabilityApproval, CapabilityArtifacts, CapabilityContract, CapabilityDefinition,
    CapabilityEffect, CapabilityField, CapabilityInput, TypedCapability,
};

use super::{PROVIDER_MUTATE_TOOL, PROVIDER_READ_TOOL};
use crate::ProviderEffectAmount;

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct ProviderReadInput {
    operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    target_from_grant: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    readback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result_fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    optional_result_fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_result: Option<JsonObject>,
    expected_provider: String,
}

impl CapabilityInput for ProviderReadInput {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ProviderApprovalRequest {
    pub reason: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub gate_type: Option<String>,
}

impl ProviderApprovalRequest {
    pub(super) fn digest(&self) -> Result<String, serde_json::Error> {
        serde_json::to_vec(self).map(|bytes| sha256_prefixed(&bytes))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct ProviderMutateInput {
    operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    target_from_grant: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result_fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    optional_result_fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_result: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval: Option<ProviderApprovalRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    amount: Option<ProviderEffectAmount>,
    idempotency_key: String,
    expected_provider: String,
}

impl CapabilityInput for ProviderMutateInput {}

const READ_FIELDS: &[CapabilityField] = &[
    field(
        "operation",
        "Dotted provider capability admitted by the configured grant.",
    ),
    field(
        "target",
        "Human-readable provider target bound into readback and mutation approval.",
    ),
    field(
        "target_from_grant",
        "Resolve the exact hosted target from the selected grant; cannot be combined with target.",
    ),
    field(
        "readback",
        "Explicitly marks this provider read as independent finality verification for a prior mutation.",
    ),
    field("input", "Credential-free provider operation input."),
    field(
        "result_fields",
        "Optional non-empty projection of required top-level provider result fields.",
    ),
    field(
        "optional_result_fields",
        "Optional non-empty projection of top-level provider result fields retained only when present.",
    ),
    field(
        "expected_result",
        "Optional top-level result fields that must match before readback is trusted.",
    ),
    field(
        "expected_provider",
        "Provider identity used for grant resolution and checked against readback.",
    ),
];

const MUTATE_FIELDS: &[CapabilityField] = &[
    READ_FIELDS[0],
    READ_FIELDS[1],
    READ_FIELDS[2],
    READ_FIELDS[4],
    READ_FIELDS[5],
    READ_FIELDS[6],
    field(
        "approval",
        "Optional exact human approval request. Omit when the admitted grant is sufficient; the effect owner returns a resumable host request when present.",
    ),
    field(
        "amount",
        "Optional exact amount shown in approval context and bound into the provider plan.",
    ),
    field(
        "idempotency_key",
        "Stable request identity hashed into the provider idempotency key by Runx.",
    ),
    READ_FIELDS[7],
    READ_FIELDS[8],
];

pub(super) fn approval_request(
    inputs: &JsonObject,
) -> Result<Option<ProviderApprovalRequest>, String> {
    let request = inputs
        .get("approval")
        .cloned()
        .map(JsonValue::deserialize_into)
        .transpose()
        .map_err(|error| format!("approval request is invalid: {error}"))?;
    request
        .map(|mut request: ProviderApprovalRequest| {
            request.reason = bounded_text(request.reason, "approval.reason")?;
            request.gate_type = request
                .gate_type
                .map(|value| bounded_text(value, "approval.type"))
                .transpose()?;
            Ok(request)
        })
        .transpose()
}

pub(super) fn effect_amount(inputs: &JsonObject) -> Result<Option<ProviderEffectAmount>, String> {
    inputs
        .get("amount")
        .cloned()
        .map(JsonValue::deserialize_into)
        .transpose()
        .map_err(|error| format!("provider effect amount is invalid: {error}"))
}

fn bounded_text(value: String, field: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        Err(format!("{field} must be a safe non-empty value"))
    } else {
        Ok(value.to_owned())
    }
}

const fn field(name: &'static str, description: &'static str) -> CapabilityField {
    CapabilityField { name, description }
}

static PROVIDER_READ: TypedCapability<ProviderReadInput> = TypedCapability::new(
    CapabilityDefinition {
        id: PROVIDER_READ_TOOL,
        owner: "runx-runtime/provider-permission",
        summary: "Execute one bounded read through a compatible local driver or Runx Connect grant and return provider readback evidence.",
        scopes: &[],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Named {
            output: "provider_operation",
            packet: "runx.provider.operation.v1",
        },
        fields: READ_FIELDS,
    },
);

static PROVIDER_MUTATE: TypedCapability<ProviderMutateInput> = TypedCapability::new(
    CapabilityDefinition {
        id: PROVIDER_MUTATE_TOOL,
        owner: "runx-runtime/provider-permission",
        summary: "Execute one bounded mutation through a compatible local driver or Runx Connect grant and return provider readback evidence.",
        scopes: &[],
        effect: CapabilityEffect::Mutate,
        approval: CapabilityApproval::Effect,
        artifacts: CapabilityArtifacts::Named {
            output: "provider_operation",
            packet: "runx.provider.operation.v1",
        },
        fields: MUTATE_FIELDS,
    },
);

pub(super) const PROVIDER_CAPABILITIES: &[&dyn CapabilityContract] =
    &[&PROVIDER_READ, &PROVIDER_MUTATE];

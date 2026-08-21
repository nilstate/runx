use runx_contracts::JsonObject;
use serde::{Deserialize, Serialize};

use crate::{
    CapabilityAdmission, CapabilityApproval, CapabilityArtifacts, CapabilityContract,
    CapabilityDefinition, CapabilityEffect, CapabilityField, CapabilityInput, TypedCapability,
};

use super::{PROVIDER_MUTATE_TOOL, PROVIDER_READ_TOOL};

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct ProviderReadInput {
    operation: String,
    target: String,
    #[serde(default, skip_serializing_if = "is_false")]
    readback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result_fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_result: Option<JsonObject>,
    expected_provider: String,
}

impl CapabilityInput for ProviderReadInput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct ProviderMutateInput {
    operation: String,
    target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result_fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_result: Option<JsonObject>,
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
        "readback",
        "Explicitly marks this provider read as independent finality verification for a prior mutation.",
    ),
    field("input", "Credential-free provider operation input."),
    field(
        "result_fields",
        "Optional non-empty projection of required top-level provider result fields.",
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
    READ_FIELDS[3],
    READ_FIELDS[4],
    field(
        "idempotency_key",
        "Stable request identity hashed into the provider idempotency key by Runx.",
    ),
    READ_FIELDS[5],
    READ_FIELDS[6],
];

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
        admission: CapabilityAdmission::RuntimeInvariant(
            "provider reads require transport-bound authority and identity-bound readback",
        ),
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
        admission: CapabilityAdmission::RuntimeInvariant(
            "provider mutations require exact approval, idempotency, and independent readback",
        ),
        fields: MUTATE_FIELDS,
    },
);

pub(super) const PROVIDER_CAPABILITIES: &[&dyn CapabilityContract] =
    &[&PROVIDER_READ, &PROVIDER_MUTATE];

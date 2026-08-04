use crate::contracts::{
    PaymentChargeChallengePacket, PaymentChargePolicy, PaymentChargePricePacket,
    PaymentChargeVerificationRequest, PaymentCredentialReference, PaymentIdempotencyBinding,
    PaymentToolCall,
};
use runx_contracts::schema::BoundedString;
use runx_runtime::{
    CapabilityAdmission, CapabilityApproval, CapabilityArtifacts, CapabilityDefinition,
    CapabilityEffect, CapabilityField, CapabilityInput, TypedCapability,
};
use serde::{Deserialize, Serialize};

pub(crate) const CHARGE_PRICE_TOOL: &str = "payment.charge_price";
pub(crate) const CHARGE_CHALLENGE_TOOL: &str = "payment.charge_challenge";
pub(crate) const CHARGE_VERIFICATION_REQUEST_TOOL: &str = "payment.charge_verification_request";
pub(crate) const CHARGE_PLAN_TOOL: &str = "payment.charge_plan";

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct PriceInput {
    mcp_tool_call: PaymentToolCall,
    provider_policy: PaymentChargePolicy,
}

impl CapabilityInput for PriceInput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ChallengeInput {
    charge_price_packet: PaymentChargePricePacket,
    idempotency_seed: BoundedString<256>,
}

impl CapabilityInput for ChallengeInput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct VerificationInput {
    charge_price_packet: PaymentChargePricePacket,
    charge_challenge_packet: PaymentChargeChallengePacket,
    returned_credential: PaymentCredentialReference,
    verify_capability_ref: BoundedString<512>,
    settlement_family: BoundedString<64>,
    idempotency: PaymentIdempotencyBinding,
}

impl CapabilityInput for VerificationInput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct PlanInput {
    charge_price_packet: PaymentChargePricePacket,
    charge_challenge_packet: PaymentChargeChallengePacket,
    charge_verification_request: PaymentChargeVerificationRequest,
}

impl CapabilityInput for PlanInput {}

const PRICE_FIELDS: &[CapabilityField] = &[
    field(
        "mcp_tool_call",
        "Inbound MCP operation with an opaque tool name and structured arguments.",
    ),
    field(
        "provider_policy",
        "Provider-owned price, currency, counterparty, realm, and admitted settlement families.",
    ),
];

const CHALLENGE_FIELDS: &[CapabilityField] = &[
    field(
        "charge_price_packet",
        "Native payment.charge_price packet data.",
    ),
    field("idempotency_seed", "Stable caller-owned challenge seed."),
];

const VERIFICATION_FIELDS: &[CapabilityField] = &[
    field(
        "charge_price_packet",
        "Native payment.charge_price packet data.",
    ),
    field(
        "charge_challenge_packet",
        "Native payment.charge_challenge packet data.",
    ),
    field(
        "returned_credential",
        "Opaque settlement family and credential reference; raw credential material is refused.",
    ),
    field(
        "verify_capability_ref",
        "Single-use verifier capability reference.",
    ),
    field(
        "settlement_family",
        "Settlement family selected by the provider runner.",
    ),
    field("idempotency", "Challenge idempotency binding."),
];

const PLAN_FIELDS: &[CapabilityField] = &[
    VERIFICATION_FIELDS[0],
    VERIFICATION_FIELDS[1],
    field(
        "charge_verification_request",
        "Native payment.charge_verification_request packet data.",
    ),
];

const fn field(name: &'static str, description: &'static str) -> CapabilityField {
    CapabilityField { name, description }
}

pub(super) static PRICE: TypedCapability<PriceInput> = capability(
    CHARGE_PRICE_TOOL,
    "Derive one provider-side price and bounded payment request from a tool call and provider policy.",
    CapabilityArtifacts::Wrapped {
        output: "charge_price_packet",
        packet: "runx.payment.charge_price.v1",
    },
    PRICE_FIELDS,
);

pub(super) static CHALLENGE: TypedCapability<ChallengeInput> = capability(
    CHARGE_CHALLENGE_TOOL,
    "Bind a provider price to one deterministic, replay-safe payment challenge.",
    CapabilityArtifacts::Wrapped {
        output: "charge_challenge_packet",
        packet: "runx.payment.charge_challenge.v1",
    },
    CHALLENGE_FIELDS,
);

pub(super) static VERIFICATION_REQUEST: TypedCapability<VerificationInput> = capability(
    CHARGE_VERIFICATION_REQUEST_TOOL,
    "Validate one opaque returned credential reference and prepare an exact provider-verifier request without forwarding the paid call.",
    CapabilityArtifacts::Wrapped {
        output: "charge_verification_request",
        packet: "runx.payment.charge_verification_request.v1",
    },
    VERIFICATION_FIELDS,
);

pub(super) static PLAN: TypedCapability<PlanInput> = capability(
    CHARGE_PLAN_TOOL,
    "Assemble price, challenge, and verifier-request packets into a provider charge plan that cannot claim settlement or forwarding.",
    CapabilityArtifacts::Named {
        output: "charge_plan",
        packet: "runx.payment.charge_plan.v1",
    },
    PLAN_FIELDS,
);

const fn capability<I>(
    id: &'static str,
    summary: &'static str,
    artifacts: CapabilityArtifacts,
    fields: &'static [CapabilityField],
) -> TypedCapability<I> {
    TypedCapability::new(CapabilityDefinition {
        id,
        owner: "runx-pay/planning",
        summary,
        scopes: &[],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts,
        admission: CapabilityAdmission::ReusedBy(&["charge", "mpp-charge"]),
        fields,
    })
}

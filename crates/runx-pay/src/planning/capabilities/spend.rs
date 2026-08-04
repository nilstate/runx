use std::num::NonZeroU64;

use runx_contracts::schema::{BoundedString, BoundedVec};
use runx_contracts::{AuthorityTerm, JsonObject, Reference};
use runx_runtime::{
    CapabilityAdmission, CapabilityApproval, CapabilityArtifacts, CapabilityDefinition,
    CapabilityEffect, CapabilityField, CapabilityInput, TypedCapability,
};
use serde::{Deserialize, Serialize};

use crate::contracts::{CurrencyCode, PaymentSignal};

pub(crate) const QUOTE_TOOL: &str = "payment.quote";
pub(crate) const RESERVE_TOOL: &str = "payment.reserve";

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct QuoteInput {
    payment_signal: PaymentSignal,
    parent_payment_authority: AuthorityTerm,
    #[serde(skip_serializing_if = "Option::is_none")]
    realm: Option<BoundedString<64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rail_preferences: Option<BoundedVec<BoundedString<64>, 1, 10>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_per_call_units: Option<NonZeroU64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    currency: Option<CurrencyCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<BoundedString<256>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    counterparty: Option<BoundedString<256>>,
    idempotency_seed: BoundedString<256>,
}

impl CapabilityInput for QuoteInput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ReserveInput {
    payment_quote_packet: JsonObject,
    parent_payment_authority: AuthorityTerm,
    idempotency_seed: BoundedString<256>,
    target_harness_ref: Reference,
    target_act_id: BoundedString<256>,
}

impl CapabilityInput for ReserveInput {}

const QUOTE_FIELDS: &[CapabilityField] = &[
    field(
        "payment_signal",
        "Structured provider or operator payment signal.",
    ),
    field(
        "parent_payment_authority",
        "Typed parent AuthorityTerm that bounds the quote.",
    ),
    field("realm", "Expected payment realm."),
    field(
        "rail_preferences",
        "Ordered preferred rails constrained by the parent authority.",
    ),
    field(
        "max_per_call_units",
        "Optional caller ceiling in minor currency units.",
    ),
    field("currency", "Expected ISO currency code."),
    field("operation", "Expected paid operation."),
    field(
        "counterparty",
        "Expected bounded merchant or payee reference.",
    ),
    field(
        "idempotency_seed",
        "Stable caller-owned quote idempotency material.",
    ),
];

const RESERVE_FIELDS: &[CapabilityField] = &[
    field("payment_quote_packet", "Native payment.quote packet data."),
    field(
        "parent_payment_authority",
        "Typed parent AuthorityTerm used to recompute attenuation.",
    ),
    field("idempotency_seed", "Stable caller-owned reservation seed."),
    field(
        "target_harness_ref",
        "Bounded harness Reference authorized to consume the capability.",
    ),
    field("target_act_id", "Exact downstream payment act id."),
];

const fn field(name: &'static str, description: &'static str) -> CapabilityField {
    CapabilityField { name, description }
}

pub(super) static QUOTE: TypedCapability<QuoteInput> = TypedCapability::new(CapabilityDefinition {
    id: QUOTE_TOOL,
    owner: "runx-pay/planning",
    summary: "Normalize one payment signal and derive a bounded quote from the caller's parent authority.",
    scopes: &[],
    effect: CapabilityEffect::Read,
    approval: CapabilityApproval::None,
    artifacts: CapabilityArtifacts::Wrapped {
        output: "payment_quote_packet",
        packet: "runx.payment.quote.v1",
    },
    admission: CapabilityAdmission::ReusedBy(&["spend", "settle-invoice"]),
    fields: QUOTE_FIELDS,
});

pub(super) static RESERVE: TypedCapability<ReserveInput> = TypedCapability::new(
    CapabilityDefinition {
        id: RESERVE_TOOL,
        owner: "runx-pay/planning",
        summary: "Mint and prove one single-use child payment authority from a bounded native quote without touching a payment rail.",
        scopes: &["payment:reserve"],
        effect: CapabilityEffect::Mutate,
        approval: CapabilityApproval::Policy,
        artifacts: CapabilityArtifacts::Wrapped {
            output: "payment_reservation_packet",
            packet: "runx.payment.reservation.v1",
        },
        admission: CapabilityAdmission::RuntimeInvariant(
            "payment authority reservation must be attenuated and single-use before fulfillment",
        ),
        fields: RESERVE_FIELDS,
    },
);

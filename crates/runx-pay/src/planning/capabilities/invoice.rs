use runx_contracts::{AuthorityTerm, JsonObject};
use runx_runtime::{
    CapabilityAdmission, CapabilityApproval, CapabilityArtifacts, CapabilityDefinition,
    CapabilityEffect, CapabilityField, CapabilityInput, TypedCapability,
};
use serde::{Deserialize, Serialize};

pub(crate) const INVOICE_PLAN_TOOL: &str = "payment.invoice_plan";

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct InvoiceInput {
    invoice_ref: String,
    amount_minor: u64,
    currency: String,
    payee: JsonObject,
    rail: String,
    rail_profile_ref: String,
    parent_payment_authority: AuthorityTerm,
    idempotency_seed: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    realm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payment_admission: Option<JsonObject>,
}

impl CapabilityInput for InvoiceInput {}

const FIELDS: &[CapabilityField] = &[
    field("invoice_ref", "Stable opaque invoice reference."),
    field(
        "amount_minor",
        "Positive invoice amount in minor currency units.",
    ),
    field("currency", "Uppercase ISO 4217 currency code."),
    field(
        "payee",
        "Bounded payee identity with an opaque settlement reference or digest.",
    ),
    field("rail", "Canonical spend rail selected for the invoice."),
    field(
        "rail_profile_ref",
        "Configured profile reference for the selected rail.",
    ),
    field(
        "parent_payment_authority",
        "Full typed parent payment AuthorityTerm.",
    ),
    field("idempotency_seed", "Stable caller-owned settlement seed."),
    field("realm", "Expected payment realm."),
    field(
        "payment_admission",
        "Bounded hosted admission and settlement identity.",
    ),
];

const fn field(name: &'static str, description: &'static str) -> CapabilityField {
    CapabilityField { name, description }
}

pub(super) static PLAN: TypedCapability<InvoiceInput> = TypedCapability::new(
    CapabilityDefinition {
        id: INVOICE_PLAN_TOOL,
        owner: "runx-pay/planning",
        summary: "Validate one invoice against a real payment authority and prepare an executable canonical spend handoff without moving money.",
        scopes: &[],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Named {
            output: "settlement_plan",
            packet: "runx.payment.invoice_settlement_plan.v1",
        },
        admission: CapabilityAdmission::ReusedBy(&["settle-invoice", "spend"]),
        fields: FIELDS,
    },
);

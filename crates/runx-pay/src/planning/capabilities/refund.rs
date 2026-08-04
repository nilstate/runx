use runx_contracts::AuthorityTerm;
use runx_contracts::schema::BoundedString;
use runx_runtime::{
    CapabilityAdmission, CapabilityApproval, CapabilityArtifacts, CapabilityDefinition,
    CapabilityEffect, CapabilityField, CapabilityInput, TypedCapability,
};
use serde::{Deserialize, Serialize};

use crate::contracts::PaymentRefundRequest;

pub(crate) const REFUND_PLAN_TOOL: &str = "payment.refund_plan";

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct RefundInput {
    original_receipt_ref: BoundedString<512>,
    refund_request: PaymentRefundRequest,
    settlement_family: BoundedString<64>,
    parent_payment_authority: AuthorityTerm,
}

impl CapabilityInput for RefundInput {}

const FIELDS: &[CapabilityField] = &[
    field(
        "original_receipt_ref",
        "Opaque sealed charge receipt reference.",
    ),
    field(
        "refund_request",
        "Positive minor-unit amount, opaque reason, and optional payer check.",
    ),
    field(
        "settlement_family",
        "Provider refund family selected by the runner.",
    ),
    field(
        "parent_payment_authority",
        "Typed parent AuthorityTerm bounded to this refund.",
    ),
];

const fn field(name: &'static str, description: &'static str) -> CapabilityField {
    CapabilityField { name, description }
}

pub(super) static PLAN: TypedCapability<RefundInput> = TypedCapability::new(CapabilityDefinition {
    id: REFUND_PLAN_TOOL,
    owner: "runx-pay/planning",
    summary: "Validate one receipt-linked refund and emit an exact provider-adapter handoff without moving money.",
    scopes: &[],
    effect: CapabilityEffect::Read,
    approval: CapabilityApproval::None,
    artifacts: CapabilityArtifacts::Named {
        output: "refund_plan",
        packet: "runx.payment.refund_plan.v1",
    },
    admission: CapabilityAdmission::ReusedBy(&["refund", "stripe-refund"]),
    fields: FIELDS,
});

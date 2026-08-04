mod charge;
mod invoice;
mod refund;
mod spend;

pub(super) use charge::{
    CHARGE_CHALLENGE_TOOL, CHARGE_PLAN_TOOL, CHARGE_PRICE_TOOL, CHARGE_VERIFICATION_REQUEST_TOOL,
};
pub(super) use invoice::INVOICE_PLAN_TOOL;
pub(super) use refund::REFUND_PLAN_TOOL;
pub(super) use spend::{QUOTE_TOOL, RESERVE_TOOL};

pub(super) const CAPABILITIES: &[&dyn runx_runtime::CapabilityContract] = &[
    &spend::QUOTE,
    &spend::RESERVE,
    &charge::PRICE,
    &charge::CHALLENGE,
    &charge::VERIFICATION_REQUEST,
    &charge::PLAN,
    &refund::PLAN,
    &invoice::PLAN,
];

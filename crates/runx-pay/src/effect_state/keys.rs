use super::{EffectFinalityRecord, EffectRunSpendReservation};
pub(super) fn finality_record_conflicts(
    existing: &EffectFinalityRecord,
    next: &EffectFinalityRecord,
) -> bool {
    existing.money_movement_id != next.money_movement_id
        || existing.rail != next.rail
        || existing.finality_threshold != next.finality_threshold
        || existing.original_receipt_ref != next.original_receipt_ref
}

pub(super) fn finality_event_key(rail: &str, provider_event_id: &str) -> String {
    format!("{rail}\u{1f}{provider_event_id}")
}

pub(super) fn run_spend_ledger_key(
    family: &'static str,
    reservation: &EffectRunSpendReservation,
    currency: &str,
) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}",
        family, reservation.run_id, reservation.authority_ref, currency
    )
}

// rust-style-allow: long-function because period spend reservation enforces the
// per-period cap through a single sequence of cap, ledger, and tally checks

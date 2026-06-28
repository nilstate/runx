use crate::packets::PaymentRailPacket;

use super::{EffectFinalityIntentStatus, EffectMutationStatus, EffectRecoveryState};
pub(super) fn payment_recovery_state(packet: Option<&PaymentRailPacket>) -> EffectRecoveryState {
    match packet {
        Some(PaymentRailPacket {
            recovery_status: Some(status),
            ..
        }) if status == "sealed" => EffectRecoveryState::Sealed,
        Some(PaymentRailPacket {
            recovery_status: Some(status),
            ..
        }) if status == "terminal_decline" || status == "escalated" => {
            EffectRecoveryState::Escalated
        }
        Some(PaymentRailPacket {
            recovery_status: Some(status),
            ..
        }) if status == "recoverable_timeout" || status == "partial" || status == "in_flight" => {
            EffectRecoveryState::InFlight
        }
        Some(PaymentRailPacket { proof: Some(_), .. }) => EffectRecoveryState::Sealed,
        _ => EffectRecoveryState::InFlight,
    }
}

pub(super) fn rail_mutation_status(recovery_state: &EffectRecoveryState) -> EffectMutationStatus {
    match recovery_state {
        EffectRecoveryState::Sealed => EffectMutationStatus::Fulfilled,
        EffectRecoveryState::Escalated => EffectMutationStatus::Escalated,
        EffectRecoveryState::InFlight => EffectMutationStatus::Partial,
    }
}

pub(super) fn finality_intent_status_for_recovery(
    recovery_state: &EffectRecoveryState,
) -> EffectFinalityIntentStatus {
    match recovery_state {
        EffectRecoveryState::Sealed => EffectFinalityIntentStatus::Sealed,
        EffectRecoveryState::Escalated => EffectFinalityIntentStatus::Escalated,
        EffectRecoveryState::InFlight => EffectFinalityIntentStatus::Open,
    }
}

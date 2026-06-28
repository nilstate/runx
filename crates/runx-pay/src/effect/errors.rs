use runx_contracts::AuthorityVerb;
use runx_runtime::RuntimeEffectError;

use super::PAYMENT_EFFECT_FAMILY;
use crate::effect_state::EffectStateError;

pub(super) fn denied(message: impl Into<String>) -> RuntimeEffectError {
    RuntimeEffectError::Denied {
        family: PAYMENT_EFFECT_FAMILY.to_owned(),
        verb: AuthorityVerb::Commit,
        message: message.into(),
    }
}

pub(super) fn finality_intent_error(source: EffectStateError) -> RuntimeEffectError {
    if matches!(&source, EffectStateError::RunSpendCapExceeded { .. }) {
        denied(source.to_string())
    } else {
        failed("recording state settlement intent", source)
    }
}

pub(super) fn failed(
    operation: &'static str,
    source: impl std::fmt::Display,
) -> RuntimeEffectError {
    RuntimeEffectError::Failed {
        family: PAYMENT_EFFECT_FAMILY.to_owned(),
        operation,
        message: source.to_string(),
    }
}

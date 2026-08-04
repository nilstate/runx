use crate::RuntimeError;

use super::super::{APPEND_TOOL, LIST_HEADS_TOOL, READ_EVENTS_TOOL, READ_PROJECTION_TOOL};
use super::{Expectation, OperationResult, Status, invalid};

pub(super) fn validate(
    expectation: &Expectation,
    result: &OperationResult,
) -> Result<(), RuntimeError> {
    match expectation.tool_ref() {
        APPEND_TOOL => validate_append(expectation, result),
        READ_EVENTS_TOOL | READ_PROJECTION_TOOL | LIST_HEADS_TOOL => {
            validate_read(expectation, result)
        }
        _ => Err(invalid(expectation, "unknown data operation")),
    }
}

fn validate_append(
    expectation: &Expectation,
    result: &OperationResult,
) -> Result<(), RuntimeError> {
    match result.status {
        Status::Committed => {
            if Some(result.before_version) != expectation.expected_version() {
                return Err(invalid(
                    expectation,
                    "committed append did not honor expected_version",
                ));
            }
            let after = result
                .before_version
                .checked_add(1)
                .ok_or_else(|| invalid(expectation, "version overflow"))?;
            if result.after_version != after {
                return Err(invalid(
                    expectation,
                    "committed append must advance exactly one version",
                ));
            }
            require_requested_effect(expectation, result, true)?;
            require_no_stops(expectation, result)
        }
        Status::IdempotentReplay => {
            require_same_version(expectation, result)?;
            require_requested_effect(expectation, result, true)?;
            require_no_stops(expectation, result)
        }
        Status::Conflict => {
            require_same_version(expectation, result)?;
            require_requested_effect(expectation, result, false)?;
            if result.event_ref.is_some() || result.stop_conditions.is_empty() {
                return Err(invalid(
                    expectation,
                    "conflict must not claim an event and must include a stop condition",
                ));
            }
            Ok(())
        }
        Status::ProviderUnavailable => require_provider_stop(expectation, result),
        Status::Read => Err(invalid(
            expectation,
            "append operation cannot return read status",
        )),
    }
}

fn validate_read(expectation: &Expectation, result: &OperationResult) -> Result<(), RuntimeError> {
    match result.status {
        Status::Read => {
            require_same_version(expectation, result)?;
            if result.idempotency_key.is_some()
                || result.event_ref.is_some()
                || result.event_digest.is_some()
            {
                return Err(invalid(
                    expectation,
                    "read result must not claim a write effect",
                ));
            }
            require_no_stops(expectation, result)
        }
        Status::ProviderUnavailable => require_provider_stop(expectation, result),
        Status::Committed | Status::IdempotentReplay | Status::Conflict => Err(invalid(
            expectation,
            "read operation returned a write status",
        )),
    }
}

fn require_requested_effect(
    expectation: &Expectation,
    result: &OperationResult,
    require_event_ref: bool,
) -> Result<(), RuntimeError> {
    if result.idempotency_key.as_deref() != expectation.idempotency_key()
        || result.event_digest.as_deref() != expectation.event_digest()
        || require_event_ref && result.event_ref.is_none()
    {
        return Err(invalid(
            expectation,
            "append result does not match the requested idempotency or event effect",
        ));
    }
    Ok(())
}

fn require_provider_stop(
    expectation: &Expectation,
    result: &OperationResult,
) -> Result<(), RuntimeError> {
    require_same_version(expectation, result)?;
    if result.stop_conditions.is_empty() {
        Err(invalid(
            expectation,
            "provider_unavailable requires a stop condition",
        ))
    } else {
        Ok(())
    }
}

fn require_same_version(
    expectation: &Expectation,
    result: &OperationResult,
) -> Result<(), RuntimeError> {
    if result.before_version == result.after_version {
        Ok(())
    } else {
        Err(invalid(
            expectation,
            "non-commit result must not move the stream version",
        ))
    }
}

fn require_no_stops(
    expectation: &Expectation,
    result: &OperationResult,
) -> Result<(), RuntimeError> {
    if result.stop_conditions.is_empty() {
        Ok(())
    } else {
        Err(invalid(
            expectation,
            "successful result must not contain stop conditions",
        ))
    }
}

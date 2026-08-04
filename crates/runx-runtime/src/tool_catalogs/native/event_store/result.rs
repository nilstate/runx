mod expectation;
mod payload;
mod status;

use runx_contracts::{JsonValue, MAX_PORTABLE_INTEGER};

use crate::RuntimeError;

use super::{MAX_DATA_OPERATION_RESULT_BYTES, invalid_input};

pub(super) use expectation::Expectation;
use runx_contracts::{DataOperationResult as OperationResult, DataOperationStatus as Status};

const MAX_REDACTIONS: usize = 100;
const MAX_STOP_CONDITIONS: usize = 20;

pub(super) fn validate(expectation: &Expectation, value: &JsonValue) -> Result<(), RuntimeError> {
    let encoded = serde_json::to_vec(value).map_err(|source| {
        invalid(
            expectation,
            format!("provider result could not be encoded: {source}"),
        )
    })?;
    if encoded.len() > MAX_DATA_OPERATION_RESULT_BYTES {
        return Err(invalid(
            expectation,
            format!(
                "provider result exceeds the {MAX_DATA_OPERATION_RESULT_BYTES} byte data-operation limit"
            ),
        ));
    }
    let result: OperationResult = value.clone().deserialize_into().map_err(|source| {
        invalid(
            expectation,
            format!("provider returned an invalid operation result: {source}"),
        )
    })?;
    validate_identity(expectation, &result)?;
    validate_digests(expectation, &result)?;
    status::validate(expectation, &result)?;
    validate_metadata(expectation, &result)?;
    payload::validate(expectation, &result)
}

fn validate_identity(
    expectation: &Expectation,
    result: &OperationResult,
) -> Result<(), RuntimeError> {
    if result.schema != "runx.data.operation_result.v1" {
        return Err(invalid(
            expectation,
            "provider returned the wrong data-operation schema",
        ));
    }
    for (field, actual, expected) in [
        (
            "operation",
            result.operation.as_str(),
            expectation.operation(),
        ),
        (
            "data_source_ref",
            result.data_source_ref.as_str(),
            expectation.data_source_ref.as_str(),
        ),
        (
            "resource",
            result.resource.as_str(),
            expectation.resource.as_str(),
        ),
        (
            "aggregate_id",
            result.aggregate_id.as_str(),
            expectation.aggregate_id.as_str(),
        ),
    ] {
        if actual != expected {
            return Err(invalid(
                expectation,
                format!("provider changed {field}: expected {expected:?}, got {actual:?}"),
            ));
        }
    }
    if result.provider.trim().is_empty() {
        return Err(invalid(expectation, "provider must not be empty"));
    }
    if result.before_version > MAX_PORTABLE_INTEGER || result.after_version > MAX_PORTABLE_INTEGER {
        return Err(invalid(
            expectation,
            format!("provider returned a version above {MAX_PORTABLE_INTEGER}"),
        ));
    }
    Ok(())
}

fn validate_digests(
    expectation: &Expectation,
    result: &OperationResult,
) -> Result<(), RuntimeError> {
    for (field, digest) in [
        ("result_digest", result.result_digest.as_str()),
        ("projection_digest", result.projection_digest.as_str()),
    ] {
        if !valid_digest(digest) {
            return Err(invalid(
                expectation,
                format!("{field} must be a sha256 digest"),
            ));
        }
    }
    if let Some(digest) = result.event_digest.as_deref()
        && !valid_digest(digest)
    {
        return Err(invalid(
            expectation,
            "event_digest must be null or a sha256 digest",
        ));
    }
    for (field, value) in [
        ("idempotency_key", &result.idempotency_key),
        ("event_ref", &result.event_ref),
    ] {
        if value.as_deref().is_some_and(|text| text.trim().is_empty()) {
            return Err(invalid(expectation, format!("{field} must not be empty")));
        }
    }
    Ok(())
}

fn validate_metadata(
    expectation: &Expectation,
    result: &OperationResult,
) -> Result<(), RuntimeError> {
    if result.redactions.len() > MAX_REDACTIONS {
        return Err(invalid(
            expectation,
            "provider returned too many redactions",
        ));
    }
    if result.stop_conditions.len() > MAX_STOP_CONDITIONS {
        return Err(invalid(
            expectation,
            "provider returned too many stop conditions",
        ));
    }
    for stop in &result.stop_conditions {
        if stop.code.trim().is_empty() || stop.message.trim().is_empty() {
            return Err(invalid(
                expectation,
                "stop conditions require non-empty code and message",
            ));
        }
    }
    reject_secret_fields(
        expectation,
        &JsonValue::Object(result.provider_evidence.clone()),
        "provider_evidence",
    )?;
    reject_secret_fields(
        expectation,
        &JsonValue::Array(result.redactions.clone()),
        "redactions",
    )
}

fn reject_secret_fields(
    expectation: &Expectation,
    value: &JsonValue,
    path: &str,
) -> Result<(), RuntimeError> {
    if let Some(field) = crate::credentials::first_unregistered_secret_field(value) {
        return Err(invalid(
            expectation,
            format!("provider result contains secret-like field {path}.{field}"),
        ));
    }
    Ok(())
}

pub(super) fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

pub(super) fn invalid(expectation: &Expectation, message: impl Into<String>) -> RuntimeError {
    invalid_input(expectation.tool_ref(), message)
}

#[cfg(test)]
mod tests {
    use super::super::input::SourceIdentity;
    use super::*;

    #[test]
    fn rejects_results_above_the_core_data_operation_budget()
    -> Result<(), Box<dyn std::error::Error>> {
        let expectation = Expectation::read_projection(SourceIdentity {
            data_source_ref: "local://result-budget",
            resource: "events",
            aggregate_id: "stream-1",
        });
        let oversized = "x".repeat(MAX_DATA_OPERATION_RESULT_BYTES + 1);
        let oversized = JsonValue::String(oversized);

        let error = validate(&expectation, &oversized)
            .err()
            .ok_or("oversized result should fail")?;

        assert!(error.to_string().contains("data-operation limit"));
        Ok(())
    }
}

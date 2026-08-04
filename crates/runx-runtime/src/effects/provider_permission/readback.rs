use std::collections::BTreeSet;

use runx_contracts::{JsonObject, JsonValue};

use super::ProviderNativeAccess;
use super::execution::provider_tool_error;
use crate::{
    EffectToolRequest, ProviderAcknowledgementEvidence, ProviderEffectAttempt,
    ProviderEffectFinality, ProviderEffectReadback, ProviderEffectReadbackEvidence,
    ProviderOperationAccess, RuntimeError,
};

#[cfg(feature = "catalog")]
pub(super) fn provider_result_fields(
    request: &EffectToolRequest<'_>,
) -> Result<Option<Vec<String>>, RuntimeError> {
    let Some(value) = request.inputs.get("result_fields") else {
        return Ok(None);
    };
    let fields = value.as_array().ok_or_else(|| {
        provider_tool_error(
            request.tool_ref,
            "result_fields must be a non-empty string array",
        )
    })?;
    if fields.is_empty() || fields.len() > 50 {
        return Err(provider_tool_error(
            request.tool_ref,
            "result_fields must contain 1 to 50 entries",
        ));
    }
    let mut seen = BTreeSet::new();
    let mut projected = Vec::with_capacity(fields.len());
    for field in fields {
        let field = field
            .as_str()
            .map(str::trim)
            .filter(|field| valid_provider_result_field(field))
            .ok_or_else(|| {
                provider_tool_error(
                    request.tool_ref,
                    "result_fields entries must be safe non-empty top-level field names",
                )
            })?;
        if seen.insert(field.to_owned()) {
            projected.push(field.to_owned());
        }
    }
    Ok(Some(projected))
}

#[cfg(feature = "catalog")]
pub(super) fn provider_expected_result(
    request: &EffectToolRequest<'_>,
) -> Result<Option<JsonObject>, RuntimeError> {
    let Some(value) = request.inputs.get("expected_result") else {
        return Ok(None);
    };
    let expected = value.as_object().ok_or_else(|| {
        provider_tool_error(
            request.tool_ref,
            "expected_result must be a non-empty object",
        )
    })?;
    if expected.is_empty() || expected.len() > 50 {
        return Err(provider_tool_error(
            request.tool_ref,
            "expected_result must contain 1 to 50 fields",
        ));
    }
    if expected
        .keys()
        .any(|field| !valid_provider_result_field(field))
    {
        return Err(provider_tool_error(
            request.tool_ref,
            "expected_result keys must be safe non-empty top-level field names",
        ));
    }
    Ok(Some(expected.clone()))
}

#[cfg(feature = "catalog")]
fn valid_provider_result_field(field: &str) -> bool {
    !field.is_empty()
        && field.len() <= 100
        && field
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

#[cfg(feature = "catalog")]
pub(super) fn provider_operation_access(access: ProviderNativeAccess) -> ProviderOperationAccess {
    match access {
        ProviderNativeAccess::Read => ProviderOperationAccess::Read,
        ProviderNativeAccess::Mutate => ProviderOperationAccess::Mutate,
    }
}

#[cfg(feature = "catalog")]
pub(super) struct ProviderReadbackContract<'a> {
    pub(super) expected_provider: String,
    pub(super) grant_id: String,
    pub(super) access: ProviderNativeAccess,
    pub(super) principal_id: &'a str,
    pub(super) expected_result: Option<JsonObject>,
    pub(super) result_fields: Option<Vec<String>>,
    pub(super) finality: ProviderEffectFinality,
}

#[cfg(feature = "catalog")]
pub(super) fn complete_provider_effect(
    tool_ref: &str,
    attempt: ProviderEffectAttempt,
    readback: &JsonObject,
) -> Result<ProviderEffectFinality, RuntimeError> {
    let string = |field| {
        readback
            .get(field)
            .and_then(JsonValue::as_str)
            .map(str::to_owned)
    };
    let acknowledgement = attempt
        .acknowledge(ProviderAcknowledgementEvidence {
            provider: string("provider").unwrap_or_default(),
            operation: string("operation").unwrap_or_default(),
            target: string("target").unwrap_or_default(),
            operation_id: string("operation_id"),
            idempotency_key: string("idempotency_key"),
        })
        .map_err(|error| provider_tool_error(tool_ref, error.to_string()))?;
    acknowledgement
        .readback(ProviderEffectReadbackEvidence {
            provider: string("provider").unwrap_or_default(),
            operation: string("operation").unwrap_or_default(),
            target: string("target").unwrap_or_default(),
            operation_id: string("operation_id"),
            readback_ref: string("readback_ref").unwrap_or_default(),
            result: readback.get("result").cloned().unwrap_or(JsonValue::Null),
        })
        .map(ProviderEffectReadback::finalize)
        .map_err(|error| provider_tool_error(tool_ref, error.to_string()))
}

#[cfg(feature = "catalog")]
pub(super) fn project_provider_tool_readback(
    tool_ref: &str,
    mut readback: JsonObject,
    contract: ProviderReadbackContract<'_>,
) -> Result<JsonValue, RuntimeError> {
    validate_expected_provider(tool_ref, &readback, &contract.expected_provider)?;
    validate_expected_result(
        tool_ref,
        &readback,
        contract.expected_result.as_ref(),
        contract.result_fields.is_some(),
    )?;
    if let Some(fields) = contract.result_fields.as_deref() {
        project_result_fields(tool_ref, &mut readback, fields)?;
    }
    append_readback_contract(&mut readback, &contract);
    Ok(JsonValue::Object(JsonObject::from([(
        "provider_operation".to_owned(),
        JsonValue::Object(readback),
    )])))
}

fn validate_expected_provider(
    tool_ref: &str,
    readback: &JsonObject,
    expected_provider: &str,
) -> Result<(), RuntimeError> {
    if readback.get("provider").and_then(JsonValue::as_str) != Some(expected_provider) {
        return Err(provider_tool_error(
            tool_ref,
            format!(
                "provider readback did not match expected provider {:?}",
                expected_provider
            ),
        ));
    }
    Ok(())
}

fn validate_expected_result(
    tool_ref: &str,
    readback: &JsonObject,
    expected: Option<&JsonObject>,
    projection_requested: bool,
) -> Result<(), RuntimeError> {
    if expected.is_none() && !projection_requested {
        return Ok(());
    }
    let result = provider_result_object(tool_ref, readback)?;
    if let Some(expected) = expected {
        for (field, expected_value) in expected {
            if result.get(field) != Some(expected_value) {
                return Err(provider_tool_error(
                    tool_ref,
                    format!("provider result field {field:?} did not match the expected value"),
                ));
            }
        }
    }
    Ok(())
}

fn project_result_fields(
    tool_ref: &str,
    readback: &mut JsonObject,
    fields: &[String],
) -> Result<(), RuntimeError> {
    let result = provider_result_object(tool_ref, readback)?;
    let projected = fields
        .iter()
        .map(|field| {
            result
                .get(field)
                .cloned()
                .map(|value| (field.clone(), value))
                .ok_or_else(|| {
                    provider_tool_error(
                        tool_ref,
                        format!("provider result is missing required field {field:?}"),
                    )
                })
        })
        .collect::<Result<JsonObject, RuntimeError>>()?;
    readback.insert("result".to_owned(), JsonValue::Object(projected));
    Ok(())
}

fn provider_result_object<'a>(
    tool_ref: &str,
    readback: &'a JsonObject,
) -> Result<&'a JsonObject, RuntimeError> {
    readback
        .get("result")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| {
            provider_tool_error(
                tool_ref,
                "provider result must be an object when result verification is supplied",
            )
        })
}

fn append_readback_contract(readback: &mut JsonObject, contract: &ProviderReadbackContract<'_>) {
    readback.insert(
        "schema".to_owned(),
        JsonValue::String("runx.provider.operation.v1".to_owned()),
    );
    readback.insert(
        "access".to_owned(),
        JsonValue::String(
            match contract.access {
                ProviderNativeAccess::Read => "read",
                ProviderNativeAccess::Mutate => "mutate",
            }
            .to_owned(),
        ),
    );
    readback.insert(
        "principal_ref".to_owned(),
        JsonValue::String(format!("runx:principal:{}", contract.principal_id)),
    );
    readback.insert(
        "grant_ref".to_owned(),
        JsonValue::String(format!("runx:grant:{}", contract.grant_id)),
    );
    readback.insert(
        "finality".to_owned(),
        JsonValue::String("confirmed".to_owned()),
    );
    readback.insert(
        "plan_digest".to_owned(),
        JsonValue::String(contract.finality.plan_digest().to_owned()),
    );
    readback.insert(
        "idempotency_key".to_owned(),
        JsonValue::String(contract.finality.idempotency_key().to_owned()),
    );
    readback.insert(
        "readback_ref".to_owned(),
        JsonValue::String(contract.finality.readback_ref().to_owned()),
    );
    readback.insert(
        "result_digest".to_owned(),
        JsonValue::String(contract.finality.result_digest().to_owned()),
    );
    if let Some(operation_id) = contract.finality.operation_id() {
        readback.insert(
            "operation_id".to_owned(),
            JsonValue::String(operation_id.to_owned()),
        );
    }
}

use std::collections::BTreeSet;

use runx_contracts::{JsonObject, JsonValue, ProviderOperationPacket};

use super::ProviderNativeAccess;
use super::execution::provider_tool_error;
#[cfg(feature = "catalog")]
use crate::effects::EffectToolOutput;
use crate::{
    EffectToolRequest, ProviderAcknowledgementEvidence, ProviderEffectAttempt,
    ProviderEffectFinality, ProviderEffectReadback, ProviderEffectReadbackEvidence,
    ProviderOperationAccess, RuntimeError,
};

#[cfg(feature = "catalog")]
#[derive(Debug)]
pub(super) struct ProviderResultProjection {
    pub(super) required: Option<Vec<String>>,
    pub(super) optional: Option<Vec<String>>,
}

#[cfg(feature = "catalog")]
pub(super) fn provider_result_projection(
    request: &EffectToolRequest<'_>,
) -> Result<ProviderResultProjection, RuntimeError> {
    let required = provider_projection_fields(request, "result_fields")?;
    let optional = provider_projection_fields(request, "optional_result_fields")?;
    let ephemeral = provider_ephemeral_result_paths(request, &required, &optional)?;
    let total = required.as_ref().map_or(0, Vec::len)
        + optional.as_ref().map_or(0, Vec::len)
        + ephemeral.len();
    if total > 50 {
        return Err(provider_tool_error(
            request.tool_ref,
            "result fields and ephemeral result paths must contain at most 50 entries in total",
        ));
    }
    if let (Some(required), Some(optional)) = (&required, &optional) {
        let required = required.iter().map(String::as_str).collect::<BTreeSet<_>>();
        if optional
            .iter()
            .any(|field| required.contains(field.as_str()))
        {
            return Err(provider_tool_error(
                request.tool_ref,
                "result_fields and optional_result_fields must not overlap",
            ));
        }
    }
    Ok(ProviderResultProjection { required, optional })
}

#[cfg(feature = "catalog")]
fn provider_ephemeral_result_paths(
    request: &EffectToolRequest<'_>,
    required: &Option<Vec<String>>,
    optional: &Option<Vec<String>>,
) -> Result<Vec<Vec<String>>, RuntimeError> {
    let Some(value) = request.inputs.get("ephemeral_result_paths") else {
        return Ok(Vec::new());
    };
    let values = value.as_array().ok_or_else(|| {
        provider_tool_error(
            request.tool_ref,
            "ephemeral_result_paths must be a non-empty absolute object-field path array",
        )
    })?;
    if values.is_empty() || values.len() > 16 {
        return Err(provider_tool_error(
            request.tool_ref,
            "ephemeral_result_paths must contain 1 to 16 entries",
        ));
    }
    let projected = required
        .iter()
        .chain(optional.iter())
        .flat_map(|fields| fields.iter().map(String::as_str))
        .collect::<BTreeSet<_>>();
    let mut paths = Vec::with_capacity(values.len());
    for value in values {
        let raw = value.as_str().map(str::trim).ok_or_else(|| {
            provider_tool_error(
                request.tool_ref,
                "ephemeral_result_paths entries must be absolute object-field paths",
            )
        })?;
        let segments = raw
            .strip_prefix('/')
            .filter(|path| !path.is_empty())
            .map(|path| path.split('/').map(str::to_owned).collect::<Vec<_>>())
            .filter(|segments| {
                (2..=8).contains(&segments.len())
                    && segments
                        .iter()
                        .all(|segment| valid_provider_result_field(segment))
            })
            .ok_or_else(|| {
                provider_tool_error(
                    request.tool_ref,
                    "ephemeral_result_paths entries must name 2 to 8 safe object fields",
                )
            })?;
        if !projected.contains(segments[0].as_str()) {
            return Err(provider_tool_error(
                request.tool_ref,
                "each ephemeral result path must descend from a projected result field",
            ));
        }
        if paths.iter().any(|existing: &Vec<String>| {
            path_is_prefix(existing, &segments) || path_is_prefix(&segments, existing)
        }) {
            return Err(provider_tool_error(
                request.tool_ref,
                "ephemeral_result_paths must be unique and non-overlapping",
            ));
        }
        paths.push(segments);
    }
    Ok(paths)
}

#[cfg(feature = "catalog")]
fn path_is_prefix(left: &[String], right: &[String]) -> bool {
    left.len() <= right.len() && left.iter().zip(right).all(|(left, right)| left == right)
}

#[cfg(feature = "catalog")]
pub(super) fn partition_provider_tool_output(
    request: EffectToolRequest<'_>,
    mut output: JsonValue,
) -> Result<EffectToolOutput, RuntimeError> {
    let required = provider_projection_fields(&request, "result_fields")?;
    let optional = provider_projection_fields(&request, "optional_result_fields")?;
    let paths = provider_ephemeral_result_paths(&request, &required, &optional)?;
    if paths.is_empty() {
        return Ok(EffectToolOutput::durable(output));
    }
    let JsonValue::Object(root) = &mut output else {
        return Err(provider_tool_error(
            request.tool_ref,
            "provider operation output is unavailable for ephemeral projection",
        ));
    };
    let Some(JsonValue::Object(operation)) = root.get_mut("provider_operation") else {
        return Err(provider_tool_error(
            request.tool_ref,
            "provider operation output is unavailable for ephemeral projection",
        ));
    };
    let Some(JsonValue::Object(result)) = operation.get_mut("result") else {
        return Err(provider_tool_error(
            request.tool_ref,
            "provider result must be an object for ephemeral projection",
        ));
    };
    let mut ephemeral_result = JsonObject::new();
    for path in paths {
        if let Some(value) = remove_object_path(result, &path) {
            insert_object_path(&mut ephemeral_result, &path, value).map_err(|reason| {
                provider_tool_error(request.tool_ref, format!("ephemeral result path {reason}"))
            })?;
        }
    }
    if ephemeral_result.is_empty() {
        return Ok(EffectToolOutput::durable(output));
    }
    Ok(EffectToolOutput {
        value: output,
        ephemeral: Some(JsonValue::Object(JsonObject::from([(
            "provider_operation".to_owned(),
            JsonValue::Object(JsonObject::from([(
                "result".to_owned(),
                JsonValue::Object(ephemeral_result),
            )])),
        )]))),
    })
}

#[cfg(feature = "catalog")]
fn remove_object_path(object: &mut JsonObject, path: &[String]) -> Option<JsonValue> {
    let (field, tail) = path.split_first()?;
    if tail.is_empty() {
        return object.remove(field);
    }
    match object.get_mut(field) {
        Some(JsonValue::Object(child)) => remove_object_path(child, tail),
        _ => None,
    }
}

#[cfg(feature = "catalog")]
fn insert_object_path(
    object: &mut JsonObject,
    path: &[String],
    value: JsonValue,
) -> Result<(), &'static str> {
    let Some((field, tail)) = path.split_first() else {
        return Err("is empty");
    };
    if tail.is_empty() {
        object.insert(field.clone(), value);
        return Ok(());
    }
    let child = object
        .entry(field.clone())
        .or_insert_with(|| JsonValue::Object(JsonObject::new()));
    let JsonValue::Object(child) = child else {
        return Err("crosses a non-object value");
    };
    insert_object_path(child, tail, value)
}

#[cfg(feature = "catalog")]
fn provider_projection_fields(
    request: &EffectToolRequest<'_>,
    input_name: &str,
) -> Result<Option<Vec<String>>, RuntimeError> {
    let Some(value) = request.inputs.get(input_name) else {
        return Ok(None);
    };
    let fields = value.as_array().ok_or_else(|| {
        provider_tool_error(
            request.tool_ref,
            format!("{input_name} must be a non-empty string array"),
        )
    })?;
    if fields.is_empty() || fields.len() > 50 {
        return Err(provider_tool_error(
            request.tool_ref,
            format!("{input_name} must contain 1 to 50 entries"),
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
                    format!("{input_name} entries must be safe non-empty top-level field names"),
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
pub(super) struct ProviderReadbackContract {
    pub(super) expected_provider: String,
    pub(super) operation: String,
    pub(super) target: String,
    pub(super) grant_id: String,
    pub(super) access: ProviderNativeAccess,
    pub(super) principal_ref: String,
    pub(super) transport: &'static str,
    pub(super) expected_result: Option<JsonObject>,
    pub(super) result_fields: Option<Vec<String>>,
    pub(super) optional_result_fields: Option<Vec<String>>,
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
    contract: ProviderReadbackContract,
) -> Result<JsonValue, RuntimeError> {
    validate_expected_provider(tool_ref, &readback, &contract.expected_provider)?;
    validate_expected_result(
        tool_ref,
        &readback,
        contract.expected_result.as_ref(),
        contract.result_fields.is_some() || contract.optional_result_fields.is_some(),
    )?;
    if contract.result_fields.is_some() || contract.optional_result_fields.is_some() {
        project_result_fields(
            tool_ref,
            &mut readback,
            contract.result_fields.as_deref().unwrap_or_default(),
            contract
                .optional_result_fields
                .as_deref()
                .unwrap_or_default(),
        )?;
    }
    append_readback_contract(&mut readback, &contract);
    validate_provider_operation_packet(tool_ref, &readback)?;
    Ok(JsonValue::Object(JsonObject::from([(
        "provider_operation".to_owned(),
        JsonValue::Object(readback),
    )])))
}

fn validate_provider_operation_packet(
    tool_ref: &str,
    readback: &JsonObject,
) -> Result<(), RuntimeError> {
    let value = serde_json::to_value(readback).map_err(|error| {
        provider_tool_error(
            tool_ref,
            format!("provider packet encoding failed: {error}"),
        )
    })?;
    serde_json::from_value::<ProviderOperationPacket>(value).map_err(|error| {
        provider_tool_error(
            tool_ref,
            format!("provider operation packet violates its core contract: {error}"),
        )
    })?;
    Ok(())
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
    required_fields: &[String],
    optional_fields: &[String],
) -> Result<(), RuntimeError> {
    let result = provider_result_object(tool_ref, readback)?;
    let mut projected = required_fields
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
    for field in optional_fields {
        if let Some(value) = result.get(field) {
            projected.insert(field.clone(), value.clone());
        }
    }
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

fn append_readback_contract(readback: &mut JsonObject, contract: &ProviderReadbackContract) {
    readback.insert(
        "schema".to_owned(),
        JsonValue::String("runx.provider.operation.v1".to_owned()),
    );
    readback.insert("status".to_owned(), JsonValue::String("success".to_owned()));
    readback.insert(
        "operation".to_owned(),
        JsonValue::String(contract.operation.clone()),
    );
    readback.insert(
        "target".to_owned(),
        JsonValue::String(contract.target.clone()),
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
        JsonValue::String(contract.principal_ref.clone()),
    );
    readback.insert(
        "transport".to_owned(),
        JsonValue::String(contract.transport.to_owned()),
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

#[cfg(all(test, feature = "catalog"))]
mod tests {
    use std::collections::BTreeMap;
    use std::path::Path;

    use runx_contracts::{JsonObject, JsonValue};

    use super::partition_provider_tool_output;
    use crate::credentials::CredentialDelivery;
    use crate::effects::EffectToolRequest;

    const SENTINEL: &str = "auc_secret_capability";

    #[test]
    fn ephemeral_provider_path_is_removed_from_durable_result()
    -> Result<(), Box<dyn std::error::Error>> {
        let inputs = JsonObject::from([
            (
                "result_fields".to_owned(),
                JsonValue::Array(vec![JsonValue::String("resource_result".to_owned())]),
            ),
            (
                "ephemeral_result_paths".to_owned(),
                JsonValue::Array(vec![JsonValue::String(
                    "/resource_result/resource_access".to_owned(),
                )]),
            ),
        ]);
        let env = BTreeMap::new();
        let credentials = CredentialDelivery::none();
        let output = provider_output();

        let partitioned = partition_provider_tool_output(
            EffectToolRequest {
                tool_ref: "provider.read",
                observed_at: "2026-09-01T00:00:00Z",
                inputs: &inputs,
                env: &env,
                skill_directory: Path::new("."),
                credential_delivery: &credentials,
                admission: None,
            },
            output,
        )?;

        let durable = serde_json::to_string(&partitioned.value)?;
        assert!(!durable.contains(SENTINEL));
        assert!(durable.contains("resource_lease"));
        assert!(
            serde_json::to_string(&partitioned.ephemeral.ok_or("missing ephemeral overlay")?)?
                .contains(SENTINEL)
        );
        Ok(())
    }

    #[test]
    fn ephemeral_provider_path_must_descend_from_projected_result()
    -> Result<(), Box<dyn std::error::Error>> {
        let inputs = JsonObject::from([
            (
                "result_fields".to_owned(),
                JsonValue::Array(vec![JsonValue::String("payment_ref".to_owned())]),
            ),
            (
                "ephemeral_result_paths".to_owned(),
                JsonValue::Array(vec![JsonValue::String(
                    "/resource_result/resource_access".to_owned(),
                )]),
            ),
        ]);
        let env = BTreeMap::new();
        let credentials = CredentialDelivery::none();
        let error = partition_provider_tool_output(
            EffectToolRequest {
                tool_ref: "provider.read",
                observed_at: "2026-09-01T00:00:00Z",
                inputs: &inputs,
                env: &env,
                skill_directory: Path::new("."),
                credential_delivery: &credentials,
                admission: None,
            },
            provider_output(),
        )
        .err()
        .ok_or("unprojected ephemeral path unexpectedly succeeded")?;

        assert!(error.to_string().contains("projected result field"));
        Ok(())
    }

    fn provider_output() -> JsonValue {
        JsonValue::Object(JsonObject::from([(
            "provider_operation".to_owned(),
            JsonValue::Object(JsonObject::from([(
                "result".to_owned(),
                JsonValue::Object(JsonObject::from([(
                    "resource_result".to_owned(),
                    JsonValue::Object(JsonObject::from([
                        (
                            "resource_lease".to_owned(),
                            JsonValue::String("lease_123".to_owned()),
                        ),
                        (
                            "resource_access".to_owned(),
                            JsonValue::String(SENTINEL.to_owned()),
                        ),
                    ])),
                )])),
            )])),
        )]))
    }
}

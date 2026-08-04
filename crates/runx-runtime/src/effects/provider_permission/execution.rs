use runx_contracts::{JsonObject, JsonValue};

use super::readback::{
    ProviderReadbackContract, complete_provider_effect, project_provider_tool_readback,
    provider_expected_result, provider_operation_access, provider_result_fields,
};
use super::recovery::{persist_provider_attempt, persist_provider_unknown};
use super::{
    PROVIDER_PERMISSION_EFFECT_FAMILY, ProviderNativeAccess, ProviderPermissionAdmission,
    ProviderPermissionEffect,
};
use crate::{
    EffectToolRequest, HostedApiEnvironment, ProviderEffectAttempt, ProviderOperationRequest,
    RuntimeError, hosted_private_network_allowed, invoke_provider_operation,
};

#[cfg(feature = "catalog")]
pub(super) fn invoke_provider_tool(
    effect: &ProviderPermissionEffect,
    request: EffectToolRequest<'_>,
    access: ProviderNativeAccess,
) -> Result<JsonValue, RuntimeError> {
    let input = admit_provider_tool_invocation(&request, access)?;
    let transport = effect
        .http_transport(hosted_private_network_allowed(false, request.env))
        .map_err(|error| provider_tool_error(request.tool_ref, error.to_string()))?;
    let resolved = HostedApiEnvironment::resolve(None, None, request.env, request.skill_directory)
        .map_err(|error| provider_tool_error(request.tool_ref, error.to_string()))?;
    let environment = effect
        .authenticated_environment(&resolved, transport.as_ref())
        .map_err(|error| provider_tool_error(request.tool_ref, error.to_string()))?;
    let authenticated_principal_ref = format!("runx:principal:{}", environment.principal_id());
    if input.attempt.resolved().authority().principal_ref() != authenticated_principal_ref {
        return Err(provider_tool_error(
            request.tool_ref,
            "authenticated provider principal does not match the admitted effect authority",
        ));
    }
    let attempt = input.attempt.clone();
    if access == ProviderNativeAccess::Mutate {
        persist_provider_attempt(&input.admission, &attempt)
            .map_err(|error| RuntimeError::effect_state("persisting provider attempt", error))?;
    }
    let readback = invoke_provider_operation(
        transport.as_ref(),
        &environment,
        &ProviderOperationRequest {
            grant_id: input.grant_id.clone(),
            operation: input.operation.clone(),
            target: input.target.clone(),
            scopes: input.admission.required_scopes.clone(),
            input: input.payload,
            expected_access: Some(provider_operation_access(access)),
        },
    );
    let result = readback
        .map_err(|error| provider_tool_error(request.tool_ref, error.to_string()))
        .and_then(|readback| {
            let finality = complete_provider_effect(request.tool_ref, attempt.clone(), &readback)?;
            project_provider_tool_readback(
                request.tool_ref,
                readback,
                ProviderReadbackContract {
                    expected_provider: input.expected_provider,
                    grant_id: input.grant_id,
                    access,
                    principal_id: environment.principal_id(),
                    expected_result: input.expected_result,
                    result_fields: input.result_fields,
                    finality,
                },
            )
        });
    result.map_err(|error| {
        if access == ProviderNativeAccess::Read {
            return error;
        }
        let unknown = attempt
            .clone()
            .unknown("provider operation did not produce verified finality");
        if let Err(state_error) = persist_provider_unknown(&input.admission, &unknown) {
            return RuntimeError::effect_state(
                "persisting unknown provider outcome",
                format!("{state_error}; original provider error: {error}"),
            );
        }
        RuntimeError::ProviderEffectUnknown {
            plan_digest: attempt.resolved().plan_digest().to_owned(),
            idempotency_key: attempt.idempotency_key().to_owned(),
            reason: error.to_string(),
        }
    })
}

#[cfg(feature = "catalog")]
pub(super) struct ProviderToolInvocation {
    expected_provider: String,
    pub(super) grant_id: String,
    operation: String,
    target: String,
    payload: JsonObject,
    expected_result: Option<JsonObject>,
    result_fields: Option<Vec<String>>,
    attempt: ProviderEffectAttempt,
    admission: ProviderPermissionAdmission,
}

#[cfg(feature = "catalog")]
pub(super) fn admit_provider_tool_invocation(
    request: &EffectToolRequest<'_>,
    access: ProviderNativeAccess,
) -> Result<ProviderToolInvocation, RuntimeError> {
    let expected_provider = required_provider_tool_string(request, "expected_provider")?;
    let context = provider_admission_context(request)?;
    let grant_id = context.grant_id.clone();
    let attempt = context.attempt.clone().ok_or_else(|| {
        provider_tool_error(
            request.tool_ref,
            "native provider tool is missing its resolved approval/attempt transition",
        )
    })?;
    let operation = required_provider_tool_string(request, "operation")?;
    let target = required_provider_tool_string(request, "target")?;
    let mut payload = request
        .inputs
        .get("input")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    inject_provider_idempotency(request.tool_ref, access, &attempt, &mut payload)?;
    Ok(ProviderToolInvocation {
        expected_provider: expected_provider.to_owned(),
        grant_id,
        operation: operation.to_owned(),
        target: target.to_owned(),
        payload,
        expected_result: provider_expected_result(request)?,
        result_fields: provider_result_fields(request)?,
        attempt,
        admission: context.clone(),
    })
}

fn provider_admission_context<'a>(
    request: &'a EffectToolRequest<'_>,
) -> Result<&'a ProviderPermissionAdmission, RuntimeError> {
    let admission = request.admission.ok_or_else(|| {
        provider_tool_error(
            request.tool_ref,
            "native provider tools require the current step's provider admission",
        )
    })?;
    if admission.family() != PROVIDER_PERMISSION_EFFECT_FAMILY {
        return Err(provider_tool_error(
            request.tool_ref,
            "native provider tool received an admission from another effect family",
        ));
    }
    let context = admission
        .context::<ProviderPermissionAdmission>()
        .ok_or_else(|| {
            provider_tool_error(
                request.tool_ref,
                "native provider tool admission is missing provider grant evidence",
            )
        })?;
    Ok(context)
}

fn required_provider_tool_string<'a>(
    request: &'a EffectToolRequest<'_>,
    field: &str,
) -> Result<&'a str, RuntimeError> {
    request
        .inputs
        .get(field)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            provider_tool_error(
                request.tool_ref,
                format!("{field} must be a non-empty string"),
            )
        })
}

#[cfg(feature = "catalog")]
pub(super) fn inject_provider_idempotency(
    tool_ref: &str,
    access: ProviderNativeAccess,
    attempt: &ProviderEffectAttempt,
    payload: &mut JsonObject,
) -> Result<(), RuntimeError> {
    if payload.contains_key("idempotency_key") {
        return Err(provider_tool_error(
            tool_ref,
            "provider input must not duplicate the native idempotency_key field",
        ));
    }
    if access == ProviderNativeAccess::Mutate {
        payload.insert(
            "idempotency_key".to_owned(),
            JsonValue::String(attempt.idempotency_key().to_owned()),
        );
    }
    Ok(())
}

#[cfg(feature = "catalog")]
pub(super) fn provider_tool_error(tool_ref: &str, message: impl Into<String>) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: tool_ref.to_owned(),
        message: message.into(),
    }
}

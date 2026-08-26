use runx_contracts::{JsonObject, JsonValue};

use super::readback::{
    ProviderReadbackContract, complete_provider_effect, project_provider_tool_readback,
    provider_expected_result, provider_operation_access, provider_result_projection,
};
use super::recovery::{
    persist_provider_attempt, persist_provider_readback, persist_provider_unknown,
};
use super::{
    PROVIDER_PERMISSION_EFFECT_FAMILY, ProviderNativeAccess, ProviderPermissionAdmission,
    ProviderPermissionEffect,
    identity::{ProviderTransportSelection, hosted_principal_reference},
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
    let attempt = input.attempt.clone();
    if access == ProviderNativeAccess::Mutate
        && input.admission.recovery.as_ref().is_some_and(|recovery| {
            recovery.previous_attempt().is_some() && recovery.cached_readback().is_none()
        })
        && matches!(&input.transport, ProviderTransportSelection::LocalGithub(_))
        && !super::local_github::mutation_is_replay_safe(&input.operation)
            .map_err(|error| provider_tool_error(request.tool_ref, error.to_string()))?
    {
        return Err(RuntimeError::ProviderEffectUnknown {
            plan_digest: attempt.resolved().plan_digest().to_owned(),
            idempotency_key: attempt.idempotency_key().to_owned(),
            reason: "local GitHub mutation has an unknown prior outcome and cannot be repeated safely; inspect the provider result before resuming"
                .to_owned(),
        });
    }
    if access == ProviderNativeAccess::Mutate {
        persist_provider_attempt(&input.admission, &attempt)
            .map_err(|error| RuntimeError::effect_state("persisting provider attempt", error))?;
    }
    let readback = cached_provider_readback(&input).map_or_else(
        || match &input.transport {
            ProviderTransportSelection::Hosted => {
                invoke_hosted_provider(effect, &request, access, &input)
            }
            ProviderTransportSelection::LocalGithub(binding) => super::local_github::invoke(
                request.env,
                request.skill_directory,
                binding,
                &input.operation,
                access,
                &input.payload,
            )
            .map(|readback| (readback, binding.principal_ref(), "local_github"))
            .map_err(|error| provider_tool_error(request.tool_ref, error.to_string())),
        },
        Ok,
    );
    let result = readback.and_then(|readback| {
        let finality = complete_provider_effect(request.tool_ref, attempt.clone(), &readback.0)?;
        if access == ProviderNativeAccess::Mutate {
            persist_provider_readback(&input.admission, &attempt, &readback.0).map_err(
                |error| RuntimeError::effect_state("persisting provider readback", error),
            )?;
        }
        project_provider_tool_readback(
            request.tool_ref,
            readback.0,
            ProviderReadbackContract {
                expected_provider: input.expected_provider,
                operation: input.operation,
                target: input.target,
                grant_id: input.grant_id,
                access,
                principal_ref: readback.1,
                transport: readback.2,
                expected_result: input.expected_result,
                result_fields: input.result_fields,
                optional_result_fields: input.optional_result_fields,
                finality,
            },
        )
    });
    result.map_err(|error| {
        if access == ProviderNativeAccess::Read {
            if is_mutation_readback_request(request.inputs) {
                return RuntimeError::ProviderReadbackPending {
                    step_id: "provider-readback".to_owned(),
                    reason: error.to_string(),
                };
            }
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

/// An explicitly marked provider read carrying the exact mutation identity is
/// the independent readback boundary for a prior provider write. If that read
/// cannot be completed, the write must not be reported as an ordinary failed
/// mutation: the provider may already have applied it, so the safe disposition
/// is deferred/reconcile rather than retry.
fn is_mutation_readback_request(inputs: &JsonObject) -> bool {
    inputs.get("readback").and_then(JsonValue::as_bool) == Some(true)
        && inputs
            .get("input")
            .and_then(JsonValue::as_object)
            .is_some_and(|input| {
                input.get("sync_ref").and_then(JsonValue::as_str).is_some()
                    && input
                        .get("mutation_digest")
                        .and_then(JsonValue::as_str)
                        .is_some()
                    && input
                        .get("mutation")
                        .and_then(JsonValue::as_object)
                        .is_some()
            })
}

fn cached_provider_readback(
    input: &ProviderToolInvocation,
) -> Option<(JsonObject, String, &'static str)> {
    let readback = input
        .admission
        .recovery
        .as_ref()?
        .cached_readback()?
        .clone();
    let transport = match &input.transport {
        ProviderTransportSelection::Hosted => "runx_connect",
        ProviderTransportSelection::LocalGithub(_) => "local_github",
    };
    Some((
        readback,
        input
            .attempt
            .resolved()
            .authority()
            .principal_ref()
            .to_owned(),
        transport,
    ))
}

fn invoke_hosted_provider(
    effect: &ProviderPermissionEffect,
    request: &EffectToolRequest<'_>,
    access: ProviderNativeAccess,
    input: &ProviderToolInvocation,
) -> Result<(JsonObject, String, &'static str), RuntimeError> {
    let transport = effect
        .http_transport(hosted_private_network_allowed(false, request.env))
        .map_err(|error| provider_tool_error(request.tool_ref, error.to_string()))?;
    let resolved = HostedApiEnvironment::resolve(None, None, request.env, request.skill_directory)
        .map_err(|error| provider_tool_error(request.tool_ref, error.to_string()))?;
    let environment = effect
        .authenticated_environment(&resolved, transport.as_ref())
        .map_err(|error| provider_tool_error(request.tool_ref, error.to_string()))?;
    let principal_ref = hosted_principal_reference(&environment);
    if input.attempt.resolved().authority().principal_ref() != principal_ref {
        return Err(provider_tool_error(
            request.tool_ref,
            "authenticated provider principal does not match the admitted effect authority",
        ));
    }
    invoke_provider_operation(
        transport.as_ref(),
        &environment,
        &ProviderOperationRequest {
            grant_id: input.grant_id.clone(),
            operation: input.operation.clone(),
            target: input.target.clone(),
            scopes: input.admission.required_scopes.clone(),
            input: input.payload.clone(),
            expected_access: Some(provider_operation_access(access)),
        },
    )
    .map(|readback| (readback, principal_ref, "runx_connect"))
    .map_err(|error| provider_tool_error(request.tool_ref, error.to_string()))
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
    optional_result_fields: Option<Vec<String>>,
    attempt: ProviderEffectAttempt,
    admission: ProviderPermissionAdmission,
    transport: ProviderTransportSelection,
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
    if operation != attempt.resolved().intent().operation()
        || expected_provider != attempt.resolved().intent().provider()
    {
        return Err(provider_tool_error(
            request.tool_ref,
            "provider operation or provider identity changed after admission",
        ));
    }
    let target = attempt.resolved().intent().target();
    let mut payload = request
        .inputs
        .get("input")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    inject_provider_idempotency(request.tool_ref, access, &attempt, &mut payload)?;
    let projection = provider_result_projection(request)?;
    Ok(ProviderToolInvocation {
        expected_provider: expected_provider.to_owned(),
        grant_id,
        operation: operation.to_owned(),
        target: target.to_owned(),
        payload,
        expected_result: provider_expected_result(request)?,
        result_fields: projection.required,
        optional_result_fields: projection.optional,
        attempt,
        admission: context.clone(),
        transport: context.transport.clone(),
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

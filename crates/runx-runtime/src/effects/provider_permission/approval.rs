use runx_contracts::{
    ApprovalGate, AuthorityVerb, JsonObject, JsonValue, ProofKind, Reference, ReferenceType,
    ResolutionResponseActor,
};

use super::policy::{ProviderPermissionPlan, provider_permission_policy_error};
use super::{PROVIDER_PERMISSION_EFFECT_FAMILY, ProviderNativeAccess, ProviderPermissionAdmission};
use crate::approval::ApprovalResolution;
use crate::effects::{
    EffectAdmission, EffectApprovalRequirement, EffectOutputRequest, EffectStepRequest,
    ProviderApprovalEvidence, ProviderEffectAuthority, ProviderEffectClass, ProviderEffectIntent,
    ProviderEffectIntentInput, ProviderEffectResolved, RuntimeEffectError,
};

pub(super) fn resolved_provider_effect(
    request: &EffectStepRequest<'_>,
    plan: &ProviderPermissionPlan,
    access: ProviderNativeAccess,
    principal_ref: &str,
    resolved_target: Option<&str>,
) -> Result<ProviderEffectResolved, RuntimeEffectError> {
    let provider = required_provider_input(request.inputs, "expected_provider")?;
    let operation = required_provider_input(request.inputs, "operation")?;
    let target = match resolved_target {
        Some(target) => target,
        None => required_provider_input(request.inputs, "target")?,
    };
    let payload = request
        .inputs
        .get("input")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    let request_key = match access {
        ProviderNativeAccess::Read => None,
        ProviderNativeAccess::Mutate => {
            Some(required_provider_input(request.inputs, "idempotency_key")?)
        }
    };
    let class = match access {
        ProviderNativeAccess::Read => ProviderEffectClass::Read,
        ProviderNativeAccess::Mutate => ProviderEffectClass::Mutation,
    };
    let intent = ProviderEffectIntent::new(ProviderEffectIntentInput {
        class,
        provider,
        operation,
        target,
        payload: &payload,
        required_scopes: plan.required_scopes.clone(),
        amount: None,
        request_key,
    })
    .map_err(provider_effect_state_error)?;
    let authority = ProviderEffectAuthority::new(plan.grant_id.clone(), principal_ref)
        .map_err(provider_effect_state_error)?;
    ProviderEffectResolved::new(intent, authority).map_err(provider_effect_state_error)
}

pub(super) fn required_provider_input<'a>(
    inputs: &'a JsonObject,
    field: &'static str,
) -> Result<&'a str, RuntimeEffectError> {
    inputs
        .get(field)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| provider_permission_policy_error(format!("{field} is required")))
}

pub(super) fn resolve_provider_approval(
    requirement: EffectApprovalRequirement,
    step: &runx_parser::GraphStep,
    admission: EffectAdmission,
    host: &mut dyn crate::Host,
) -> Result<EffectAdmission, RuntimeEffectError> {
    let mut context = admission
        .context::<ProviderPermissionAdmission>()
        .cloned()
        .ok_or_else(|| RuntimeEffectError::Failed {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            operation: "resolve provider approval",
            message: "provider permission admission context is missing".to_owned(),
        })?;
    let Some(resolved) = context.provider_effect.clone() else {
        if requirement == EffectApprovalRequirement::Required {
            return Err(RuntimeEffectError::InvalidMetadata {
                family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
                message: "effect approval is required for a target without a provider effect plan"
                    .to_owned(),
            });
        }
        return Ok(admission);
    };
    let approval = match (resolved.intent().class(), requirement) {
        (ProviderEffectClass::Read, EffectApprovalRequirement::Forbidden) => None,
        (ProviderEffectClass::Mutation, EffectApprovalRequirement::Required) => Some(match context
            .recovery
            .as_ref()
            .and_then(super::recovery::ProviderRecoveryContext::approval_key)
        {
            Some(approval_key) => ProviderApprovalEvidence {
                actor: "human".to_owned(),
                approval_key: approval_key.to_owned(),
                plan_digest: resolved.plan_digest().to_owned(),
            },
            None => request_exact_provider_approval(step, &resolved, host)?,
        }),
        (class, requirement) => {
            return Err(RuntimeEffectError::InvalidMetadata {
                family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
                message: format!(
                    "provider effect class {class:?} is inconsistent with approval requirement {requirement:?}"
                ),
            });
        }
    };
    context.attempt = Some(match (approval, context.recovery.as_ref()) {
        (Some(approval), Some(recovery)) => match recovery.previous_attempt() {
            Some(previous_attempt) => resolved
                .begin_retry(approval, previous_attempt)
                .map_err(provider_effect_state_error)?,
            None => resolved
                .begin(Some(approval))
                .map_err(provider_effect_state_error)?,
        },
        (approval, _) => resolved
            .begin(approval)
            .map_err(provider_effect_state_error)?,
    });
    Ok(admission.with_context(context))
}

fn request_exact_provider_approval(
    step: &runx_parser::GraphStep,
    resolved: &ProviderEffectResolved,
    host: &mut dyn crate::Host,
) -> Result<ProviderApprovalEvidence, RuntimeEffectError> {
    let gate_id = format!("provider-effect:{}", resolved.plan_digest());
    let gate = ApprovalGate {
        id: gate_id.clone().into(),
        reason: format!(
            "Approve {} on {} for {}.",
            resolved.intent().operation(),
            resolved.intent().provider(),
            resolved.intent().target()
        )
        .into(),
        gate_type: Some("provider_effect".to_owned()),
        summary: Some(resolved.approval_summary()),
    };
    let resolution = crate::request_approval(host, gate_id.clone(), gate).map_err(|error| {
        RuntimeEffectError::Failed {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            operation: "resolve provider approval",
            message: error.to_string(),
        }
    })?;
    match resolution {
        ApprovalResolution::Approved {
            actor: ResolutionResponseActor::Human,
            idempotency_key,
            ..
        } => Ok(ProviderApprovalEvidence {
            actor: "human".to_owned(),
            approval_key: idempotency_key,
            plan_digest: resolved.plan_digest().to_owned(),
        }),
        ApprovalResolution::Approved {
            actor: ResolutionResponseActor::Agent,
            ..
        } => Err(RuntimeEffectError::Denied {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            verb: AuthorityVerb::Write,
            message: format!(
                "provider mutation for step '{}' requires host-attested human approval",
                step.id
            ),
        }),
        ApprovalResolution::Denied { reason, .. } => Err(RuntimeEffectError::Denied {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            verb: AuthorityVerb::Write,
            message: reason
                .unwrap_or_else(|| format!("provider effect for step '{}' was denied", step.id)),
        }),
        ApprovalResolution::Pending { .. } => Err(RuntimeEffectError::ApprovalPending {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            message: format!(
                "exact provider effect approval {gate_id:?} for step '{}' is pending",
                step.id,
            ),
        }),
    }
}

fn provider_effect_state_error(error: impl std::fmt::Display) -> RuntimeEffectError {
    RuntimeEffectError::Failed {
        family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
        operation: "provider effect state",
        message: error.to_string(),
    }
}

pub(super) fn prepare_provider_effect_output(
    request: EffectOutputRequest<'_>,
) -> Result<(), RuntimeEffectError> {
    if !request.output.succeeded() {
        return Ok(());
    }
    let context = request
        .admission
        .context::<ProviderPermissionAdmission>()
        .ok_or_else(|| provider_effect_output_error("provider admission context is missing"))?;
    let Some(attempt) = context.attempt.as_ref() else {
        return Ok(());
    };
    let operation = provider_operation_claim(request.claim)?;
    require_provider_output_field(operation, "finality", "confirmed")?;
    require_provider_output_field(operation, "plan_digest", attempt.resolved().plan_digest())?;
    require_provider_output_field(operation, "idempotency_key", attempt.idempotency_key())?;
    let readback_ref = required_provider_output_field(operation, "readback_ref")?;
    let provider = attempt.resolved().intent().provider();
    let plan_ref = provider_proof_reference(
        format!("runx:provider_effect:{}", attempt.resolved().plan_digest()),
        provider,
        "provider effect plan",
        ProofKind::EffectEvidence,
    );
    crate::effects::insert_effect_verification_ref(&mut request.output.metadata, plan_ref)?;
    if let Some(approval_key) = attempt.approval_key() {
        crate::effects::insert_effect_verification_ref(
            &mut request.output.metadata,
            provider_proof_reference(
                format!("runx:provider_approval:{approval_key}"),
                provider,
                "exact provider approval",
                ProofKind::EffectEvidence,
            ),
        )?;
    }
    if attempt.resolved().intent().class() == ProviderEffectClass::Mutation {
        let operation_id = required_provider_output_field(operation, "operation_id")?;
        crate::effects::insert_effect_verification_ref(
            &mut request.output.metadata,
            provider_proof_reference(
                format!("runx:provider_ack:{operation_id}"),
                provider,
                "provider acknowledgement",
                ProofKind::EffectEvidence,
            ),
        )?;
    }
    crate::effects::insert_effect_verification_ref(
        &mut request.output.metadata,
        provider_proof_reference(
            readback_ref.to_owned(),
            provider,
            "independent provider readback",
            ProofKind::EffectFinality,
        ),
    )
}

fn provider_proof_reference(
    uri: String,
    provider: &str,
    label: &str,
    proof_kind: ProofKind,
) -> Reference {
    Reference {
        reference_type: ReferenceType::Verification,
        uri: uri.into(),
        provider: Some(provider.to_owned().into()),
        locator: None,
        label: Some(label.to_owned().into()),
        observed_at: None,
        proof_kind: Some(proof_kind),
    }
}

fn provider_operation_claim(claim: &JsonObject) -> Result<&JsonObject, RuntimeEffectError> {
    let packet = claim
        .get("provider_operation")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| provider_effect_output_error("provider_operation packet is missing"))?;
    Ok(packet
        .get("data")
        .and_then(JsonValue::as_object)
        .unwrap_or(packet))
}

fn required_provider_output_field<'a>(
    operation: &'a JsonObject,
    field: &'static str,
) -> Result<&'a str, RuntimeEffectError> {
    operation
        .get(field)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| provider_effect_output_error(format!("provider output is missing {field}")))
}

fn require_provider_output_field(
    operation: &JsonObject,
    field: &'static str,
    expected: &str,
) -> Result<(), RuntimeEffectError> {
    let actual = required_provider_output_field(operation, field)?;
    if actual == expected {
        Ok(())
    } else {
        Err(provider_effect_output_error(format!(
            "provider output {field} does not match admitted effect"
        )))
    }
}

fn provider_effect_output_error(message: impl Into<String>) -> RuntimeEffectError {
    RuntimeEffectError::Failed {
        family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
        operation: "provider effect state",
        message: message.into(),
    }
}

use std::collections::BTreeMap;

use runx_contracts::{AuthorityVerb, JsonObject, JsonValue, sha256_prefixed};
use runx_core::{
    policy::{ScopeGrantPolicy, missing_granted_scopes},
    state_machine::AuthorityAdmissionWitness,
};

use super::{
    PROVIDER_PERMISSION_EFFECT_FAMILY, PROVIDER_PERMISSION_GRANT_ID_ENV,
    PROVIDER_PERMISSION_GRANTED_SCOPES_ENV, ProviderNativeAccess, decode_provider_scopes_env,
};
use crate::effects::{EffectStepRequest, RuntimeEffectError};

pub(super) fn validate_native_provider_policy(
    request: &EffectStepRequest<'_>,
    policy: &JsonObject,
    access: ProviderNativeAccess,
) -> Result<(), RuntimeEffectError> {
    let verb = required_verb_field(policy)?;
    let valid = match access {
        ProviderNativeAccess::Read => verb == AuthorityVerb::Read,
        ProviderNativeAccess::Mutate => verb != AuthorityVerb::Read,
    };
    if !valid {
        return Err(RuntimeEffectError::Denied {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            verb,
            message: format!(
                "native provider tool {} does not admit the configured provider verb",
                request.step.tool.as_deref().unwrap_or_default()
            ),
        });
    }
    if required_scopes_for(request, policy)?.is_empty() {
        return Err(provider_permission_policy_error(
            "native provider tools require at least one explicit provider scope".to_owned(),
        ));
    }
    Ok(())
}

pub(super) struct ProviderPermissionPlan {
    pub(super) grant_id: String,
    pub(super) required_scopes: Vec<String>,
    pub(super) granted_scopes: Vec<String>,
    pub(super) missing_scopes: Vec<String>,
    pub(super) verb: AuthorityVerb,
}

#[derive(Clone, Copy)]
pub(super) struct ProviderGrantEvidence<'a> {
    pub(super) grant_id: &'a str,
    pub(super) granted_scopes: &'a [String],
}

pub(super) fn provider_permission_plan(
    request: &EffectStepRequest<'_>,
    policy: &JsonObject,
    evidence: Option<ProviderGrantEvidence<'_>>,
) -> Result<Option<ProviderPermissionPlan>, RuntimeEffectError> {
    let verb = required_verb_field(policy)?;
    if policy.contains_key("granted_scopes") {
        return Err(RuntimeEffectError::Denied {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            verb,
            message: "provider_permission.granted_scopes is self-attested by the graph policy; provide granted scopes through the operator grant environment instead".to_owned(),
        });
    }
    let required_scopes = required_scopes_for(request, policy)?;
    if required_scopes.is_empty() {
        return Ok(None);
    }
    let (grant_id, granted_scopes) = match evidence {
        Some(evidence) => (
            evidence.grant_id.to_owned(),
            evidence.granted_scopes.to_vec(),
        ),
        None => (
            provider_grant_id(request.env, &verb)?,
            granted_scopes_from_env(request.env)?,
        ),
    };
    let missing_scopes = missing_granted_scopes(
        &required_scopes,
        &granted_scopes,
        ScopeGrantPolicy::Delegated,
    );
    let expected_grant_id = string_field(policy, "grant_id");
    if let Some(expected) = expected_grant_id
        && expected != grant_id
    {
        return Err(RuntimeEffectError::Denied {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            verb,
            message: format!(
                "step '{}' requires provider grant '{}', but operator grant '{}' was supplied",
                request.step.id, expected, grant_id
            ),
        });
    }

    Ok(Some(ProviderPermissionPlan {
        grant_id,
        required_scopes,
        granted_scopes,
        missing_scopes,
        verb,
    }))
}

pub(super) fn required_scopes_for(
    request: &EffectStepRequest<'_>,
    policy: &JsonObject,
) -> Result<Vec<String>, RuntimeEffectError> {
    let scopes = string_array_field(policy, "required_scopes")?
        .unwrap_or_else(|| request.step.scopes.clone());
    if scopes.iter().any(|scope| scope.trim().is_empty()) {
        return Err(provider_permission_policy_error(
            "provider scopes must be non-blank strings".to_owned(),
        ));
    }
    Ok(scopes)
}

pub(super) fn provider_permission_denial(
    request: &EffectStepRequest<'_>,
    plan: &ProviderPermissionPlan,
) -> RuntimeEffectError {
    RuntimeEffectError::Denied {
        family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
        verb: plan.verb.clone(),
        message: format!(
            "step '{}' requires scopes {}, but grant '{}' only provides {}",
            request.step.id,
            display_scopes(&plan.required_scopes),
            plan.grant_id,
            display_scopes(&plan.granted_scopes)
        ),
    }
}

pub(super) fn provider_permission_witness(
    request: &EffectStepRequest<'_>,
    plan: &ProviderPermissionPlan,
) -> AuthorityAdmissionWitness {
    // The provider input is the executed request and therefore authoritative
    // when a context edge supplied the idempotency key after graph inputs were
    // materialized. Static graph declarations remain the fallback for other
    // provider operations.
    let idempotency_key = request
        .inputs
        .get("idempotency_key")
        .and_then(JsonValue::as_str)
        .map(str::to_owned)
        .or_else(|| request.step.idempotency_key.clone());
    AuthorityAdmissionWitness {
        verb: plan.verb.clone(),
        parent_term_id: format!("provider-permission:{}", plan.grant_id),
        child_term_id: format!(
            "provider-permission:{}:{}",
            request.step.id,
            scope_list_digest(&plan.required_scopes)
        ),
        idempotency_key,
        capability_ref: None,
    }
}

fn scope_list_digest(scopes: &[String]) -> String {
    let mut bytes = Vec::new();
    for scope in scopes {
        bytes.extend_from_slice(&(scope.len() as u64).to_be_bytes());
        bytes.extend_from_slice(scope.as_bytes());
    }
    sha256_prefixed(&bytes)
}

pub(super) fn display_scopes(scopes: &[String]) -> String {
    format!("{scopes:?}")
}

pub(super) fn provider_permission_policy(policy: Option<&JsonObject>) -> Option<&JsonObject> {
    policy?
        .get(PROVIDER_PERMISSION_EFFECT_FAMILY)
        .and_then(JsonValue::as_object)
}

fn string_field<'a>(object: &'a JsonObject, key: &str) -> Option<&'a str> {
    object.get(key).and_then(JsonValue::as_str)
}

fn string_array_field(
    object: &JsonObject,
    key: &str,
) -> Result<Option<Vec<String>>, RuntimeEffectError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    let Some(values) = value.as_array() else {
        return Err(provider_permission_policy_error(format!(
            "{key} must be an array"
        )));
    };
    values
        .iter()
        .enumerate()
        .map(|(index, value)| match value {
            JsonValue::String(scope) if !scope.trim().is_empty() => Ok(scope.clone()),
            JsonValue::String(_) => Err(provider_permission_policy_error(format!(
                "{key}[{index}] must be a non-empty string"
            ))),
            _ => Err(provider_permission_policy_error(format!(
                "{key}[{index}] must be a string"
            ))),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn provider_grant_id(
    env: &BTreeMap<String, String>,
    verb: &AuthorityVerb,
) -> Result<String, RuntimeEffectError> {
    env.get(PROVIDER_PERMISSION_GRANT_ID_ENV)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| RuntimeEffectError::Denied {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            verb: verb.clone(),
            message: format!(
                "provider permission requires explicit operator grant id in {PROVIDER_PERMISSION_GRANT_ID_ENV}"
            ),
        })
}

fn granted_scopes_from_env(
    env: &BTreeMap<String, String>,
) -> Result<Vec<String>, RuntimeEffectError> {
    env.get(PROVIDER_PERMISSION_GRANTED_SCOPES_ENV)
        .map(|value| {
            decode_provider_scopes_env(value)
                .map_err(|error| provider_permission_policy_error(error.to_string()))
        })
        .unwrap_or_else(|| Ok(Vec::new()))
}

pub(super) fn required_verb_field(
    object: &JsonObject,
) -> Result<AuthorityVerb, RuntimeEffectError> {
    let Some(value) = object.get("verb") else {
        return Err(provider_permission_policy_error(
            "verb is required".to_owned(),
        ));
    };
    let Some(verb) = value.as_str() else {
        return Err(provider_permission_policy_error(
            "verb must be a string".to_owned(),
        ));
    };
    match verb {
        "read" => Ok(AuthorityVerb::Read),
        "write" => Ok(AuthorityVerb::Write),
        "comment" => Ok(AuthorityVerb::Comment),
        "review" => Ok(AuthorityVerb::Review),
        "merge" => Ok(AuthorityVerb::Merge),
        "create" => Ok(AuthorityVerb::Create),
        "update" => Ok(AuthorityVerb::Update),
        "delete" => Ok(AuthorityVerb::Delete),
        "execute" => Ok(AuthorityVerb::Execute),
        "revoke" => Ok(AuthorityVerb::Revoke),
        _ => Err(provider_permission_policy_error(format!(
            "verb {verb:?} is not supported"
        ))),
    }
}

pub(super) fn provider_permission_policy_error(message: String) -> RuntimeEffectError {
    RuntimeEffectError::Failed {
        family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
        operation: "parse provider permission policy",
        message,
    }
}

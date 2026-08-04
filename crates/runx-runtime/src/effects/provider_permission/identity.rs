use std::collections::BTreeMap;

use runx_contracts::JsonObject;
#[cfg(feature = "catalog")]
use runx_contracts::JsonValue;

use crate::effects::{EffectStepRequest, RuntimeEffectError};
#[cfg(feature = "catalog")]
use crate::{
    AuthenticatedHostedApiEnvironment, HostedApiEnvironment, HostedProviderGrant,
    hosted_private_network_allowed, list_provider_grants,
};

#[cfg(feature = "catalog")]
use super::PROVIDER_PERMISSION_EFFECT_FAMILY;
#[cfg(not(feature = "catalog"))]
use super::approval::required_provider_input;
use super::policy::{ProviderGrantEvidence, provider_permission_policy_error, required_scopes_for};
#[cfg(feature = "catalog")]
use super::policy::{display_scopes, missing_scopes, required_verb_field};
use super::{
    PROVIDER_PERMISSION_GRANT_ID_ENV, PROVIDER_PERMISSION_GRANTED_SCOPES_ENV,
    PROVIDER_PERMISSION_PRINCIPAL_REF_ENV, ProviderPermissionEffect, decode_provider_scopes_env,
};

pub(super) struct NativeProviderResolution {
    grant_id: String,
    granted_scopes: Vec<String>,
    pub(super) principal_ref: String,
}

impl NativeProviderResolution {
    pub(super) fn grant_evidence(&self) -> ProviderGrantEvidence<'_> {
        ProviderGrantEvidence {
            grant_id: &self.grant_id,
            granted_scopes: &self.granted_scopes,
        }
    }
}

fn explicit_native_provider_resolution(
    env: &BTreeMap<String, String>,
) -> Result<Option<NativeProviderResolution>, RuntimeEffectError> {
    let grant_id = env
        .get(PROVIDER_PERMISSION_GRANT_ID_ENV)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let granted_scopes = env
        .get(PROVIDER_PERMISSION_GRANTED_SCOPES_ENV)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(decode_provider_scopes_env)
        .transpose()
        .map_err(|error| provider_permission_policy_error(error.to_string()))?;
    let principal_ref = env
        .get(PROVIDER_PERMISSION_PRINCIPAL_REF_ENV)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let (Some(grant_id), Some(granted_scopes), Some(principal_ref)) =
        (grant_id, granted_scopes, principal_ref)
    else {
        return Ok(None);
    };
    Ok(Some(NativeProviderResolution {
        grant_id: grant_id.to_owned(),
        granted_scopes,
        principal_ref: principal_ref.to_owned(),
    }))
}

#[cfg(not(feature = "catalog"))]
impl ProviderPermissionEffect {
    pub(super) fn native_provider_resolution(
        &self,
        request: &EffectStepRequest<'_>,
        policy: &JsonObject,
    ) -> Result<NativeProviderResolution, RuntimeEffectError> {
        let _ = required_provider_input(request.inputs, "expected_provider")?;
        let _ = required_scopes_for(request, policy)?;
        explicit_native_provider_resolution(request.env)?.ok_or_else(|| {
            provider_permission_policy_error(format!(
                "native provider tools require explicit {PROVIDER_PERMISSION_GRANT_ID_ENV}, {PROVIDER_PERMISSION_GRANTED_SCOPES_ENV}, and {PROVIDER_PERMISSION_PRINCIPAL_REF_ENV} without the hosted provider feature"
            ))
        })
    }
}

#[cfg(feature = "catalog")]
impl ProviderPermissionEffect {
    pub(super) fn native_provider_resolution(
        &self,
        request: &EffectStepRequest<'_>,
        policy: &JsonObject,
    ) -> Result<NativeProviderResolution, RuntimeEffectError> {
        let provider = required_expected_provider(request)?;
        let required_scopes = required_scopes_for(request, policy)?;
        if let Some(resolved) = explicit_native_provider_resolution(request.env)? {
            return Ok(resolved);
        }
        self.resolve_hosted_provider(request, policy, provider, required_scopes)
    }

    fn resolve_hosted_provider(
        &self,
        request: &EffectStepRequest<'_>,
        policy: &JsonObject,
        provider: &str,
        required_scopes: Vec<String>,
    ) -> Result<NativeProviderResolution, RuntimeEffectError> {
        let explicit_grant = request
            .env
            .get(PROVIDER_PERMISSION_GRANT_ID_ENV)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let transport = self
            .http_transport(hosted_private_network_allowed(false, request.env))
            .map_err(|error| provider_permission_policy_error(error.to_string()))?;
        let resolved = HostedApiEnvironment::resolve(None, None, request.env, request.graph_dir)
            .map_err(|error| provider_permission_policy_error(error.to_string()))?;
        let environment = self
            .authenticated_environment(&resolved, transport.as_ref())
            .map_err(|error| provider_permission_policy_error(error.to_string()))?;
        let principal_ref = format!("runx:principal:{}", environment.principal_id());
        let grants = self
            .hosted_grants(&resolved, &environment, transport.as_ref())
            .map_err(|error| provider_permission_policy_error(error.to_string()))?;
        let verb = required_verb_field(policy)?;
        let grant = select_hosted_provider_grant(
            &grants,
            provider,
            &required_scopes,
            explicit_grant.as_deref(),
        )
        .map_err(|message| RuntimeEffectError::Denied {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            verb,
            message,
        })?;
        Ok(NativeProviderResolution {
            grant_id: grant.grant_id.clone(),
            granted_scopes: grant.scopes.clone(),
            principal_ref,
        })
    }

    fn hosted_grants<T: crate::http::RuntimeHttpTransport + ?Sized>(
        &self,
        resolved: &HostedApiEnvironment,
        environment: &AuthenticatedHostedApiEnvironment,
        transport: &T,
    ) -> Result<Vec<HostedProviderGrant>, crate::ProviderOperationError> {
        let mut cached = self
            .hosted_grants
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((cached_environment, grants)) = cached.as_ref()
            && cached_environment == resolved
        {
            return Ok(grants.clone());
        }
        let grants = list_provider_grants(transport, environment)?;
        *cached = Some((resolved.clone(), grants.clone()));
        Ok(grants)
    }

    pub(super) fn authenticated_environment<T: crate::http::RuntimeHttpTransport + ?Sized>(
        &self,
        resolved: &HostedApiEnvironment,
        transport: &T,
    ) -> Result<AuthenticatedHostedApiEnvironment, crate::HostedApiError> {
        let mut cached = self
            .authenticated_environment
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((cached_environment, authenticated)) = cached.as_ref()
            && cached_environment == resolved
        {
            return Ok(authenticated.clone());
        }
        let authenticated = resolved.authenticate(transport)?;
        *cached = Some((resolved.clone(), authenticated.clone()));
        Ok(authenticated)
    }
}

#[cfg(feature = "catalog")]
fn required_expected_provider<'a>(
    request: &EffectStepRequest<'a>,
) -> Result<&'a str, RuntimeEffectError> {
    request
        .inputs
        .get("expected_provider")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            provider_permission_policy_error(
                "native provider tools require expected_provider".to_owned(),
            )
        })
}

#[cfg(feature = "catalog")]
pub(super) fn select_hosted_provider_grant<'a>(
    grants: &'a [HostedProviderGrant],
    provider: &str,
    required_scopes: &[String],
    explicit_grant: Option<&str>,
) -> Result<&'a HostedProviderGrant, String> {
    let mut candidates = grants
        .iter()
        .filter(|grant| grant.status == "active")
        .filter(|grant| grant.provider == provider)
        .filter(|grant| explicit_grant.is_none_or(|expected| grant.grant_id == expected))
        .filter(|grant| missing_scopes(required_scopes, &grant.scopes).is_empty())
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.grant_id.cmp(&right.grant_id));
    match candidates.as_slice() {
        [grant] => Ok(*grant),
        [] if explicit_grant.is_some() => Err(format!(
            "configured provider grant does not authorize {provider} scopes {}",
            display_scopes(required_scopes)
        )),
        [] => Err(format!(
            "no active Runx Connect grant authorizes {provider} scopes {}",
            display_scopes(required_scopes)
        )),
        _ => Err(format!(
            "multiple active Runx Connect grants authorize {provider} scopes {}; select one with {PROVIDER_PERMISSION_GRANT_ID_ENV}",
            display_scopes(required_scopes)
        )),
    }
}

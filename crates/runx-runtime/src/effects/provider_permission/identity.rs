use std::collections::BTreeMap;

use runx_contracts::JsonObject;
#[cfg(feature = "catalog")]
use runx_contracts::{AuthorityVerb, JsonValue, PrincipalReference};
#[cfg(any(feature = "catalog", test))]
use runx_core::policy::{ScopeGrantPolicy, missing_granted_scopes};

use crate::effects::{EffectStepRequest, RuntimeEffectError};
#[cfg(feature = "catalog")]
use crate::{
    AuthenticatedHostedApiEnvironment, HostedApiEnvironment, HostedProviderGrant,
    hosted_private_network_allowed, list_provider_grants,
};

#[cfg(feature = "catalog")]
use super::PROVIDER_PERMISSION_EFFECT_FAMILY;
#[cfg(feature = "catalog")]
use super::ProviderNativeAccess;
#[cfg(not(feature = "catalog"))]
use super::approval::required_provider_input;
#[cfg(any(feature = "catalog", test))]
use super::policy::display_scopes;
#[cfg(feature = "catalog")]
use super::policy::required_verb_field;
use super::policy::{ProviderGrantEvidence, provider_permission_policy_error, required_scopes_for};
use super::{
    PROVIDER_PERMISSION_GRANT_ID_ENV, PROVIDER_PERMISSION_GRANTED_SCOPES_ENV,
    PROVIDER_PERMISSION_PRINCIPAL_REF_ENV, ProviderPermissionEffect, decode_provider_scopes_env,
};

#[cfg(feature = "catalog")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ProviderTransportSelection {
    Hosted,
    LocalGithub(super::local_github::LocalGithubBinding),
}

pub(super) struct NativeProviderResolution {
    grant_id: String,
    granted_scopes: Vec<String>,
    pub(super) principal_ref: String,
    #[cfg(feature = "catalog")]
    pub(super) target: String,
    #[cfg(feature = "catalog")]
    pub(super) transport: ProviderTransportSelection,
}

#[cfg(feature = "catalog")]
pub(super) fn hosted_principal_reference(
    environment: &AuthenticatedHostedApiEnvironment,
) -> String {
    PrincipalReference::from_runx_principal_id(environment.runx_principal_id().clone())
        .as_reference()
        .uri
        .as_str()
        .to_owned()
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
        #[cfg(feature = "catalog")]
        target: String::new(),
        #[cfg(feature = "catalog")]
        transport: ProviderTransportSelection::Hosted,
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
        let operation = super::approval::required_provider_input(request.inputs, "operation")?;
        let access = super::native_provider_access(request.target.tool_ref).ok_or_else(|| {
            provider_permission_policy_error("provider transport requires native access".to_owned())
        })?;
        let required_scopes = required_scopes_for(request, policy)?;
        let target = resolved_provider_target(request, provider)?;
        let requested =
            super::resolve_provider_transport_preference(request.env, request.graph_dir, provider)
                .map_err(provider_permission_policy_error)?;
        if let Some(mut resolved) = explicit_native_provider_resolution(request.env)? {
            let conflict = match &requested {
                super::ProviderTransportPreference::LocalGithub => Some(format!(
                    "host-injected provider authority ({PROVIDER_PERMISSION_GRANT_ID_ENV}, {PROVIDER_PERMISSION_GRANTED_SCOPES_ENV}, and {PROVIDER_PERMISSION_PRINCIPAL_REF_ENV}) selects hosted transport and conflicts with explicit local:github transport; unset the hosted grant triplet or change the transport binding to hosted"
                )),
                super::ProviderTransportPreference::Hosted(Some(bound_grant))
                    if bound_grant != &resolved.grant_id =>
                {
                    Some(format!(
                        "host-injected provider grant does not match the explicit hosted:{bound_grant} transport binding; update the binding or inject the matching grant"
                    ))
                }
                _ => None,
            };
            if let Some(message) = conflict {
                return Err(RuntimeEffectError::Denied {
                    family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
                    verb: required_verb_field(policy)?,
                    message,
                });
            }
            resolved.target = target.value.ok_or_else(|| {
                provider_permission_policy_error(
                    "target_from_grant requires hosted grant discovery; host-injected grant authority must supply an explicit target"
                        .to_owned(),
                )
            })?;
            return Ok(resolved);
        }
        if requested == super::ProviderTransportPreference::LocalGithub {
            return self.resolve_local_github(
                request,
                operation,
                access,
                target.local_github.ok_or_else(|| {
                    provider_permission_policy_error(
                        "local GitHub transport requires a GitHub target".to_owned(),
                    )
                })?,
                required_scopes,
            );
        }
        if let super::ProviderTransportPreference::Hosted(explicit_grant) = requested {
            return self.resolve_hosted_provider(
                request,
                policy,
                provider,
                target,
                required_scopes,
                explicit_grant.as_deref(),
            );
        }
        let local_error = if provider == "github" {
            match self.resolve_local_github(
                request,
                operation,
                access,
                target.local_github.clone().ok_or_else(|| {
                    provider_permission_policy_error(
                        "local GitHub transport requires a GitHub target".to_owned(),
                    )
                })?,
                required_scopes.clone(),
            ) {
                Ok(resolution) => return Ok(resolution),
                Err(error) => Some(error.to_string()),
            }
        } else {
            None
        };
        self.resolve_hosted_provider(
            request,
            policy,
            provider,
            target,
            required_scopes,
            None,
        )
        .map_err(|error| match local_error {
            Some(local) => RuntimeEffectError::Denied {
                family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
                verb: required_verb_field(policy).unwrap_or(runx_contracts::AuthorityVerb::Read),
                message: format!(
                    "local GitHub transport was unavailable ({local}); hosted fallback was unavailable ({error})"
                ),
            },
            None => error,
        })
    }

    fn resolve_hosted_provider(
        &self,
        request: &EffectStepRequest<'_>,
        policy: &JsonObject,
        provider: &str,
        target: ResolvedProviderTarget,
        required_scopes: Vec<String>,
        bound_grant: Option<&str>,
    ) -> Result<NativeProviderResolution, RuntimeEffectError> {
        let explicit_grant = bound_grant.map(str::to_owned).or_else(|| {
            request
                .env
                .get(PROVIDER_PERMISSION_GRANT_ID_ENV)
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        });
        let verb = required_verb_field(policy)?;
        let transport = self
            .http_transport(hosted_private_network_allowed(false, request.env))
            .map_err(|error| hosted_provider_preflight_denied(verb.clone(), error))?;
        let resolved = HostedApiEnvironment::resolve(None, None, request.env, request.graph_dir)
            .map_err(|error| hosted_provider_preflight_denied(verb.clone(), error))?;
        let environment = self
            .authenticated_environment(&resolved, transport.as_ref())
            .map_err(|error| hosted_provider_preflight_denied(verb.clone(), error))?;
        let principal_ref = hosted_principal_reference(&environment);
        let grants = self
            .hosted_grants(&resolved, &environment, transport.as_ref())
            .map_err(|error| hosted_provider_preflight_denied(verb.clone(), error))?;
        let grant = select_hosted_provider_grant(
            &grants,
            provider,
            &required_scopes,
            target.value.as_deref(),
            explicit_grant.as_deref(),
        )
        .map_err(|message| RuntimeEffectError::Denied {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            verb: verb.clone(),
            message,
        })?;
        let target = target
            .value
            .or_else(|| grant.target_locator.clone())
            .ok_or_else(|| RuntimeEffectError::Denied {
                family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
                verb,
                message: format!(
                    "provider grant '{}' has no target_locator for target_from_grant",
                    grant.grant_id
                ),
            })?;
        Ok(NativeProviderResolution {
            grant_id: grant.grant_id.clone(),
            granted_scopes: grant.scopes.clone(),
            principal_ref,
            target,
            transport: ProviderTransportSelection::Hosted,
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

    fn resolve_local_github(
        &self,
        request: &EffectStepRequest<'_>,
        operation: &str,
        access: ProviderNativeAccess,
        target: super::local_github::ResolvedGithubTarget,
        required_scopes: Vec<String>,
    ) -> Result<NativeProviderResolution, RuntimeEffectError> {
        let key = (target.host.clone(), target.repository.to_ascii_lowercase());
        let cached = self
            .local_github_bindings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&key)
            .cloned();
        let binding = match cached {
            Some(binding) => super::local_github::validate_cached_binding(
                binding,
                operation,
                access,
                &required_scopes,
            ),
            None => super::local_github::preflight_resolved(
                request.env,
                request.graph_dir,
                operation,
                access,
                target,
                &required_scopes,
            ),
        }
        .map_err(|error| RuntimeEffectError::Denied {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            verb: match access {
                ProviderNativeAccess::Read => runx_contracts::AuthorityVerb::Read,
                ProviderNativeAccess::Mutate => runx_contracts::AuthorityVerb::Write,
            },
            message: error.to_string(),
        })?;
        self.local_github_bindings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key, binding.clone());
        Ok(NativeProviderResolution {
            grant_id: binding.grant_id(),
            granted_scopes: required_scopes,
            principal_ref: binding.principal_ref(),
            target: binding.repository.clone(),
            transport: ProviderTransportSelection::LocalGithub(binding),
        })
    }
}

#[cfg(feature = "catalog")]
fn hosted_provider_preflight_denied(
    verb: AuthorityVerb,
    error: impl std::fmt::Display,
) -> RuntimeEffectError {
    RuntimeEffectError::Denied {
        family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
        verb,
        message: format!("hosted provider preflight failed: {error}"),
    }
}

#[cfg(feature = "catalog")]
#[derive(Clone, Debug)]
struct ResolvedProviderTarget {
    value: Option<String>,
    local_github: Option<super::local_github::ResolvedGithubTarget>,
}

#[cfg(feature = "catalog")]
fn resolved_provider_target(
    request: &EffectStepRequest<'_>,
    provider: &str,
) -> Result<ResolvedProviderTarget, RuntimeEffectError> {
    let target = request
        .inputs
        .get("target")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let target_from_grant = request
        .inputs
        .get("target_from_grant")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    if target.is_some() == target_from_grant {
        return Err(provider_permission_policy_error(
            "native provider operations require exactly one of target or target_from_grant"
                .to_owned(),
        ));
    }
    if target_from_grant {
        if provider == "github" {
            return Err(provider_permission_policy_error(
                "target_from_grant is not supported for github targets; supply an explicit target"
                    .to_owned(),
            ));
        }
        return Ok(ResolvedProviderTarget {
            value: None,
            local_github: None,
        });
    }
    let target = target.ok_or_else(|| {
        provider_permission_policy_error("native provider target is required".to_owned())
    })?;
    if provider != "github" {
        return Ok(ResolvedProviderTarget {
            value: Some(target.to_owned()),
            local_github: None,
        });
    }
    super::local_github::resolve_target(request.env, request.graph_dir, target)
        .map(|target| ResolvedProviderTarget {
            value: Some(target.repository.clone()),
            local_github: Some(target),
        })
        .map_err(|error| provider_permission_policy_error(error.to_string()))
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
    target: Option<&str>,
    explicit_grant: Option<&str>,
) -> Result<&'a HostedProviderGrant, String> {
    let views = grants
        .iter()
        .map(|grant| HostedGrantView {
            grant_id: &grant.grant_id,
            provider: &grant.provider,
            scopes: &grant.scopes,
            status: &grant.status,
            target_locator: grant.target_locator.as_deref(),
        })
        .collect::<Vec<_>>();
    select_hosted_provider_grant_index(&views, provider, required_scopes, target, explicit_grant)
        .map(|index| &grants[index])
}

#[cfg(any(feature = "catalog", test))]
#[derive(Clone, Copy)]
pub(super) struct HostedGrantView<'a> {
    pub(super) grant_id: &'a str,
    pub(super) provider: &'a str,
    pub(super) scopes: &'a [String],
    pub(super) status: &'a str,
    pub(super) target_locator: Option<&'a str>,
}

#[cfg(any(feature = "catalog", test))]
pub(super) fn select_hosted_provider_grant_index(
    grants: &[HostedGrantView<'_>],
    provider: &str,
    required_scopes: &[String],
    target: Option<&str>,
    explicit_grant: Option<&str>,
) -> Result<usize, String> {
    let mut candidates = grants
        .iter()
        .enumerate()
        .filter(|(_, grant)| grant.status == "active")
        .filter(|(_, grant)| grant.provider == provider)
        .filter(|(_, grant)| explicit_grant.is_none_or(|expected| grant.grant_id == expected))
        .filter(|(_, grant)| {
            target.is_none_or(|expected| {
                grant
                    .target_locator
                    .is_none_or(|locator| locator == expected)
            })
        })
        .filter(|(_, grant)| {
            missing_granted_scopes(required_scopes, grant.scopes, ScopeGrantPolicy::Delegated)
                .is_empty()
        })
        .collect::<Vec<_>>();
    if explicit_grant.is_none() && target.is_some() {
        let has_exact_target = candidates
            .iter()
            .any(|(_, grant)| grant.target_locator == target);
        if has_exact_target {
            candidates.retain(|(_, grant)| grant.target_locator == target);
        }
    }
    candidates.sort_by(|(_, left), (_, right)| left.grant_id.cmp(right.grant_id));
    match candidates.as_slice() {
        [(index, _)] => Ok(*index),
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

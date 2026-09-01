#[cfg(feature = "catalog")]
use std::sync::{Arc, Mutex};

#[cfg(feature = "catalog")]
use runx_contracts::JsonValue;
use runx_contracts::{Reference, ReferenceType};

#[cfg(feature = "catalog")]
use super::EffectToolRequest;
use super::{
    EffectAdmission, EffectOutputRequest, EffectPreparationOutcome, EffectReceiptRequest,
    EffectStepRequest, ProviderEffectResolved, RuntimeEffect, RuntimeEffectError,
};
use crate::CapabilityContract;
#[cfg(feature = "catalog")]
use crate::{
    AuthenticatedHostedApiEnvironment, HostedApiEnvironment, HostedProviderGrant, RuntimeError,
    RuntimeHttpError, RuntimeHttpTransport,
};

mod approval;
mod contract;
#[cfg(feature = "catalog")]
mod execution;
mod identity;
#[cfg(any(feature = "catalog", test))]
mod local_github;
mod policy;
#[cfg(feature = "catalog")]
mod readback;
mod recovery;
mod scope_transport;

pub use scope_transport::{
    ProviderScopeTransportError, decode_provider_scopes_env, encode_provider_scopes_env,
};

use approval::{
    prepare_provider_effect_output, prepare_provider_execution, resolved_provider_effect,
};
use policy::{
    provider_permission_denial, provider_permission_plan, provider_permission_policy,
    provider_permission_policy_error, provider_permission_witness, validate_native_provider_policy,
};

pub const PROVIDER_PERMISSION_EFFECT_FAMILY: &str = "provider_permission";
pub const PROVIDER_READ_TOOL: &str = "provider.read";
pub const PROVIDER_MUTATE_TOOL: &str = "provider.mutate";
/// Host-injected provider grant identity. Together with granted scopes and the
/// principal reference, this selects hosted execution. A complete triplet
/// cannot coexist with an explicit local transport binding.
pub const PROVIDER_PERMISSION_GRANT_ID_ENV: &str = "RUNX_PROVIDER_PERMISSION_GRANT_ID";
pub const PROVIDER_PERMISSION_GRANTED_SCOPES_ENV: &str = "RUNX_PROVIDER_PERMISSION_GRANTED_SCOPES";
pub const PROVIDER_PERMISSION_PRINCIPAL_REF_ENV: &str = "RUNX_PROVIDER_PERMISSION_PRINCIPAL_REF";
/// Runtime-hosted authority for a provider mutation performed as one exact
/// stage of an admitted paid external job. Skill code cannot author this
/// value; hosted composition injects the validated current-V1 stage request.
pub const PROVIDER_PERMISSION_PAID_EXTERNAL_JOB_AUTHORITY_ENV: &str =
    "RUNX_PROVIDER_PERMISSION_PAID_EXTERNAL_JOB_AUTHORITY_JSON";
/// Explicit provider transport preference. The environment overrides the
/// project binding; either source conflicts fail closed when a complete
/// host-injected hosted-grant triplet requests a different transport.
pub const PROVIDER_PERMISSION_TRANSPORT_ENV: &str = "RUNX_PROVIDER_PERMISSION_TRANSPORT";

#[cfg(feature = "catalog")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalProviderTransportReadiness {
    pub transport: &'static str,
    pub host: String,
    pub target: String,
    pub principal_ref: String,
    pub grant_ref: String,
}

#[cfg(feature = "catalog")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderTransportPreference {
    Auto,
    LocalGithub,
    Hosted(Option<String>),
}

#[cfg(feature = "catalog")]
pub fn resolve_provider_transport_preference(
    env: &std::collections::BTreeMap<String, String>,
    cwd: &std::path::Path,
    provider: &str,
) -> Result<ProviderTransportPreference, String> {
    let workspace = crate::config::resolve_runx_workspace_base(env, cwd);
    let project_binding = crate::load_project_bindings(&workspace)
        .map_err(|error| error.to_string())?
        .bindings
        .get(&format!("provider-transport:{provider}"))
        .cloned();
    let value = env
        .get(PROVIDER_PERMISSION_TRANSPORT_ENV)
        .map(String::as_str)
        .or(project_binding.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match value {
        None | Some("auto") => Ok(ProviderTransportPreference::Auto),
        Some("local") | Some("local:github") if provider == "github" => {
            Ok(ProviderTransportPreference::LocalGithub)
        }
        Some("hosted") | Some("runx-connect") => Ok(ProviderTransportPreference::Hosted(None)),
        Some(value) if value.starts_with("hosted:") => {
            let grant = value.trim_start_matches("hosted:").trim();
            if !crate::path_util::is_safe_url_path_identifier(grant) {
                return Err(
                    "hosted provider transport binding requires a valid grant id".to_owned(),
                );
            }
            Ok(ProviderTransportPreference::Hosted(Some(grant.to_owned())))
        }
        Some(value) => Err(format!(
            "unsupported provider transport binding {value:?}; use auto, local:github, hosted, or hosted:<grant-id>"
        )),
    }
}

#[cfg(feature = "catalog")]
pub fn preflight_local_provider_transport(
    env: &std::collections::BTreeMap<String, String>,
    cwd: &std::path::Path,
    provider: &str,
    operation: &str,
    access: &str,
    target: &str,
    scopes: &[String],
) -> Result<Option<LocalProviderTransportReadiness>, String> {
    if provider != "github" {
        return Ok(None);
    }
    let access = match access {
        "read" => ProviderNativeAccess::Read,
        "mutate" => ProviderNativeAccess::Mutate,
        value => return Err(format!("unsupported provider access {value:?}")),
    };
    let binding = local_github::preflight(env, cwd, operation, access, target, scopes)
        .map_err(|error| error.to_string())?;
    Ok(Some(LocalProviderTransportReadiness {
        transport: "local_github",
        host: binding.host.clone(),
        target: binding.repository.clone(),
        principal_ref: binding.principal_ref(),
        grant_ref: format!("runx:grant:{}", binding.grant_id()),
    }))
}

#[derive(Default)]
pub struct ProviderPermissionEffect {
    #[cfg(feature = "catalog")]
    http_transport: Option<Arc<dyn RuntimeHttpTransport + Send + Sync>>,
    #[cfg(feature = "catalog")]
    authenticated_environment:
        Mutex<Option<(HostedApiEnvironment, AuthenticatedHostedApiEnvironment)>>,
    #[cfg(feature = "catalog")]
    hosted_grants: Mutex<Option<(HostedApiEnvironment, Vec<HostedProviderGrant>)>>,
    #[cfg(feature = "catalog")]
    local_github_bindings:
        Mutex<std::collections::BTreeMap<(String, String), local_github::LocalGithubBinding>>,
}

impl std::fmt::Debug for ProviderPermissionEffect {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        #[cfg(feature = "catalog")]
        let transport = if self.http_transport.is_some() {
            "injected"
        } else {
            "runtime-owned"
        };
        #[cfg(not(feature = "catalog"))]
        let transport = "unavailable";
        formatter
            .debug_struct("ProviderPermissionEffect")
            .field("http_transport", &transport)
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "catalog")]
impl ProviderPermissionEffect {
    /// Inject the transport beneath the production hosted-provider client.
    /// The provider request, authentication, response validation, effect
    /// transitions, and receipt path remain unchanged; this seam exists for
    /// deterministic embedding and production-path verification without live
    /// provider traffic.
    pub fn with_http_transport<T>(transport: T) -> Self
    where
        T: RuntimeHttpTransport + Send + Sync + 'static,
    {
        Self {
            http_transport: Some(Arc::new(transport)),
            ..Self::default()
        }
    }

    fn http_transport(
        &self,
        allow_private_network: bool,
    ) -> Result<Arc<dyn RuntimeHttpTransport + Send + Sync>, RuntimeHttpError> {
        self.http_transport.clone().map_or_else(
            || {
                crate::hosted_provider_api_transport(allow_private_network)
                    .map(|transport| Arc::new(transport) as Arc<_>)
            },
            Ok,
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderPermissionAdmission {
    pub grant_id: String,
    pub required_scopes: Vec<String>,
    pub granted_scopes: Vec<String>,
    #[cfg(feature = "catalog")]
    transport: identity::ProviderTransportSelection,
    provider_effect: Option<ProviderEffectResolved>,
    approval_request: Option<contract::ProviderApprovalRequest>,
    mutation_authority: Option<approval::PaidExternalJobMutationAuthority>,
    attempt: Option<super::ProviderEffectAttempt>,
    recovery: Option<recovery::ProviderRecoveryContext>,
}

impl RuntimeEffect for ProviderPermissionEffect {
    fn family(&self) -> &'static str {
        PROVIDER_PERMISSION_EFFECT_FAMILY
    }

    fn execution_boundary(&self) -> runx_contracts::ExecutionBoundaryKind {
        runx_contracts::ExecutionBoundaryKind::RemoteProvider
    }

    fn matches_target(&self, request: EffectStepRequest<'_>) -> bool {
        native_provider_access(request.target.tool_ref).is_some()
            || provider_permission_policy(request.step.policy.as_ref()).is_some()
    }

    fn capabilities(&self) -> &'static [&'static dyn CapabilityContract] {
        contract::PROVIDER_CAPABILITIES
    }

    fn admit(
        &self,
        request: EffectStepRequest<'_>,
    ) -> Result<Option<EffectAdmission>, RuntimeEffectError> {
        let native_access = native_provider_access(request.target.tool_ref);
        let Some(policy) = provider_permission_policy(request.step.policy.as_ref()) else {
            if native_access.is_some() {
                return Err(provider_permission_policy_error(
                    "native provider tools require an explicit provider_permission policy"
                        .to_owned(),
                ));
            }
            return Ok(None);
        };
        if let Some(access) = native_access {
            validate_native_provider_policy(&request, policy, access)?;
        }
        let resolved_provider = native_access
            .map(|_| self.native_provider_resolution(&request, policy))
            .transpose()?;
        let evidence = resolved_provider
            .as_ref()
            .map(identity::NativeProviderResolution::grant_evidence);
        let plan = provider_permission_plan(&request, policy, evidence)?;
        let Some(plan) = plan else {
            if native_access.is_some() {
                return Err(provider_permission_policy_error(
                    "native provider tools require at least one explicit provider scope".to_owned(),
                ));
            }
            return Ok(None);
        };
        if !plan.missing_scopes.is_empty() {
            return Err(provider_permission_denial(&request, &plan));
        }
        build_provider_admission(&request, plan, native_access, resolved_provider.as_ref())
            .map(Some)
    }

    fn recover_pending(&self, request: EffectStepRequest<'_>) -> Result<(), RuntimeEffectError> {
        recovery::recover_pending_provider_effect(request)
    }

    fn prepare_execution(
        &self,
        step: &runx_parser::GraphStep,
        admission: EffectAdmission,
        host: &mut dyn crate::Host,
    ) -> Result<EffectPreparationOutcome, RuntimeEffectError> {
        prepare_provider_execution(step, admission, host)
    }

    fn prepare_output(&self, request: EffectOutputRequest<'_>) -> Result<(), RuntimeEffectError> {
        prepare_provider_effect_output(request)
    }

    fn persist(&self, request: EffectReceiptRequest<'_>) -> Result<(), RuntimeEffectError> {
        recovery::persist_provider_finality(request)
    }

    fn authority_grant_refs(
        &self,
        admission: &EffectAdmission,
    ) -> Result<Vec<Reference>, RuntimeEffectError> {
        let context = admission
            .context::<ProviderPermissionAdmission>()
            .ok_or_else(|| RuntimeEffectError::Failed {
                family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
                operation: "authority grant evidence",
                message: "provider permission admission context is missing".to_owned(),
            })?;
        Ok(vec![Reference::runx(
            ReferenceType::Grant,
            &context.grant_id,
        )])
    }

    fn authority_scope_refs(
        &self,
        admission: &EffectAdmission,
    ) -> Result<Vec<Reference>, RuntimeEffectError> {
        let context = admission
            .context::<ProviderPermissionAdmission>()
            .ok_or_else(|| RuntimeEffectError::Failed {
                family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
                operation: "authority scope evidence",
                message: "provider permission admission context is missing".to_owned(),
            })?;
        Ok(context
            .required_scopes
            .iter()
            .map(|scope| {
                Reference::with_uri(
                    ReferenceType::ScopeAdmission,
                    format!("runx:scope_admission:{scope}"),
                )
            })
            .collect())
    }

    #[cfg(feature = "catalog")]
    fn invoke_tool(
        &self,
        request: EffectToolRequest<'_>,
    ) -> Option<Result<JsonValue, RuntimeError>> {
        let access = native_provider_access(Some(request.tool_ref))?;
        Some(execution::invoke_provider_tool(self, request, access))
    }

    #[cfg(feature = "catalog")]
    fn partition_tool_output(
        &self,
        request: EffectToolRequest<'_>,
        output: JsonValue,
    ) -> Result<super::EffectToolOutput, RuntimeError> {
        readback::partition_provider_tool_output(request, output)
    }
}

fn build_provider_admission(
    request: &EffectStepRequest<'_>,
    plan: policy::ProviderPermissionPlan,
    native_access: Option<ProviderNativeAccess>,
    resolution: Option<&identity::NativeProviderResolution>,
) -> Result<EffectAdmission, RuntimeEffectError> {
    let witness = provider_permission_witness(request, &plan);
    let approval_request = contract::approval_request(request.inputs).map_err(|message| {
        RuntimeEffectError::InvalidMetadata {
            family: PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            message,
        }
    })?;
    let provider_effect = native_access
        .zip(resolution)
        .map(|(access, resolved)| {
            #[cfg(feature = "catalog")]
            let resolved_target = Some(resolved.target.as_str());
            #[cfg(not(feature = "catalog"))]
            let resolved_target = None;
            resolved_provider_effect(
                request,
                &plan,
                access,
                &resolved.principal_ref,
                resolved_target,
                approval_request.as_ref(),
            )
        })
        .transpose()?;
    let recovery = recovery::provider_recovery_context(request, provider_effect.as_ref())?;
    let mutation_authority = approval::paid_external_job_mutation_authority(
        request,
        resolution.map(|resolved| resolved.principal_ref.as_str()),
    )?;
    Ok(EffectAdmission::new(
        PROVIDER_PERMISSION_EFFECT_FAMILY,
        plan.verb.clone(),
        witness,
        ProviderPermissionAdmission {
            grant_id: plan.grant_id,
            required_scopes: plan.required_scopes,
            granted_scopes: plan.granted_scopes,
            #[cfg(feature = "catalog")]
            transport: resolution
                .map(|resolution| resolution.transport.clone())
                .unwrap_or(identity::ProviderTransportSelection::Hosted),
            provider_effect,
            approval_request,
            mutation_authority,
            attempt: None,
            recovery,
        },
    ))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProviderNativeAccess {
    Read,
    Mutate,
}

fn native_provider_access(tool_ref: Option<&str>) -> Option<ProviderNativeAccess> {
    match tool_ref {
        Some(PROVIDER_READ_TOOL) => Some(ProviderNativeAccess::Read),
        Some(PROVIDER_MUTATE_TOOL) => Some(ProviderNativeAccess::Mutate),
        _ => None,
    }
}

#[cfg(test)]
mod tests;

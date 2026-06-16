// rust-style-allow: large-file - credential delivery is one secret-handling trust surface; secret
// string/env types, redaction, material resolution, and the delivery boundary stay colocated so the
// "secrets never leak" review happens against the whole module at once.
use std::collections::BTreeMap;
use std::fmt;

use runx_contracts::{
    CredentialDeliveryMode, CredentialDeliveryObservation, CredentialDeliveryObservationStatus,
    CredentialDeliveryPurpose, CredentialEnvelopeKind, ProofKind, Reference, ReferenceType,
    sha256_hex, sha256_prefixed,
};
use runx_core::policy::{CredentialBindingDecision, CredentialEnvelope};
use serde::Deserialize;
use thiserror::Error;

const REDACTED_CREDENTIAL: &str = "[redacted-credential]";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialDeliveryProfile {
    provider: String,
    auth_mode: String,
    env_bindings: Vec<CredentialEnvBinding>,
}

impl CredentialDeliveryProfile {
    pub fn env_token(
        provider: impl Into<String>,
        auth_mode: impl Into<String>,
        env_var: impl Into<String>,
    ) -> Result<Self, CredentialDeliveryError> {
        let env_var = env_var.into();
        validate_env_name(&env_var)?;
        Ok(Self {
            provider: provider.into(),
            auth_mode: auth_mode.into(),
            env_bindings: vec![CredentialEnvBinding {
                role: CredentialMaterialRole::ApiKey,
                env_var,
                required: true,
            }],
        })
    }

    #[must_use]
    pub fn provider(&self) -> &str {
        &self.provider
    }

    #[must_use]
    pub fn auth_mode(&self) -> &str {
        &self.auth_mode
    }

    pub fn from_contract_profile(
        profile: &runx_contracts::CredentialDeliveryProfile,
    ) -> Result<Self, CredentialDeliveryError> {
        if profile.delivery_mode != runx_contracts::CredentialDeliveryMode::ProcessEnv {
            return Err(CredentialDeliveryError::UnsupportedDeliveryMode {
                mode: format!("{:?}", profile.delivery_mode),
            });
        }
        let mut env_bindings = Vec::with_capacity(profile.env_bindings.len());
        for binding in &profile.env_bindings {
            let role = CredentialMaterialRole::from_contract_role(binding.role.clone());
            validate_env_name(&binding.env_var)?;
            env_bindings.push(CredentialEnvBinding {
                role,
                env_var: binding.env_var.clone(),
                required: binding.required,
            });
        }
        Ok(Self {
            provider: profile.provider.to_string(),
            auth_mode: profile.auth_mode.to_string(),
            env_bindings,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CredentialEnvBinding {
    role: CredentialMaterialRole,
    env_var: String,
    required: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum CredentialMaterialRole {
    PersonalToken,
    ApiKey,
    ClientSecret,
    SessionToken,
}

impl CredentialMaterialRole {
    const fn label(self) -> &'static str {
        match self {
            Self::PersonalToken => "personal_token",
            Self::ApiKey => "api_key",
            Self::ClientSecret => "client_secret",
            Self::SessionToken => "session_token",
        }
    }

    fn from_contract_role(role: runx_contracts::CredentialMaterialRole) -> Self {
        match role {
            runx_contracts::CredentialMaterialRole::PersonalToken => Self::PersonalToken,
            runx_contracts::CredentialMaterialRole::ApiKey => Self::ApiKey,
            runx_contracts::CredentialMaterialRole::ClientSecret => Self::ClientSecret,
            runx_contracts::CredentialMaterialRole::SessionToken => Self::SessionToken,
        }
    }
}

pub trait MaterialResolver {
    fn resolve_material(
        &self,
        material_ref: &str,
    ) -> Result<ResolvedCredentialMaterial, CredentialDeliveryError>;
}

pub struct CredentialResolutionRequest<'a> {
    pub decision: &'a CredentialBindingDecision,
    pub credential: &'a CredentialEnvelope,
    pub profile: &'a CredentialDeliveryProfile,
    /// The non-secret observation recording this delivery. Required so a resolved
    /// secret can never be delivered without its audit record on the receipt.
    pub observation: CredentialDeliveryObservation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialResolution {
    delivery: CredentialDelivery,
}

impl CredentialResolution {
    #[must_use]
    pub fn into_delivery(self) -> CredentialDelivery {
        self.delivery
    }
}

pub trait CredentialSupervisor {
    fn resolve(
        &self,
        request: CredentialResolutionRequest<'_>,
    ) -> Result<CredentialResolution, CredentialDeliveryError>;
}

pub struct MaterialCredentialSupervisor<'a, R> {
    resolver: &'a R,
}

impl<'a, R> MaterialCredentialSupervisor<'a, R>
where
    R: MaterialResolver,
{
    #[must_use]
    pub const fn new(resolver: &'a R) -> Self {
        Self { resolver }
    }
}

impl<R> CredentialSupervisor for MaterialCredentialSupervisor<'_, R>
where
    R: MaterialResolver,
{
    fn resolve(
        &self,
        request: CredentialResolutionRequest<'_>,
    ) -> Result<CredentialResolution, CredentialDeliveryError> {
        require_allowed_binding(request.decision)?;
        if request.credential.provider != request.profile.provider {
            return Err(CredentialDeliveryError::ProviderMismatch {
                credential_provider: request.credential.provider.to_string(),
                profile_provider: request.profile.provider.clone(),
            });
        }
        let material = self
            .resolver
            .resolve_material(&request.credential.material_ref)?;
        if material.material_ref != request.credential.material_ref {
            return Err(CredentialDeliveryError::MaterialRefMismatch {
                expected_hash: hash_material_ref(&request.credential.material_ref),
                actual_hash: hash_material_ref(&material.material_ref),
            });
        }
        Ok(CredentialResolution {
            delivery: CredentialDelivery {
                secret_env: apply_profile(request.profile, &material)?,
                public_observation: Some(request.observation),
            },
        })
    }
}

#[derive(Clone, Debug, Default)]
pub struct InMemoryMaterialResolver {
    materials: BTreeMap<String, ResolvedCredentialMaterial>,
}

impl InMemoryMaterialResolver {
    #[must_use]
    pub fn with_material(
        material_ref: impl Into<String>,
        material: ResolvedCredentialMaterial,
    ) -> Self {
        let mut materials = BTreeMap::new();
        materials.insert(material_ref.into(), material);
        Self { materials }
    }
}

impl MaterialResolver for InMemoryMaterialResolver {
    fn resolve_material(
        &self,
        material_ref: &str,
    ) -> Result<ResolvedCredentialMaterial, CredentialDeliveryError> {
        self.materials.get(material_ref).cloned().ok_or_else(|| {
            CredentialDeliveryError::MaterialNotFound {
                material_ref_hash: hash_material_ref(material_ref),
            }
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedCredentialMaterial {
    material_ref: String,
    values: BTreeMap<CredentialMaterialRole, SecretString>,
}

impl ResolvedCredentialMaterial {
    #[must_use]
    pub fn api_key(material_ref: impl Into<String>, value: impl Into<String>) -> Self {
        Self::with_role(material_ref, CredentialMaterialRole::ApiKey, value)
    }

    #[must_use]
    pub fn with_role(
        material_ref: impl Into<String>,
        role: CredentialMaterialRole,
        value: impl Into<String>,
    ) -> Self {
        let mut values = BTreeMap::new();
        values.insert(role, SecretString::new(value));
        Self {
            material_ref: material_ref.into(),
            values,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(REDACTED_CREDENTIAL)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SecretEnv {
    values: BTreeMap<String, SecretString>,
}

impl SecretEnv {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(SecretString::expose)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.values
            .iter()
            .map(|(key, value)| (key.as_str(), value.expose()))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CredentialDelivery {
    secret_env: SecretEnv,
    public_observation: Option<runx_contracts::CredentialDeliveryObservation>,
}

impl CredentialDelivery {
    #[must_use]
    pub const fn none() -> Self {
        Self {
            secret_env: SecretEnv {
                values: BTreeMap::new(),
            },
            public_observation: None,
        }
    }

    /// Build a delivery from a one-shot, per-run local credential descriptor.
    ///
    /// This is the OSS local-provision path: no network, no persistence, no
    /// brokerage. It derives a delivery profile, a credential envelope, and an
    /// allowed binding decision purely from the supplied descriptor, resolves
    /// the secret in-memory, and routes it through the same
    /// [`Self::from_allowed_binding`] seam so policy checks and redaction stay
    /// centralized. The secret value is held only for the lifetime of this run.
    pub fn from_local_descriptor(
        provider: impl Into<String>,
        auth_mode: impl Into<String>,
        env_var: impl Into<String>,
        material_ref: impl Into<String>,
        scopes: Vec<String>,
        secret: impl Into<String>,
    ) -> Result<Self, CredentialDeliveryError> {
        let provider = provider.into();
        let auth_mode = auth_mode.into();
        let material_ref = material_ref.into();

        // Captured before the values move into the envelope/resolver below, so
        // the run records a non-secret observation of the local provision.
        let observation = build_local_provision_observation(&provider, &auth_mode, &material_ref);

        let profile =
            CredentialDeliveryProfile::env_token(provider.clone(), auth_mode.clone(), env_var)?;
        let envelope = CredentialEnvelope {
            kind: CredentialEnvelopeKind::V1,
            grant_id: material_ref.clone().into(),
            provider: provider.into(),
            auth_mode: auth_mode.into(),
            material_kind: "api_key".into(),
            provider_reference: "local_per_run".into(),
            scopes: scopes.into_iter().map(Into::into).collect(),
            grant_reference: None,
            material_ref: material_ref.clone().into(),
        };
        let decision = CredentialBindingDecision::Allow {
            reasons: vec!["local per-run credential provision".to_owned()],
        };
        let resolver = InMemoryMaterialResolver::with_material(
            material_ref.clone(),
            ResolvedCredentialMaterial::api_key(material_ref, secret),
        );

        Self::from_allowed_binding(&decision, &envelope, &profile, &resolver, observation)
    }

    pub fn from_hosted_handles_json(raw: &str) -> Result<Self, CredentialDeliveryError> {
        let handles: Vec<HostedCredentialHandle> = serde_json::from_str(raw).map_err(|error| {
            CredentialDeliveryError::HostedCredentialHandlesInvalid {
                reason: error.to_string(),
            }
        })?;
        Self::from_hosted_handles(&handles)
    }

    // rust-style-allow: long-function because hosted handle delivery validates
    // one homogeneous credential batch before exposing any secret references.
    fn from_hosted_handles(
        handles: &[HostedCredentialHandle],
    ) -> Result<Self, CredentialDeliveryError> {
        let Some(first) = handles.first() else {
            return Ok(Self::none());
        };
        let provider = first.provider.trim();
        if provider.is_empty() {
            return Err(CredentialDeliveryError::HostedCredentialHandlesInvalid {
                reason: "provider is required".to_owned(),
            });
        }
        for handle in handles {
            if handle.credential_ref.reference_type != ReferenceType::Credential {
                return Err(CredentialDeliveryError::HostedCredentialRefType {
                    reference_type: handle.credential_ref.reference_type.as_str().to_owned(),
                });
            }
            if handle.provider.trim() != provider || handle.purpose != first.purpose {
                return Err(CredentialDeliveryError::HostedCredentialHandlesMixed);
            }
        }

        let canonical = serde_json::to_vec(handles).map_err(|error| {
            CredentialDeliveryError::HostedCredentialHandlesInvalid {
                reason: error.to_string(),
            }
        })?;
        let handles_id = sha256_hex(&canonical);
        let mut refs = Vec::with_capacity(handles.len());
        for handle in handles {
            let mut credential_ref = handle.credential_ref.clone();
            credential_ref.provider = Some(handle.provider.clone().into());
            credential_ref.proof_kind = Some(ProofKind::CredentialResolution);
            refs.push(credential_ref);
        }

        Ok(Self {
            secret_env: SecretEnv::default(),
            public_observation: Some(CredentialDeliveryObservation {
                schema: runx_contracts::CredentialDeliveryObservationSchema::V1,
                observation_id: format!("hosted-credential-delivery/{handles_id}").into(),
                request_id: format!("hosted-credential-handles/{handles_id}").into(),
                response_id: None,
                status: CredentialDeliveryObservationStatus::Delivered,
                harness_ref: Reference::with_uri(
                    ReferenceType::Harness,
                    "runx:harness:hosted-credential-handles",
                ),
                host_ref: Some(Reference::with_uri(
                    ReferenceType::Host,
                    "runx:host:hosted-runtime-service",
                )),
                profile_id: format!("{provider}-hosted-handles").into(),
                provider: provider.to_owned().into(),
                purpose: first.purpose.clone(),
                delivery_mode: None,
                credential_refs: refs,
                material_ref_hash: None,
                delivered_roles: Vec::new(),
                redaction_refs: None,
                observed_at: crate::time::now_iso8601().into(),
            }),
        })
    }

    pub fn from_allowed_binding<R: MaterialResolver>(
        decision: &CredentialBindingDecision,
        credential: &CredentialEnvelope,
        profile: &CredentialDeliveryProfile,
        resolver: &R,
        observation: CredentialDeliveryObservation,
    ) -> Result<Self, CredentialDeliveryError> {
        MaterialCredentialSupervisor::new(resolver)
            .resolve(CredentialResolutionRequest {
                decision,
                credential,
                profile,
                observation,
            })
            .map(CredentialResolution::into_delivery)
    }

    #[must_use]
    pub fn secret_env(&self) -> &SecretEnv {
        &self.secret_env
    }

    pub fn reject_process_env_boundary(
        &self,
        boundary: &'static str,
    ) -> Result<(), CredentialDeliveryError> {
        if self.secret_env.is_empty() {
            return Ok(());
        }
        Err(CredentialDeliveryError::ProcessEnvBoundaryUnsupported {
            boundary: boundary.to_owned(),
        })
    }

    #[must_use]
    pub fn with_public_observation(
        mut self,
        observation: runx_contracts::CredentialDeliveryObservation,
    ) -> Self {
        self.public_observation = Some(observation);
        self
    }

    #[must_use]
    pub fn public_observation(&self) -> Option<&runx_contracts::CredentialDeliveryObservation> {
        self.public_observation.as_ref()
    }

    #[must_use]
    pub fn credential_refs(&self) -> Option<Vec<runx_contracts::Reference>> {
        self.public_observation.as_ref().and_then(|observation| {
            (!observation.credential_refs.is_empty()).then(|| observation.credential_refs.clone())
        })
    }

    #[must_use]
    pub fn redact_text(&self, text: impl Into<String>) -> String {
        let mut redacted = text.into();
        for value in self.secret_env.values.values() {
            let secret = value.expose();
            if !secret.is_empty() {
                redacted = redacted.replace(secret, REDACTED_CREDENTIAL);
            }
        }
        redacted
    }

    #[must_use]
    pub fn redact_bytes_to_string(&self, bytes: Vec<u8>, limit_bytes: usize) -> String {
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        text = self.redact_text(text);
        truncate_utf8_string(&text, limit_bytes)
    }
}

#[derive(Debug, Error)]
pub enum CredentialDeliveryError {
    #[error("credential binding denied: {}", reasons.join("; "))]
    BindingDenied { reasons: Vec<String> },
    #[error(
        "credential provider '{credential_provider}' does not match delivery profile provider '{profile_provider}'"
    )]
    ProviderMismatch {
        credential_provider: String,
        profile_provider: String,
    },
    #[error("credential material with hash '{material_ref_hash}' was not found")]
    MaterialNotFound { material_ref_hash: String },
    #[error(
        "credential material ref hash mismatch: expected '{expected_hash}', got '{actual_hash}'"
    )]
    MaterialRefMismatch {
        expected_hash: String,
        actual_hash: String,
    },
    #[error("credential material is missing role '{role}'")]
    MissingRole { role: String },
    #[error("credential material for role '{role}' is empty")]
    EmptyMaterial { role: String },
    #[error("invalid credential delivery env var '{name}'")]
    InvalidEnvName { name: String },
    #[error("unsupported credential delivery mode '{mode}'")]
    UnsupportedDeliveryMode { mode: String },
    #[error("credential process-env delivery is not supported across the '{boundary}' boundary")]
    ProcessEnvBoundaryUnsupported { boundary: String },
    #[error("invalid hosted credential handles: {reason}")]
    HostedCredentialHandlesInvalid { reason: String },
    #[error("hosted credential handles must share one provider and purpose")]
    HostedCredentialHandlesMixed,
    #[error("hosted credential handle reference must be type credential, got '{reference_type}'")]
    HostedCredentialRefType { reference_type: String },
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct HostedCredentialHandle {
    credential_ref: Reference,
    provider: String,
    purpose: CredentialDeliveryPurpose,
}

/// Build the non-secret observation that records a local per-run credential
/// provision on the sealed receipt. It carries no secret material: only the
/// provider, profile, scoped credential reference, and a hash of the opaque
/// material ref. The timestamp is captured at observation time because local
/// credential provision is a live trust boundary, not a fixture surface.
fn build_local_provision_observation(
    provider: &str,
    auth_mode: &str,
    material_ref: &str,
) -> CredentialDeliveryObservation {
    let material_ref_hash = hash_material_ref(material_ref);
    let material_ref_id = sha256_hex(material_ref.as_bytes());
    CredentialDeliveryObservation {
        schema: runx_contracts::CredentialDeliveryObservationSchema::V1,
        observation_id: format!("local-credential-delivery/{material_ref_id}").into(),
        request_id: format!("local-credential-provision/{material_ref_id}").into(),
        response_id: None,
        status: CredentialDeliveryObservationStatus::Delivered,
        harness_ref: Reference::with_uri(
            ReferenceType::Harness,
            "runx:harness:local-credential-provision",
        ),
        host_ref: Some(Reference::with_uri(
            ReferenceType::Host,
            "runx:host:local-cli",
        )),
        profile_id: format!("{provider}-{auth_mode}").into(),
        provider: provider.into(),
        purpose: CredentialDeliveryPurpose::ProviderApi,
        delivery_mode: Some(CredentialDeliveryMode::ProcessEnv),
        credential_refs: vec![Reference {
            reference_type: ReferenceType::Credential,
            uri: format!("runx:credential:local:{material_ref_id}").into(),
            provider: Some(provider.to_owned().into()),
            locator: None,
            label: None,
            observed_at: None,
            proof_kind: Some(ProofKind::CredentialResolution),
        }],
        material_ref_hash: Some(material_ref_hash.into()),
        delivered_roles: vec![runx_contracts::CredentialMaterialRole::ApiKey],
        redaction_refs: None,
        observed_at: crate::time::now_iso8601().into(),
    }
}

fn hash_material_ref(material_ref: &str) -> String {
    sha256_prefixed(material_ref.as_bytes())
}

fn require_allowed_binding(
    decision: &CredentialBindingDecision,
) -> Result<(), CredentialDeliveryError> {
    match decision {
        CredentialBindingDecision::Allow { .. } => Ok(()),
        CredentialBindingDecision::Deny { reasons } => {
            Err(CredentialDeliveryError::BindingDenied {
                reasons: reasons.clone(),
            })
        }
    }
}

fn apply_profile(
    profile: &CredentialDeliveryProfile,
    material: &ResolvedCredentialMaterial,
) -> Result<SecretEnv, CredentialDeliveryError> {
    let mut values = BTreeMap::new();
    for binding in &profile.env_bindings {
        let Some(secret) = material.values.get(&binding.role) else {
            if !binding.required {
                continue;
            }
            return Err(CredentialDeliveryError::MissingRole {
                role: binding.role.label().to_owned(),
            });
        };
        if secret.expose().trim().is_empty() {
            return Err(CredentialDeliveryError::EmptyMaterial {
                role: binding.role.label().to_owned(),
            });
        }
        values.insert(binding.env_var.clone(), secret.clone());
    }
    Ok(SecretEnv { values })
}

fn validate_env_name(name: &str) -> Result<(), CredentialDeliveryError> {
    let mut chars = name.chars();
    let valid = chars
        .next()
        .is_some_and(|ch| ch == '_' || ch.is_ascii_uppercase())
        && chars.all(|ch| ch == '_' || ch.is_ascii_uppercase() || ch.is_ascii_digit());
    if valid {
        Ok(())
    } else {
        Err(CredentialDeliveryError::InvalidEnvName {
            name: name.to_owned(),
        })
    }
}

fn truncate_utf8_string(text: &str, limit_bytes: usize) -> String {
    if text.len() <= limit_bytes {
        return text.to_owned();
    }
    let mut end = limit_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_env_binding_is_skipped_when_material_role_is_missing()
    -> Result<(), CredentialDeliveryError> {
        let profile = CredentialDeliveryProfile {
            provider: "github".to_owned(),
            auth_mode: "api_key".to_owned(),
            env_bindings: vec![CredentialEnvBinding {
                role: CredentialMaterialRole::ApiKey,
                env_var: "GITHUB_TOKEN".to_owned(),
                required: false,
            }],
        };
        let material = ResolvedCredentialMaterial {
            material_ref: "secret://github/main".to_owned(),
            values: BTreeMap::new(),
        };

        let env = apply_profile(&profile, &material)?;

        assert!(env.is_empty());
        Ok(())
    }

    #[test]
    fn required_env_binding_fails_when_material_role_is_missing() {
        let profile = CredentialDeliveryProfile {
            provider: "github".to_owned(),
            auth_mode: "api_key".to_owned(),
            env_bindings: vec![CredentialEnvBinding {
                role: CredentialMaterialRole::ApiKey,
                env_var: "GITHUB_TOKEN".to_owned(),
                required: true,
            }],
        };
        let material = ResolvedCredentialMaterial {
            material_ref: "secret://github/main".to_owned(),
            values: BTreeMap::new(),
        };

        let result = apply_profile(&profile, &material);

        assert!(matches!(
            result,
            Err(CredentialDeliveryError::MissingRole { role }) if role == "api_key"
        ));
    }

    #[test]
    fn delivery_profile_resolves_non_api_contract_role() -> Result<(), CredentialDeliveryError> {
        let contract_profile = runx_contracts::CredentialDeliveryProfile {
            schema: runx_contracts::CredentialDeliveryProfileSchema::V1,
            profile_id: "github-app".into(),
            provider: "github".into(),
            auth_mode: "app".into(),
            purpose: CredentialDeliveryPurpose::ProviderApi,
            delivery_mode: CredentialDeliveryMode::ProcessEnv,
            material_roles: vec![runx_contracts::CredentialMaterialRole::ClientSecret],
            env_bindings: vec![runx_contracts::CredentialDeliveryEnvBinding {
                role: runx_contracts::CredentialMaterialRole::ClientSecret,
                env_var: "GITHUB_CLIENT_SECRET".to_owned(),
                required: true,
            }],
            redaction_policy_ref: Reference::with_uri(
                ReferenceType::RedactionPolicy,
                "runx:redaction:credential",
            ),
        };
        let profile = CredentialDeliveryProfile::from_contract_profile(&contract_profile)?;
        let material = ResolvedCredentialMaterial::with_role(
            "secret://github/app",
            CredentialMaterialRole::ClientSecret,
            "client-secret-value",
        );

        let env = apply_profile(&profile, &material)?;

        assert_eq!(env.get("GITHUB_CLIENT_SECRET"), Some("client-secret-value"));
        Ok(())
    }

    #[test]
    fn credential_supervisor_resolves_allowed_binding_without_secret_debug_leak()
    -> Result<(), CredentialDeliveryError> {
        let material_ref = "secret://github/main";
        let resolver = InMemoryMaterialResolver::with_material(
            material_ref,
            ResolvedCredentialMaterial::api_key(material_ref, "ghp_secret_value"),
        );
        let profile = CredentialDeliveryProfile::env_token("github", "api_key", "GITHUB_TOKEN")?;
        let credential = CredentialEnvelope {
            kind: CredentialEnvelopeKind::V1,
            grant_id: "grant_1".into(),
            provider: "github".into(),
            auth_mode: "api_key".into(),
            material_kind: "api_key".into(),
            provider_reference: "local_per_run".into(),
            scopes: vec!["repo:read".into()],
            grant_reference: None,
            material_ref: material_ref.into(),
        };
        let decision = CredentialBindingDecision::Allow {
            reasons: vec!["unit-test".to_owned()],
        };

        let delivery = MaterialCredentialSupervisor::new(&resolver)
            .resolve(CredentialResolutionRequest {
                decision: &decision,
                credential: &credential,
                profile: &profile,
                observation: build_local_provision_observation("github", "api_key", material_ref),
            })?
            .into_delivery();

        assert_eq!(
            delivery.secret_env().get("GITHUB_TOKEN"),
            Some("ghp_secret_value")
        );
        assert!(!format!("{delivery:?}").contains("ghp_secret_value"));
        Ok(())
    }

    #[test]
    fn local_credential_observation_marks_credential_resolution_proof() -> Result<(), String> {
        let delivery = CredentialDelivery::from_local_descriptor(
            "github",
            "api_key",
            "GITHUB_TOKEN",
            "local:github:grant_1",
            vec!["repo:read".to_owned()],
            "ghp_secret_value",
        )
        .map_err(|error| error.to_string())?;
        let refs = delivery
            .credential_refs()
            .ok_or_else(|| "expected credential refs".to_owned())?;

        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].reference_type.as_str(), "credential");
        assert_eq!(refs[0].provider.as_deref(), Some("github"));
        assert_eq!(refs[0].proof_kind, Some(ProofKind::CredentialResolution));
        let observation = delivery
            .public_observation()
            .ok_or_else(|| "expected a public observation".to_owned())?;
        let serialized = serde_json::to_string(observation).map_err(|error| error.to_string())?;
        assert!(!serialized.contains("ghp_secret_value"));
        Ok(())
    }

    #[test]
    fn hosted_credential_handles_create_non_secret_observation() -> Result<(), String> {
        let delivery = CredentialDelivery::from_hosted_handles_json(
            r#"[
              {
                "credential_ref": {
                  "type": "credential",
                  "uri": "runx:credential:github-installation:123"
                },
                "provider": "github",
                "purpose": "provider_api"
              }
            ]"#,
        )
        .map_err(|error| error.to_string())?;

        assert!(delivery.secret_env().is_empty());
        let observation = delivery
            .public_observation()
            .ok_or_else(|| "expected hosted credential observation".to_owned())?;
        assert_eq!(observation.provider.as_str(), "github");
        assert_eq!(observation.purpose, CredentialDeliveryPurpose::ProviderApi);
        assert_eq!(observation.delivery_mode, None);
        assert!(observation.delivered_roles.is_empty());
        assert_eq!(observation.credential_refs.len(), 1);
        assert_eq!(
            observation.credential_refs[0].proof_kind,
            Some(ProofKind::CredentialResolution)
        );
        assert_eq!(
            observation.credential_refs[0].provider.as_deref(),
            Some("github")
        );
        Ok(())
    }

    #[test]
    fn hosted_credential_handles_fail_closed_on_mixed_authority() {
        let result = CredentialDelivery::from_hosted_handles_json(
            r#"[
              {
                "credential_ref": {
                  "type": "credential",
                  "uri": "runx:credential:github-installation:123"
                },
                "provider": "github",
                "purpose": "provider_api"
              },
              {
                "credential_ref": {
                  "type": "credential",
                  "uri": "runx:credential:slack:456"
                },
                "provider": "slack",
                "purpose": "provider_api"
              }
            ]"#,
        );

        assert!(matches!(
            result,
            Err(CredentialDeliveryError::HostedCredentialHandlesMixed)
        ));
    }

    #[test]
    fn material_ref_errors_report_hashes_not_raw_refs() {
        let result = InMemoryMaterialResolver::default().resolve_material("secret://github/main");
        assert!(result.is_err(), "missing material must fail");
        let missing = match result {
            Err(error) => error,
            Ok(_) => return,
        };
        let message = missing.to_string();
        assert!(message.contains("sha256:"));
        assert!(!message.contains("secret://github/main"));

        let mismatch = CredentialDeliveryError::MaterialRefMismatch {
            expected_hash: hash_material_ref("secret://github/main"),
            actual_hash: hash_material_ref("secret://github/other"),
        };
        let message = mismatch.to_string();
        assert!(message.contains("sha256:"));
        assert!(!message.contains("secret://github/main"));
        assert!(!message.contains("secret://github/other"));
    }
}

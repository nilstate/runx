use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ring::signature::{ED25519, UnparsedPublicKey};
use std::collections::BTreeMap;

use super::source_authority::{
    RegistryManifestSourceAuthority, registry_manifest_source_authority_from_env,
    registry_manifest_source_key,
};
use super::types::{RegistrySignedManifest, TrustTier};

pub const REGISTRY_SIGNED_MANIFEST_SCHEMA: &str = "runx.registry.signed_manifest.v1";
pub const RUNX_REGISTRY_MANIFEST_TRUST_KEY_ENV: &str = "RUNX_REGISTRY_MANIFEST_TRUST_KEY_BASE64";
pub const RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID_ENV: &str = "RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID";
pub const RUNX_REGISTRY_MANIFEST_TRUST_OWNER_ENV: &str = "RUNX_REGISTRY_MANIFEST_TRUST_OWNER";

const RUNX_REGISTRY_MANIFEST_KEY_ID: &str = "runx-registry-ed25519-v1";
const RUNX_REGISTRY_MANIFEST_PUBLIC_KEY_BASE64: &str =
    "vacyj4d6LKwcrUK66mdH/BWHRy9haaDRQOtJEH+vOaY=";
const REGISTRY_MANIFEST_SIGNATURE_BASE64_PREFIX: &str = "base64:";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustedRegistryManifestKey {
    pub key_id: String,
    pub public_key: Vec<u8>,
    pub scope: RegistryManifestTrustScope,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegistryManifestTrustScope {
    OfficialRunx,
    ThirdParty {
        allowed_owner: String,
        allowed_source: String,
    },
}

impl TrustedRegistryManifestKey {
    pub fn from_base64(
        key_id: String,
        public_key: &str,
        allowed_owner: String,
        allowed_source: String,
    ) -> Result<Self, RegistryManifestKeyError> {
        let allowed_owner = validate_owner_namespace(allowed_owner)?;
        let allowed_source = validate_registry_source(allowed_source)?;
        Self::from_base64_with_scope(
            key_id,
            public_key,
            RegistryManifestTrustScope::ThirdParty {
                allowed_owner,
                allowed_source,
            },
        )
    }

    pub fn official_from_base64(
        key_id: String,
        public_key: &str,
    ) -> Result<Self, RegistryManifestKeyError> {
        Self::from_base64_with_scope(key_id, public_key, RegistryManifestTrustScope::OfficialRunx)
    }

    fn from_base64_with_scope(
        key_id: String,
        public_key: &str,
        scope: RegistryManifestTrustScope,
    ) -> Result<Self, RegistryManifestKeyError> {
        let public_key = decode_base64(public_key).map_err(|_| RegistryManifestKeyError)?;
        if public_key.len() != 32 {
            return Err(RegistryManifestKeyError);
        }
        Ok(Self {
            key_id,
            public_key,
            scope,
        })
    }

    #[must_use]
    pub fn public_key_base64(&self) -> String {
        STANDARD.encode(&self.public_key)
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("registry manifest key is invalid")]
pub struct RegistryManifestKeyError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegistryManifestVerificationFailure {
    UnsupportedSchema,
    UnsupportedAlgorithm,
    MalformedPayload,
    UnknownKey,
    MalformedKey,
    MalformedSignature,
    SignatureMismatch,
}

pub fn verify_registry_signed_manifest<'a>(
    manifest: &RegistrySignedManifest,
    trusted_keys: &'a [TrustedRegistryManifestKey],
) -> Result<&'a TrustedRegistryManifestKey, RegistryManifestVerificationFailure> {
    if manifest.schema != REGISTRY_SIGNED_MANIFEST_SCHEMA {
        return Err(RegistryManifestVerificationFailure::UnsupportedSchema);
    }
    if manifest.signature.alg != "ed25519" {
        return Err(RegistryManifestVerificationFailure::UnsupportedAlgorithm);
    }
    validate_registry_manifest_payload_terms(manifest)?;
    let key = trusted_keys
        .iter()
        .find(|key| key.key_id == manifest.signer.key_id)
        .ok_or(RegistryManifestVerificationFailure::UnknownKey)?;
    if key.public_key.len() != 32 {
        return Err(RegistryManifestVerificationFailure::MalformedKey);
    }
    let signature = decode_signature(&manifest.signature.value)?;
    if signature.len() != 64 {
        return Err(RegistryManifestVerificationFailure::MalformedSignature);
    }
    let payload = registry_manifest_payload(
        &manifest.skill_id,
        &manifest.version,
        &manifest.digest,
        manifest.profile_digest.as_deref(),
        manifest.package_digest.as_deref(),
        &manifest.signer.id,
        &manifest.signer.key_id,
    );
    UnparsedPublicKey::new(&ED25519, &key.public_key)
        .verify(payload.as_bytes(), &signature)
        .map_err(|_| RegistryManifestVerificationFailure::SignatureMismatch)?;
    Ok(key)
}

pub fn default_trusted_registry_manifest_keys()
-> Result<Vec<TrustedRegistryManifestKey>, RegistryManifestKeyError> {
    Ok(vec![TrustedRegistryManifestKey::official_from_base64(
        RUNX_REGISTRY_MANIFEST_KEY_ID.to_owned(),
        RUNX_REGISTRY_MANIFEST_PUBLIC_KEY_BASE64,
    )?])
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum RegistryManifestTrustEnvError {
    #[error("registry manifest trust key is invalid")]
    InvalidKey,
    #[error("registry manifest trust key id is required")]
    MissingKeyId,
    #[error("registry manifest trust owner is required")]
    MissingOwner,
    #[error("registry manifest trust source is required")]
    MissingSource,
}

pub fn trusted_registry_manifest_keys_from_env(
    env: &BTreeMap<String, String>,
) -> Result<Vec<TrustedRegistryManifestKey>, RegistryManifestTrustEnvError> {
    trusted_registry_manifest_keys_from_env_with_source(
        env,
        registry_manifest_source_authority_from_env(env),
    )
}

pub fn trusted_registry_manifest_keys_from_env_with_source(
    env: &BTreeMap<String, String>,
    source_authority: Option<RegistryManifestSourceAuthority>,
) -> Result<Vec<TrustedRegistryManifestKey>, RegistryManifestTrustEnvError> {
    let mut trusted_keys = default_trusted_registry_manifest_keys()
        .map_err(|_| RegistryManifestTrustEnvError::InvalidKey)?;
    let Some(public_key) = env.get(RUNX_REGISTRY_MANIFEST_TRUST_KEY_ENV) else {
        return Ok(trusted_keys);
    };
    let key_id = env
        .get(RUNX_REGISTRY_MANIFEST_TRUST_KEY_ID_ENV)
        .cloned()
        .ok_or(RegistryManifestTrustEnvError::MissingKeyId)?;
    let allowed_owner = env
        .get(RUNX_REGISTRY_MANIFEST_TRUST_OWNER_ENV)
        .cloned()
        .ok_or(RegistryManifestTrustEnvError::MissingOwner)?;
    let allowed_source = source_authority
        .as_ref()
        .map(registry_manifest_source_key)
        .ok_or(RegistryManifestTrustEnvError::MissingSource)?;
    let key =
        TrustedRegistryManifestKey::from_base64(key_id, public_key, allowed_owner, allowed_source)
            .map_err(|_| RegistryManifestTrustEnvError::InvalidKey)?;
    trusted_keys.push(key);
    Ok(trusted_keys)
}

pub fn registry_manifest_key_allows(
    key: &TrustedRegistryManifestKey,
    skill_id: &str,
    trust_tier: &TrustTier,
    source_authority: Option<&RegistryManifestSourceAuthority>,
) -> Result<(), String> {
    match &key.scope {
        RegistryManifestTrustScope::OfficialRunx => {
            if !skill_id.starts_with("runx/") {
                return Err("official key may only sign runx/* skills".to_owned());
            }
            if !matches!(
                source_authority,
                Some(RegistryManifestSourceAuthority::OfficialRunx)
            ) {
                return Err(
                    "official key may only grant trust for the official runx registry source"
                        .to_owned(),
                );
            }
            Ok(())
        }
        RegistryManifestTrustScope::ThirdParty {
            allowed_owner,
            allowed_source,
        } => {
            if matches!(trust_tier, TrustTier::FirstParty) {
                return Err("third-party keys may not grant first_party trust".to_owned());
            }
            let actual_source = source_authority
                .map(registry_manifest_source_key)
                .ok_or_else(|| "third-party key requires a registry source".to_owned())?;
            if actual_source != *allowed_source {
                return Err(format!(
                    "third-party key may only sign from registry source {allowed_source}"
                ));
            }
            let Some((owner, _name)) = skill_id.split_once('/') else {
                return Err("skill id must include an owner namespace".to_owned());
            };
            if owner == "runx" {
                return Err("third-party keys may not sign runx/* skills".to_owned());
            }
            if owner != allowed_owner {
                return Err(format!(
                    "third-party key may only sign {allowed_owner}/* skills"
                ));
            }
            Ok(())
        }
    }
}

fn validate_owner_namespace(value: String) -> Result<String, RegistryManifestKeyError> {
    let owner = value.trim();
    if owner.is_empty()
        || owner == "runx"
        || owner.contains('/')
        || owner
            .bytes()
            .any(|byte| matches!(byte, b'\n' | b'\r' | b'=' | 0))
    {
        return Err(RegistryManifestKeyError);
    }
    Ok(owner.to_owned())
}

fn validate_registry_source(value: String) -> Result<String, RegistryManifestKeyError> {
    let source = value.trim();
    if source.is_empty()
        || source
            .bytes()
            .any(|byte| matches!(byte, b'\n' | b'\r' | b'=' | 0))
    {
        return Err(RegistryManifestKeyError);
    }
    Ok(source.to_owned())
}

fn registry_manifest_payload(
    skill_id: &str,
    version: &str,
    digest: &str,
    profile_digest: Option<&str>,
    package_digest: Option<&str>,
    signer_id: &str,
    key_id: &str,
) -> String {
    format!(
        "{REGISTRY_SIGNED_MANIFEST_SCHEMA}\nskill_id={skill_id}\nversion={version}\ndigest={digest}\nprofile_digest={}\npackage_digest={}\nsigner_id={signer_id}\nkey_id={key_id}\n",
        profile_digest.unwrap_or(""),
        package_digest.unwrap_or("")
    )
}

fn validate_registry_manifest_payload_terms(
    manifest: &RegistrySignedManifest,
) -> Result<(), RegistryManifestVerificationFailure> {
    validate_registry_manifest_payload_term(&manifest.skill_id)?;
    validate_registry_manifest_payload_term(&manifest.version)?;
    validate_registry_manifest_payload_term(&manifest.digest)?;
    if let Some(profile_digest) = &manifest.profile_digest {
        validate_registry_manifest_payload_term(profile_digest)?;
    }
    if let Some(package_digest) = &manifest.package_digest {
        validate_registry_manifest_payload_term(package_digest)?;
    }
    validate_registry_manifest_payload_term(&manifest.signer.id)?;
    validate_registry_manifest_payload_term(&manifest.signer.key_id)
}

fn validate_registry_manifest_payload_term(
    value: &str,
) -> Result<(), RegistryManifestVerificationFailure> {
    if value.is_empty()
        || value
            .bytes()
            .any(|byte| matches!(byte, b'\n' | b'\r' | b'=' | 0))
    {
        return Err(RegistryManifestVerificationFailure::MalformedPayload);
    }
    Ok(())
}

fn decode_signature(value: &str) -> Result<Vec<u8>, RegistryManifestVerificationFailure> {
    let Some(encoded) = value.strip_prefix(REGISTRY_MANIFEST_SIGNATURE_BASE64_PREFIX) else {
        return Err(RegistryManifestVerificationFailure::MalformedSignature);
    };
    decode_base64(encoded).map_err(|_| RegistryManifestVerificationFailure::MalformedSignature)
}

fn decode_base64(value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| STANDARD.decode(value))
}

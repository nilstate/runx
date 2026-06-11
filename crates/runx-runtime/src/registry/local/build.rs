// rust-style-allow: large-file because local registry ingestion keeps skill
// parsing, binding metadata, and registry-version projection together for the
// current TS-sunset parity slice.
use runx_contracts::maturity::MaturityTier;
use runx_contracts::{JsonObject, JsonValue, sha256_hex};
use runx_parser::{
    SkillRunnerManifest, ValidatedSkill, parse_runner_manifest_yaml, parse_skill_markdown,
    validate_runner_manifest, validate_skill,
};
use serde::Deserialize;

use super::super::scopes::required_scopes_from_skill_and_runner;
use super::super::types::{
    RegistryAttestation, RegistryPublisher, RegistrySkillVersion, RegistrySourceMetadata, TrustTier,
};
use super::{IngestSkillOptions, LocalRegistryError, build_skill_id};
use crate::registry::local::trust::{
    build_publisher_attestations, build_source_attestations, merge_registry_attestations,
    normalize_attestations,
};
use crate::registry::local::util::{
    missing_field, now_iso8601, required_string, validate_publisher, validate_source_metadata,
};

pub fn build_registry_skill_version(
    markdown: &str,
    options: &IngestSkillOptions,
) -> Result<RegistrySkillVersion, LocalRegistryError> {
    let raw = parse_skill_markdown(markdown)?;
    let skill = validate_skill(raw)?;
    let digest = sha256_hex(markdown.as_bytes());
    let binding = build_binding_artifact(&skill, options.profile_document.as_deref())?;
    let catalog = registry_catalog(binding.manifest.as_ref());
    let defaults = registry_version_defaults(&digest, binding.digest.as_deref(), options);
    let manifest = binding.manifest.as_ref();
    let skill_id = build_skill_id(&defaults.owner, &skill.name)?;
    Ok(RegistrySkillVersion {
        skill_id,
        owner: defaults.owner,
        name: skill.name.clone(),
        description: skill.description.clone(),
        version: defaults.version,
        digest,
        signed_manifest: None,
        markdown: markdown.to_owned(),
        profile_document: options.profile_document.clone(),
        profile_digest: binding.digest,
        runner_names: binding.runner_names,
        source_type: skill.source.source_type.as_str().to_owned(),
        trust_tier: defaults.trust_tier,
        // Alpha is the floor at creation; maturity is recomputed from harness
        // signals at the publish and harness-seal events, never on read.
        maturity: MaturityTier::Alpha,
        catalog_kind: Some(catalog.kind.as_str().to_owned()),
        catalog_audience: Some(catalog.audience.as_str().to_owned()),
        catalog_visibility: Some(catalog.visibility.as_str().to_owned()),
        source_metadata: defaults.source_metadata,
        attestations: defaults.attestations,
        required_scopes: registry_required_scopes(&skill, manifest),
        runtime: registry_runtime(&skill, manifest),
        auth: skill.auth.clone(),
        risk: registry_risk(&skill),
        runx: skill.runx.clone(),
        tags: registry_tags(&skill, manifest),
        publisher: defaults.publisher,
        created_at: defaults.created_at,
        updated_at: now_iso8601(),
    })
}

struct RegistryVersionDefaults {
    owner: String,
    created_at: String,
    publisher: RegistryPublisher,
    trust_tier: TrustTier,
    version: String,
    source_metadata: Option<RegistrySourceMetadata>,
    attestations: Vec<RegistryAttestation>,
}

fn registry_version_defaults(
    digest: &str,
    profile_digest: Option<&str>,
    options: &IngestSkillOptions,
) -> RegistryVersionDefaults {
    let owner = options.owner.clone().unwrap_or_else(|| "local".to_owned());
    let created_at = options.created_at.clone().unwrap_or_else(now_iso8601);
    let publisher = options
        .publisher
        .clone()
        .unwrap_or_else(|| default_registry_publisher(&owner));
    let trust_tier = options
        .trust_tier
        .clone()
        .unwrap_or_else(|| derive_registry_trust_tier(&owner, None));
    let version = options.version.clone().unwrap_or_else(|| {
        let seed = default_registry_version_seed(digest, profile_digest);
        format!("sha-{}", seed.chars().take(12).collect::<String>())
    });
    let source_metadata = options.source_metadata.clone();
    let attestations = merge_registry_attestations(vec![
        build_publisher_attestations(&publisher, &trust_tier, &created_at),
        build_source_attestations(source_metadata.as_ref(), &created_at),
        options.attestations.clone(),
    ]);
    RegistryVersionDefaults {
        owner,
        created_at,
        publisher,
        trust_tier,
        version,
        source_metadata,
        attestations,
    }
}

pub(super) fn registry_catalog(
    manifest: Option<&SkillRunnerManifest>,
) -> runx_parser::CatalogMetadata {
    manifest
        .and_then(|manifest| manifest.catalog.clone())
        .unwrap_or(runx_parser::CatalogMetadata {
            kind: runx_parser::CatalogKind::Skill,
            audience: runx_parser::CatalogAudience::Public,
            visibility: runx_parser::CatalogVisibility::Public,
            role: runx_parser::CatalogRole::Context,
            canonical_skill: None,
            provider: None,
            runtime_path: None,
            part_of: Vec::new(),
        })
}

pub(super) fn registry_required_scopes(
    skill: &ValidatedSkill,
    manifest: Option<&SkillRunnerManifest>,
) -> Vec<String> {
    required_scopes_from_skill_and_runner(skill, manifest)
}

pub(super) fn registry_runtime(
    skill: &ValidatedSkill,
    manifest: Option<&SkillRunnerManifest>,
) -> Option<JsonValue> {
    skill
        .runtime
        .clone()
        .or_else(|| record_field(skill.runx.as_ref(), "runtime"))
        .or_else(|| extract_runner_runtime(manifest))
}

pub(super) fn registry_risk(skill: &ValidatedSkill) -> Option<JsonValue> {
    skill
        .risk
        .clone()
        .or_else(|| record_field(skill.runx.as_ref(), "risk"))
}

pub(super) fn registry_tags(
    skill: &ValidatedSkill,
    manifest: Option<&SkillRunnerManifest>,
) -> Vec<String> {
    unique(
        extract_tags(skill)
            .into_iter()
            .chain(extract_runner_tags(manifest))
            .collect(),
    )
}

pub fn normalize_registry_skill_version(
    payload: RegistrySkillVersionPayload,
) -> Result<RegistrySkillVersion, LocalRegistryError> {
    let governance = normalize_registry_version_governance(&payload)?;
    Ok(RegistrySkillVersion {
        skill_id: required_string(payload.skill_id, "registry_version.skill_id")?,
        owner: governance.owner,
        name: required_string(payload.name, "registry_version.name")?,
        description: payload.description,
        version: required_string(payload.version, "registry_version.version")?,
        digest: required_string(payload.digest, "registry_version.digest")?,
        signed_manifest: payload.signed_manifest,
        markdown: required_string(payload.markdown, "registry_version.markdown")?,
        profile_document: payload.profile_document,
        profile_digest: payload.profile_digest,
        runner_names: payload.runner_names.unwrap_or_default(),
        source_type: required_string(payload.source_type, "registry_version.source_type")?,
        trust_tier: governance.trust_tier,
        // Preserved through re-ingest; defaults to the Alpha floor when absent.
        maturity: payload.maturity.unwrap_or_default(),
        catalog_kind: Some(governance.catalog.kind.as_str().to_owned()),
        catalog_audience: Some(governance.catalog.audience.as_str().to_owned()),
        catalog_visibility: Some(governance.catalog.visibility.as_str().to_owned()),
        source_metadata: governance.source_metadata,
        attestations: governance.attestations,
        required_scopes: payload.required_scopes.unwrap_or_default(),
        runtime: payload.runtime,
        auth: payload.auth,
        risk: payload.risk,
        runx: payload.runx,
        tags: payload.tags.unwrap_or_default(),
        publisher: governance.publisher,
        updated_at: governance.updated_at,
        created_at: governance.created_at,
    })
}

struct NormalizedRegistryVersionGovernance {
    owner: String,
    created_at: String,
    publisher: RegistryPublisher,
    trust_tier: TrustTier,
    source_metadata: Option<RegistrySourceMetadata>,
    attestations: Vec<RegistryAttestation>,
    catalog: runx_parser::CatalogMetadata,
    updated_at: String,
}

fn normalize_registry_version_governance(
    payload: &RegistrySkillVersionPayload,
) -> Result<NormalizedRegistryVersionGovernance, LocalRegistryError> {
    let owner = required_string(payload.owner.clone(), "registry_version.owner")?;
    let created_at = required_string(payload.created_at.clone(), "registry_version.created_at")?;
    let publisher = validate_publisher(
        payload
            .publisher
            .clone()
            .ok_or_else(|| missing_field("registry_version.publisher"))?,
        "registry_version.publisher",
    )?;
    let trust_tier = payload.trust_tier.clone().unwrap_or(TrustTier::Community);
    let source_metadata = normalize_source_metadata(payload.source_metadata.clone())?;
    let attestations = normalize_attestations(
        payload.attestations.clone().unwrap_or_default(),
        source_metadata.as_ref(),
        &publisher,
        &trust_tier,
        &created_at,
    );
    let catalog = normalize_registry_catalog(
        payload.catalog_kind.as_deref(),
        payload.catalog_audience.as_deref(),
        payload.catalog_visibility.as_deref(),
    );
    let updated_at = payload
        .updated_at
        .as_ref()
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| created_at.clone());
    Ok(NormalizedRegistryVersionGovernance {
        owner,
        created_at,
        publisher,
        trust_tier,
        source_metadata,
        attestations,
        catalog,
        updated_at,
    })
}

pub(super) fn normalize_source_metadata(
    source_metadata: Option<RegistrySourceMetadata>,
) -> Result<Option<RegistrySourceMetadata>, LocalRegistryError> {
    source_metadata.map(validate_source_metadata).transpose()
}

pub(super) fn normalize_registry_catalog(
    kind: Option<&str>,
    audience: Option<&str>,
    visibility: Option<&str>,
) -> runx_parser::CatalogMetadata {
    runx_parser::CatalogMetadata {
        kind: match kind {
            Some("graph") => runx_parser::CatalogKind::Graph,
            _ => runx_parser::CatalogKind::Skill,
        },
        audience: match audience {
            Some("builder") => runx_parser::CatalogAudience::Builder,
            Some("operator") => runx_parser::CatalogAudience::Operator,
            _ => runx_parser::CatalogAudience::Public,
        },
        visibility: match visibility {
            Some("internal") => runx_parser::CatalogVisibility::Internal,
            _ => runx_parser::CatalogVisibility::Public,
        },
        role: runx_parser::CatalogRole::Context,
        canonical_skill: None,
        provider: None,
        runtime_path: None,
        part_of: Vec::new(),
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct RegistrySkillVersionPayload {
    skill_id: Option<String>,
    owner: Option<String>,
    name: Option<String>,
    description: Option<String>,
    version: Option<String>,
    digest: Option<String>,
    signed_manifest: Option<super::super::types::RegistrySignedManifest>,
    markdown: Option<String>,
    profile_document: Option<String>,
    profile_digest: Option<String>,
    runner_names: Option<Vec<String>>,
    source_type: Option<String>,
    trust_tier: Option<TrustTier>,
    maturity: Option<MaturityTier>,
    catalog_kind: Option<String>,
    catalog_audience: Option<String>,
    catalog_visibility: Option<String>,
    source_metadata: Option<RegistrySourceMetadata>,
    attestations: Option<Vec<RegistryAttestation>>,
    required_scopes: Option<Vec<String>>,
    runtime: Option<JsonValue>,
    auth: Option<JsonValue>,
    risk: Option<JsonValue>,
    runx: Option<JsonObject>,
    tags: Option<Vec<String>>,
    publisher: Option<RegistryPublisher>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

struct BindingArtifact {
    digest: Option<String>,
    runner_names: Vec<String>,
    manifest: Option<SkillRunnerManifest>,
}

fn build_binding_artifact(
    skill: &ValidatedSkill,
    profile_document: Option<&str>,
) -> Result<BindingArtifact, LocalRegistryError> {
    let Some(profile_document) = profile_document else {
        return Ok(BindingArtifact {
            digest: None,
            runner_names: Vec::new(),
            manifest: None,
        });
    };
    let manifest = validate_runner_manifest(parse_runner_manifest_yaml(profile_document)?)?;
    if let Some(manifest_skill) = &manifest.skill {
        if manifest_skill != &skill.name {
            return Err(LocalRegistryError::InvalidVersionPayload {
                field: "profile_document.skill".to_owned(),
                message: format!(
                    "runner manifest skill '{manifest_skill}' does not match skill '{}'",
                    skill.name
                ),
            });
        }
    }
    Ok(BindingArtifact {
        digest: Some(sha256_hex(profile_document.as_bytes())),
        runner_names: manifest.runners.keys().cloned().collect(),
        manifest: Some(manifest),
    })
}

pub(super) fn default_registry_version_seed(
    markdown_digest: &str,
    profile_digest: Option<&str>,
) -> String {
    match profile_digest {
        Some(profile_digest) => sha256_hex(
            format!(
                "{{\"markdown_digest\":\"{markdown_digest}\",\"profile_digest\":\"{profile_digest}\"}}"
            )
            .as_bytes(),
        ),
        None => markdown_digest.to_owned(),
    }
}

pub(super) fn default_registry_publisher(owner: &str) -> RegistryPublisher {
    RegistryPublisher {
        kind: if owner == "runx" {
            "organization".to_owned()
        } else {
            "publisher".to_owned()
        },
        id: owner.to_owned(),
        handle: Some(owner.to_owned()),
        display_name: None,
    }
}

pub(super) fn derive_registry_trust_tier(
    _owner: &str,
    trust_tier: Option<&TrustTier>,
) -> TrustTier {
    trust_tier.cloned().unwrap_or(TrustTier::Community)
}

pub(super) fn extract_runner_runtime(manifest: Option<&SkillRunnerManifest>) -> Option<JsonValue> {
    let manifest = manifest?;
    let runners = manifest
        .runners
        .values()
        .filter(|runner| runner.runtime.is_some())
        .map(|runner| JsonValue::String(runner.name.clone()))
        .collect::<Vec<_>>();
    if runners.is_empty() {
        None
    } else {
        Some(JsonValue::Object(
            [("runners".to_owned(), JsonValue::Array(runners))].into(),
        ))
    }
}

pub(super) fn extract_runner_tags(manifest: Option<&SkillRunnerManifest>) -> Vec<String> {
    let Some(manifest) = manifest else {
        return Vec::new();
    };
    unique(
        manifest
            .runners
            .values()
            .flat_map(|runner| record_array_field_from_object(runner.runx.as_ref(), "tags"))
            .collect(),
    )
}

pub(super) fn extract_tags(skill: &ValidatedSkill) -> Vec<String> {
    unique(record_array_field_from_object(skill.runx.as_ref(), "tags"))
}

pub(super) fn record_array_field_from_object(
    value: Option<&JsonObject>,
    field: &str,
) -> Vec<String> {
    let Some(record) = value else {
        return Vec::new();
    };
    let Some(JsonValue::Array(values)) = record.get(field) else {
        return Vec::new();
    };
    values
        .iter()
        .filter_map(|value| match value {
            JsonValue::String(value) if !value.is_empty() => Some(value.clone()),
            _ => None,
        })
        .collect()
}

pub(super) fn record_field(value: Option<&JsonObject>, field: &str) -> Option<JsonValue> {
    value.and_then(|record| record.get(field).cloned())
}

pub(super) fn unique(values: Vec<String>) -> Vec<String> {
    let mut unique_values = Vec::new();
    for value in values {
        if !unique_values.contains(&value) {
            unique_values.push(value);
        }
    }
    unique_values
}

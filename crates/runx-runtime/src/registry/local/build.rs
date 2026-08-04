// Module rationale: local registry ingestion keeps package
// validation, binding metadata, and registry-version projection in one atomic
// build boundary.
use runx_contracts::maturity::MaturityTier;
use runx_contracts::{JsonObject, JsonValue, sha256_hex};
use serde::Deserialize;

use super::super::package_files::{
    normalize_registry_package_files, registry_package_digest, validate_registry_skill_package,
};
use super::super::types::{
    RegistryAttestation, RegistryPackageFile, RegistryPublisher, RegistrySkillVersion,
    RegistrySourceMetadata, TrustTier,
};
use super::{IngestSkillOptions, LocalRegistryError, build_skill_id};
use crate::registry::local::trust::{
    build_publisher_attestations, build_source_attestations, merge_registry_attestations,
    normalize_attestations,
};
use crate::registry::local::util::{
    missing_field, now_iso8601, required_string, validate_publisher, validate_source_metadata,
};
use crate::registry::package_metadata::project_registry_package_metadata;

pub(super) fn build_registry_skill_version(
    markdown: &str,
    options: &IngestSkillOptions,
) -> Result<RegistrySkillVersion, LocalRegistryError> {
    let package_files = normalize_package_files(options.package_files.clone())?;
    let package = validate_registry_skill_package(
        markdown,
        options.profile_document.as_deref(),
        &package_files,
    )?;
    let skill = &package.skill;
    let manifest = package.root_manifest();
    let RegistryPackageDigests {
        digest,
        profile_digest,
        package_digest,
    } = registry_package_digests(markdown, options, &package_files);
    let metadata = project_registry_package_metadata(skill, manifest);
    let defaults = registry_version_defaults(
        &digest,
        profile_digest.as_deref(),
        package_digest.as_deref(),
        options,
    );
    let skill_id = build_skill_id(&defaults.owner, &skill.name)?;
    Ok(RegistrySkillVersion {
        skill_id,
        owner: defaults.owner,
        name: metadata.name,
        description: metadata.description,
        category: metadata.category,
        source_category: metadata.source_category,
        version: defaults.version,
        digest,
        signed_manifest: None,
        markdown: markdown.to_owned(),
        profile_document: options.profile_document.clone(),
        profile_digest,
        package_files,
        package_digest,
        runner_names: metadata.runner_names,
        source_type: metadata.source_type,
        trust_tier: defaults.trust_tier,
        maturity: initial_registry_maturity(),
        catalog_kind: Some(metadata.catalog_kind),
        catalog_audience: Some(metadata.catalog_audience),
        catalog_visibility: Some(metadata.catalog_visibility),
        source_metadata: defaults.source_metadata,
        attestations: defaults.attestations,
        required_scopes: metadata.required_scopes,
        runtime: metadata.runtime,
        auth: metadata.auth,
        risk: metadata.risk,
        runx: metadata.runx,
        tags: metadata.tags,
        harness_cases: metadata.harness_cases,
        publisher: defaults.publisher,
        created_at: defaults.created_at,
        updated_at: now_iso8601(),
    })
}

fn initial_registry_maturity() -> MaturityTier {
    // Alpha is the creation floor. Publish and harness-seal events recompute
    // maturity from evidence; reads never mutate it.
    MaturityTier::Alpha
}

struct RegistryPackageDigests {
    digest: String,
    profile_digest: Option<String>,
    package_digest: Option<String>,
}

fn registry_package_digests(
    markdown: &str,
    options: &IngestSkillOptions,
    package_files: &[RegistryPackageFile],
) -> RegistryPackageDigests {
    RegistryPackageDigests {
        digest: sha256_hex(markdown.as_bytes()),
        profile_digest: options
            .profile_document
            .as_ref()
            .map(|document| sha256_hex(document.as_bytes())),
        package_digest: registry_package_digest(package_files),
    }
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
    package_digest: Option<&str>,
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
        let seed = default_registry_version_seed(digest, profile_digest, package_digest);
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

// Function rationale: normalization validates the package digest,
// manifest, and registry row in one pass over the submitted version payload.
pub(super) fn normalize_registry_skill_version(
    payload: RegistrySkillVersionPayload,
) -> Result<RegistrySkillVersion, LocalRegistryError> {
    let governance = normalize_registry_version_governance(&payload)?;
    let package_files = normalize_package_files(payload.package_files.unwrap_or_default())?;
    let computed_package_digest = registry_package_digest(&package_files);
    if let (Some(declared), Some(computed)) = (&payload.package_digest, &computed_package_digest)
        && declared != computed
    {
        return Err(LocalRegistryError::InvalidVersionPayload {
            field: "registry_version.package_digest".to_owned(),
            message: format!("declared digest {declared} does not match package files {computed}"),
        });
    }
    if payload.package_digest.is_some() && computed_package_digest.is_none() {
        return Err(LocalRegistryError::InvalidVersionPayload {
            field: "registry_version.package_digest".to_owned(),
            message: "declared without package_files".to_owned(),
        });
    }
    let markdown = required_string(payload.markdown, "registry_version.markdown")?;
    let package = validate_registry_skill_package(
        &markdown,
        payload.profile_document.as_deref(),
        &package_files,
    )?;
    let category = payload
        .category
        .or_else(|| package.skill.runx_category.clone());
    let source_category = payload
        .source_category
        .or_else(|| package.skill.category.clone());

    Ok(RegistrySkillVersion {
        skill_id: required_string(payload.skill_id, "registry_version.skill_id")?,
        owner: governance.owner,
        name: required_string(payload.name, "registry_version.name")?,
        description: payload.description,
        category,
        source_category,
        version: required_string(payload.version, "registry_version.version")?,
        digest: required_string(payload.digest, "registry_version.digest")?,
        signed_manifest: payload.signed_manifest,
        markdown,
        profile_document: payload.profile_document,
        profile_digest: payload.profile_digest,
        package_files,
        package_digest: payload.package_digest.or(computed_package_digest),
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
        harness_cases: payload.harness_cases.unwrap_or_default(),
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
            Some("system") => runx_parser::CatalogAudience::System,
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
        execution: None,
        completion: None,
        requires_adapter: None,
        approval: None,
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct RegistrySkillVersionPayload {
    skill_id: Option<String>,
    owner: Option<String>,
    name: Option<String>,
    description: Option<String>,
    category: Option<String>,
    source_category: Option<String>,
    version: Option<String>,
    digest: Option<String>,
    signed_manifest: Option<super::super::types::RegistrySignedManifest>,
    markdown: Option<String>,
    profile_document: Option<String>,
    profile_digest: Option<String>,
    package_files: Option<Vec<RegistryPackageFile>>,
    package_digest: Option<String>,
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
    harness_cases: Option<Vec<super::super::RegistryHarnessCaseMetadata>>,
    publisher: Option<RegistryPublisher>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

pub(super) fn default_registry_version_seed(
    markdown_digest: &str,
    profile_digest: Option<&str>,
    package_digest: Option<&str>,
) -> String {
    match (profile_digest, package_digest) {
        (None, None) => markdown_digest.to_owned(),
        _ => sha256_hex(
            format!(
                "{{\"markdown_digest\":\"{markdown_digest}\",\"package_digest\":\"{}\",\"profile_digest\":\"{}\"}}",
                package_digest.unwrap_or(""),
                profile_digest.unwrap_or("")
            )
            .as_bytes(),
        ),
    }
}

fn normalize_package_files(
    files: Vec<RegistryPackageFile>,
) -> Result<Vec<RegistryPackageFile>, LocalRegistryError> {
    normalize_registry_package_files(files).map_err(|message| {
        LocalRegistryError::InvalidVersionPayload {
            field: "registry_version.package_files".to_owned(),
            message,
        }
    })
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

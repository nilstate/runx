// rust-style-allow: large-file because the registry response parser keeps
// payload shapes next to their field-path contract errors for review.
use serde_json::{Map, Value};

use super::http::RegistryClientError;
use super::types::{
    AcquiredRegistrySkill, ProfileMode, RegistryAttestation, RegistryManifestSignature,
    RegistryManifestSigner, RegistryPackageFile, RegistryPublisher, RegistrySearchResult,
    RegistrySignedManifest, RegistrySkillDetail, RegistrySourceMetadata, TrustTier,
};

pub(crate) fn parse_search(
    route: &str,
    payload: &Value,
) -> Result<Vec<RegistrySearchResult>, RegistryClientError> {
    let record = object(payload, route, "$")?;
    require_literal_status(record, route)?;
    let skills = array(required(record, "skills", route, "$")?, route, "$.skills")?;
    skills
        .iter()
        .enumerate()
        .map(|entry| {
            let path = format!("$.skills[{entry}]", entry = entry.0);
            let skill = object(entry.1, route, &path)?;
            Ok(RegistrySearchResult {
                skill_id: string_field(skill, "skill_id", route, &path)?,
                name: string_field(skill, "name", route, &path)?,
                summary: optional_string_field(skill, "description", route, &path)?,
                owner: string_field(skill, "owner", route, &path)?,
                version: optional_string_field(skill, "version", route, &path)?,
                digest: optional_string_field(skill, "digest", route, &path)?,
                source: optional_string_field(skill, "source", route, &path)?,
                source_label: optional_string_field(skill, "source_label", route, &path)?,
                source_type: string_field(skill, "source_type", route, &path)?,
                profile_mode: profile_mode_field(skill, "profile_mode", route, &path)?,
                runner_names: string_array_field(skill, "runner_names", route, &path)?,
                profile_digest: optional_string_field(skill, "profile_digest", route, &path)?,
                profile_trust_tier: optional_trust_tier_field(
                    skill,
                    "profile_trust_tier",
                    route,
                    &path,
                )?,
                required_scopes: string_array_field(skill, "required_scopes", route, &path)?,
                tags: string_array_field(skill, "tags", route, &path)?,
                trust_tier: trust_tier_field(skill, "trust_tier", route, &path)?,
                trust_signals: trust_signals_field(skill, "trust_signals", route, &path)?,
                install_command: string_field(skill, "install_command", route, &path)?,
                run_command: string_field(skill, "run_command", route, &path)?,
            })
        })
        .collect()
}

pub(crate) fn parse_read(
    route: &str,
    payload: &Value,
) -> Result<RegistrySkillDetail, RegistryClientError> {
    let record = object(payload, route, "$")?;
    require_literal_status(record, route)?;
    let skill = object(required(record, "skill", route, "$")?, route, "$.skill")?;
    Ok(RegistrySkillDetail {
        skill_id: string_field(skill, "skill_id", route, "$.skill")?,
        owner: string_field(skill, "owner", route, "$.skill")?,
        name: string_field(skill, "name", route, "$.skill")?,
        description: optional_string_field(skill, "description", route, "$.skill")?,
        version: string_field(skill, "version", route, "$.skill")?,
        digest: string_field(skill, "digest", route, "$.skill")?,
        signed_manifest: signed_manifest_field(skill, "signed_manifest", route, "$.skill")?,
        markdown: string_field(skill, "markdown", route, "$.skill")?,
        profile_digest: optional_string_field(skill, "profile_digest", route, "$.skill")?,
        package_files: package_files_field(skill, "package_files", route, "$.skill")?,
        package_digest: optional_string_field(skill, "package_digest", route, "$.skill")?,
        runner_names: string_array_field(skill, "runner_names", route, "$.skill")?,
        source_type: string_field(skill, "source_type", route, "$.skill")?,
        trust_tier: trust_tier_field(skill, "trust_tier", route, "$.skill")?,
        required_scopes: string_array_field(skill, "required_scopes", route, "$.skill")?,
        tags: string_array_field(skill, "tags", route, "$.skill")?,
        publisher: publisher_field(skill, "publisher", route, "$.skill")?,
        source_metadata: source_metadata_field(skill, "source_metadata", route, "$.skill")?,
        attestations: attestations_field(skill, "attestations", route, "$.skill")?,
        install_command: string_field(skill, "install_command", route, "$.skill")?,
        run_command: string_field(skill, "run_command", route, "$.skill")?,
    })
}

pub(crate) fn parse_acquire(
    route: &str,
    payload: &Value,
) -> Result<AcquiredRegistrySkill, RegistryClientError> {
    let record = object(payload, route, "$")?;
    require_literal_status(record, route)?;
    let install_count = u64_field(record, "install_count", route, "$")?;
    let acquisition = object(
        required(record, "acquisition", route, "$")?,
        route,
        "$.acquisition",
    )?;
    Ok(AcquiredRegistrySkill {
        skill_id: string_field(acquisition, "skill_id", route, "$.acquisition")?,
        owner: string_field(acquisition, "owner", route, "$.acquisition")?,
        name: string_field(acquisition, "name", route, "$.acquisition")?,
        version: string_field(acquisition, "version", route, "$.acquisition")?,
        digest: string_field(acquisition, "digest", route, "$.acquisition")?,
        signed_manifest: signed_manifest_field(
            acquisition,
            "signed_manifest",
            route,
            "$.acquisition",
        )?,
        markdown: string_field(acquisition, "markdown", route, "$.acquisition")?,
        profile_document: optional_string_field(
            acquisition,
            "profile_document",
            route,
            "$.acquisition",
        )?,
        profile_digest: optional_string_field(
            acquisition,
            "profile_digest",
            route,
            "$.acquisition",
        )?,
        package_files: package_files_field(acquisition, "package_files", route, "$.acquisition")?,
        package_digest: optional_string_field(
            acquisition,
            "package_digest",
            route,
            "$.acquisition",
        )?,
        runner_names: string_array_field(acquisition, "runner_names", route, "$.acquisition")?,
        trust_tier: trust_tier_field(acquisition, "trust_tier", route, "$.acquisition")?,
        publisher: publisher_field(acquisition, "publisher", route, "$.acquisition")?,
        source_metadata: source_metadata_field(
            acquisition,
            "source_metadata",
            route,
            "$.acquisition",
        )?,
        attestations: attestations_field(acquisition, "attestations", route, "$.acquisition")?,
        install_count,
    })
}

fn require_literal_status(
    record: &Map<String, Value>,
    route: &str,
) -> Result<(), RegistryClientError> {
    match record.get("status").and_then(Value::as_str) {
        Some("success") => Ok(()),
        Some(_) | None => Err(contract_error(
            route,
            "$.status",
            "expected literal 'success'",
        )),
    }
}

fn required<'a>(
    record: &'a Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<&'a Value, RegistryClientError> {
    record
        .get(field)
        .ok_or_else(|| contract_error(route, &format!("{path}.{field}"), "missing required field"))
}

fn object<'a>(
    value: &'a Value,
    route: &str,
    path: &str,
) -> Result<&'a Map<String, Value>, RegistryClientError> {
    value
        .as_object()
        .ok_or_else(|| contract_error(route, path, "expected object"))
}

fn array<'a>(
    value: &'a Value,
    route: &str,
    path: &str,
) -> Result<&'a Vec<Value>, RegistryClientError> {
    value
        .as_array()
        .ok_or_else(|| contract_error(route, path, "expected array"))
}

fn string_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<String, RegistryClientError> {
    required(record, field, route, path)?
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| contract_error(route, &format!("{path}.{field}"), "expected string"))
}

fn optional_string_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<Option<String>, RegistryClientError> {
    match record.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .map(|inner| Some(inner.to_owned()))
            .ok_or_else(|| contract_error(route, &format!("{path}.{field}"), "expected string")),
    }
}

fn u64_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<u64, RegistryClientError> {
    required(record, field, route, path)?
        .as_u64()
        .ok_or_else(|| {
            contract_error(
                route,
                &format!("{path}.{field}"),
                "expected unsigned integer",
            )
        })
}

fn bool_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<bool, RegistryClientError> {
    required(record, field, route, path)?
        .as_bool()
        .ok_or_else(|| contract_error(route, &format!("{path}.{field}"), "expected boolean"))
}

fn string_array_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<Vec<String>, RegistryClientError> {
    let base = format!("{path}.{field}");
    array(required(record, field, route, path)?, route, &base)?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            value.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                contract_error(route, &format!("{base}[{index}]"), "expected string")
            })
        })
        .collect()
}

fn package_files_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<Vec<RegistryPackageFile>, RegistryClientError> {
    let Some(value) = record.get(field) else {
        return Ok(Vec::new());
    };
    let base = format!("{path}.{field}");
    array(value, route, &base)?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let file = object(value, route, &format!("{base}[{index}]"))?;
            Ok(RegistryPackageFile {
                path: string_field(file, "path", route, &format!("{base}[{index}]"))?,
                content: string_field(file, "content", route, &format!("{base}[{index}]"))?,
            })
        })
        .collect()
}

fn trust_tier_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<TrustTier, RegistryClientError> {
    match string_field(record, field, route, path)?.as_str() {
        "first_party" => Ok(TrustTier::FirstParty),
        "verified" => Ok(TrustTier::Verified),
        "community" => Ok(TrustTier::Community),
        _ => Err(contract_error(
            route,
            &format!("{path}.{field}"),
            "expected first_party, verified, or community",
        )),
    }
}

fn optional_trust_tier_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<Option<TrustTier>, RegistryClientError> {
    match record.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => trust_tier_field(record, field, route, path).map(Some),
    }
}

fn profile_mode_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<ProfileMode, RegistryClientError> {
    match string_field(record, field, route, path)?.as_str() {
        "portable" => Ok(ProfileMode::Portable),
        "profiled" => Ok(ProfileMode::Profiled),
        _ => Err(contract_error(
            route,
            &format!("{path}.{field}"),
            "expected portable or profiled",
        )),
    }
}

fn trust_signals_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<Vec<super::types::TrustSignal>, RegistryClientError> {
    let Some(value) = record.get(field) else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let base = format!("{path}.{field}");
    array(value, route, &base)?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let item_path = format!("{base}[{index}]");
            let item = object(value, route, &item_path)?;
            Ok(super::types::TrustSignal {
                id: string_field(item, "id", route, &item_path)?,
                label: string_field(item, "label", route, &item_path)?,
                status: string_field(item, "status", route, &item_path)?,
                value: string_field(item, "value", route, &item_path)?,
            })
        })
        .collect()
}

fn publisher_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<RegistryPublisher, RegistryClientError> {
    let field_path = format!("{path}.{field}");
    let publisher = object(required(record, field, route, path)?, route, &field_path)?;
    Ok(RegistryPublisher {
        kind: string_field(publisher, "kind", route, &field_path)?,
        id: string_field(publisher, "id", route, &field_path)?,
        handle: optional_string_field(publisher, "handle", route, &field_path)?,
        display_name: optional_string_field(publisher, "display_name", route, &field_path)?,
    })
}

fn signed_manifest_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<Option<RegistrySignedManifest>, RegistryClientError> {
    let Some(value) = record.get(field) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let field_path = format!("{path}.{field}");
    let manifest = object(value, route, &field_path)?;
    let signer_path = format!("{field_path}.signer");
    let signer = object(
        required(manifest, "signer", route, &field_path)?,
        route,
        &signer_path,
    )?;
    let signature_path = format!("{field_path}.signature");
    let signature = object(
        required(manifest, "signature", route, &field_path)?,
        route,
        &signature_path,
    )?;
    Ok(Some(RegistrySignedManifest {
        schema: string_field(manifest, "schema", route, &field_path)?,
        skill_id: string_field(manifest, "skill_id", route, &field_path)?,
        version: string_field(manifest, "version", route, &field_path)?,
        digest: string_field(manifest, "digest", route, &field_path)?,
        profile_digest: optional_string_field(manifest, "profile_digest", route, &field_path)?,
        package_digest: optional_string_field(manifest, "package_digest", route, &field_path)?,
        signer: RegistryManifestSigner {
            id: string_field(signer, "id", route, &signer_path)?,
            key_id: string_field(signer, "key_id", route, &signer_path)?,
        },
        signature: RegistryManifestSignature {
            alg: string_field(signature, "alg", route, &signature_path)?,
            value: string_field(signature, "value", route, &signature_path)?,
        },
    }))
}

fn attestations_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<Vec<RegistryAttestation>, RegistryClientError> {
    let base = format!("{path}.{field}");
    array(required(record, field, route, path)?, route, &base)?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let item_path = format!("{base}[{index}]");
            let item = object(value, route, &item_path)?;
            Ok(RegistryAttestation {
                kind: string_field(item, "kind", route, &item_path)?,
                id: string_field(item, "id", route, &item_path)?,
                status: string_field(item, "status", route, &item_path)?,
                summary: string_field(item, "summary", route, &item_path)?,
                source: optional_string_field(item, "source", route, &item_path)?,
                issued_at: optional_string_field(item, "issued_at", route, &item_path)?,
                metadata: optional_json_field(item, "metadata", route, &item_path)?,
            })
        })
        .collect()
}

fn source_metadata_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<Option<RegistrySourceMetadata>, RegistryClientError> {
    let Some(value) = record.get(field) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let field_path = format!("{path}.{field}");
    let source = object(value, route, &field_path)?;
    Ok(Some(RegistrySourceMetadata {
        provider: string_field(source, "provider", route, &field_path)?,
        repo: string_field(source, "repo", route, &field_path)?,
        repo_url: string_field(source, "repo_url", route, &field_path)?,
        skill_path: string_field(source, "skill_path", route, &field_path)?,
        profile_path: optional_string_field(source, "profile_path", route, &field_path)?,
        r#ref: string_field(source, "ref", route, &field_path)?,
        sha: string_field(source, "sha", route, &field_path)?,
        default_branch: string_field(source, "default_branch", route, &field_path)?,
        event: string_field(source, "event", route, &field_path)?,
        immutable: bool_field(source, "immutable", route, &field_path)?,
        live: bool_field(source, "live", route, &field_path)?,
        tombstoned: optional_bool_field(source, "tombstoned", route, &field_path)?,
        tag: optional_string_field(source, "tag", route, &field_path)?,
        publisher_handle: optional_string_field(source, "publisher_handle", route, &field_path)?,
    }))
}

fn optional_bool_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<Option<bool>, RegistryClientError> {
    match record.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(|| contract_error(route, &format!("{path}.{field}"), "expected boolean")),
    }
}

fn optional_json_field(
    record: &Map<String, Value>,
    field: &str,
    route: &str,
    path: &str,
) -> Result<Option<runx_contracts::JsonValue>, RegistryClientError> {
    match record.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| contract_error(route, &format!("{path}.{field}"), &error.to_string())),
    }
}

fn contract_error(route: &str, field_path: &str, message: &str) -> RegistryClientError {
    RegistryClientError::Contract {
        route: route.to_owned(),
        field_path: field_path.to_owned(),
        message: message.to_owned(),
    }
}

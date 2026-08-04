use runx_contracts::{JsonObject, JsonValue};
use runx_parser::{CatalogMetadata, SkillRunnerManifest, ValidatedSkill};
use serde::{Deserialize, Serialize};

/// Parser-owned package metadata persisted by registry implementations.
///
/// This projection is deliberately produced by the native package validator.
/// Registry clients may store it, but must not reconstruct execution semantics
/// by parsing `SKILL.md` or `X.yaml` independently.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryPackageMetadata {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_category: Option<String>,
    pub runner_names: Vec<String>,
    pub source_type: String,
    pub catalog_kind: String,
    pub catalog_audience: String,
    pub catalog_visibility: String,
    pub required_scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runx: Option<JsonObject>,
    pub tags: Vec<String>,
    pub harness_cases: Vec<RegistryHarnessCaseMetadata>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryHarnessCaseMetadata {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_status: Option<String>,
}

pub(crate) fn project_registry_package_metadata(
    skill: &ValidatedSkill,
    manifest: Option<&SkillRunnerManifest>,
) -> RegistryPackageMetadata {
    let catalog = registry_catalog(manifest);
    RegistryPackageMetadata {
        name: skill.name.clone(),
        description: skill.description.clone(),
        category: skill.runx_category.clone(),
        source_category: skill.category.clone(),
        runner_names: registry_runner_names(manifest),
        source_type: registry_source_type(manifest),
        catalog_kind: catalog.kind.as_str().to_owned(),
        catalog_audience: catalog.audience.as_str().to_owned(),
        catalog_visibility: catalog.visibility.as_str().to_owned(),
        required_scopes: registry_required_scopes(manifest),
        runtime: registry_runtime(manifest),
        auth: selected_registry_runner(manifest).and_then(|runner| runner.auth.clone()),
        risk: registry_risk(manifest),
        runx: skill.runx.clone(),
        tags: registry_tags(skill, manifest),
        harness_cases: registry_harness_cases(manifest),
    }
}

fn registry_harness_cases(
    manifest: Option<&SkillRunnerManifest>,
) -> Vec<RegistryHarnessCaseMetadata> {
    manifest
        .and_then(|manifest| manifest.harness.as_ref())
        .into_iter()
        .flat_map(|harness| &harness.cases)
        .map(|case| RegistryHarnessCaseMetadata {
            name: case.name.clone(),
            runner: case.runner.clone(),
            expected_status: case.expect.status.as_ref().map(|status| {
                match status {
                    runx_parser::harness_fixture::HarnessExpectedStatus::Sealed => "sealed",
                    runx_parser::harness_fixture::HarnessExpectedStatus::Failure => "failure",
                    runx_parser::harness_fixture::HarnessExpectedStatus::NeedsAgent => {
                        "needs_agent"
                    }
                    runx_parser::harness_fixture::HarnessExpectedStatus::PolicyDenied => {
                        "policy_denied"
                    }
                    runx_parser::harness_fixture::HarnessExpectedStatus::Escalated => "escalated",
                }
                .to_owned()
            }),
        })
        .collect()
}

pub(crate) fn registry_catalog(manifest: Option<&SkillRunnerManifest>) -> CatalogMetadata {
    manifest
        .and_then(|manifest| manifest.catalog.clone())
        .unwrap_or(CatalogMetadata {
            kind: runx_parser::CatalogKind::Skill,
            audience: runx_parser::CatalogAudience::Public,
            visibility: runx_parser::CatalogVisibility::Public,
            role: runx_parser::CatalogRole::Context,
            canonical_skill: None,
            provider: None,
            runtime_path: None,
            part_of: Vec::new(),
            execution: None,
            completion: None,
            requires_adapter: None,
            approval: None,
        })
}

fn registry_runner_names(manifest: Option<&SkillRunnerManifest>) -> Vec<String> {
    manifest
        .map(|manifest| manifest.runners.keys().cloned().collect())
        .unwrap_or_default()
}

fn registry_required_scopes(manifest: Option<&SkillRunnerManifest>) -> Vec<String> {
    unique(
        manifest
            .into_iter()
            .flat_map(|manifest| manifest.runners.values())
            .flat_map(runx_parser::SkillRunnerDefinition::declared_scopes)
            .collect(),
    )
}

fn registry_runtime(manifest: Option<&SkillRunnerManifest>) -> Option<JsonValue> {
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

fn registry_risk(manifest: Option<&SkillRunnerManifest>) -> Option<JsonValue> {
    selected_registry_runner(manifest).and_then(|runner| runner.risk.clone())
}

fn registry_tags(skill: &ValidatedSkill, manifest: Option<&SkillRunnerManifest>) -> Vec<String> {
    unique(
        tags_from(skill.runx.as_ref())
            .into_iter()
            .chain(skill.runx_category.clone())
            .chain(
                manifest
                    .into_iter()
                    .flat_map(|manifest| manifest.runners.values())
                    .flat_map(|runner| tags_from(runner.runx.as_ref())),
            )
            .collect(),
    )
}

fn registry_source_type(manifest: Option<&SkillRunnerManifest>) -> String {
    selected_registry_runner(manifest)
        .map(|runner| runner.source.source_type.as_str().to_owned())
        .unwrap_or_else(|| {
            if manifest.is_some_and(|manifest| !manifest.runners.is_empty()) {
                "multi-runner".to_owned()
            } else {
                "manual".to_owned()
            }
        })
}

fn selected_registry_runner(
    manifest: Option<&SkillRunnerManifest>,
) -> Option<&runx_parser::SkillRunnerDefinition> {
    let manifest = manifest?;
    manifest
        .runners
        .values()
        .find(|runner| runner.default)
        .or_else(|| {
            (manifest.runners.len() == 1)
                .then(|| manifest.runners.values().next())
                .flatten()
        })
}

fn tags_from(value: Option<&JsonObject>) -> Vec<String> {
    let Some(JsonValue::Array(values)) = value.and_then(|value| value.get("tags")) else {
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

fn unique(values: Vec<String>) -> Vec<String> {
    let mut unique_values = Vec::new();
    for value in values {
        if !unique_values.contains(&value) {
            unique_values.push(value);
        }
    }
    unique_values
}

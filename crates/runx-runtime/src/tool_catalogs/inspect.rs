use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use runx_contracts::tools::{
    JsonPayload, RuntimeCommand, ToolBuildStatus, ToolInput, ToolInspectImportedFrom,
    ToolInspectOrigin, ToolInspectProvenance, ToolInspectReport, ToolInspectResult,
    ToolInspectRunx,
};

use runx_contracts::sha256_hex;

use super::error::ToolCatalogError;
use super::search::{FixtureTool, fixture_catalog_allowed, fixture_tool};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolInspectOptions {
    pub root: PathBuf,
    pub tool_ref: String,
    pub source: Option<String>,
    pub search_from_directory: PathBuf,
    pub tool_roots: Vec<PathBuf>,
    pub fixture_catalog_enabled: bool,
    pub allow_explicit_manifest_path: bool,
}

#[derive(Clone, Debug)]
pub struct LocalToolResolution {
    pub manifest_path: PathBuf,
    pub tool: runx_parser::ValidatedTool,
}

pub fn inspect_tool(options: &ToolInspectOptions) -> Result<ToolInspectReport, ToolCatalogError> {
    match resolve_local_manifest(options) {
        Ok(manifest_path) => {
            let tool = read_local_tool_manifest(&manifest_path)?;
            return Ok(ToolInspectReport {
                status: ToolBuildStatus::Success,
                tool: inspect_local_tool(options, &manifest_path, tool)?,
            });
        }
        Err(ToolCatalogError::NotFound(_)) => {}
        Err(error) => return Err(error),
    }

    if let Some(tool) = resolve_fixture_tool(options) {
        return Ok(ToolInspectReport {
            status: ToolBuildStatus::Success,
            tool: inspect_fixture_tool(&options.tool_ref, &tool, &options.root),
        });
    }

    Err(ToolCatalogError::NotFound(format!(
        "Tool '{}' was not found in configured tool roots.",
        options.tool_ref
    )))
}

pub fn resolve_local_tool(
    options: &ToolInspectOptions,
) -> Result<LocalToolResolution, ToolCatalogError> {
    let manifest_path = resolve_local_manifest(options)?;
    let tool = read_local_tool_manifest(&manifest_path)?;
    Ok(LocalToolResolution {
        manifest_path,
        tool,
    })
}

fn resolve_fixture_tool(options: &ToolInspectOptions) -> Option<FixtureTool> {
    let normalized_source = options
        .source
        .as_deref()
        .map(|source| source.trim().to_ascii_lowercase());

    if !fixture_catalog_allowed(
        options.fixture_catalog_enabled,
        normalized_source.as_deref(),
    ) {
        return None;
    }
    fixture_tool(&options.tool_ref)
}

fn read_local_tool_manifest(
    manifest_path: &Path,
) -> Result<runx_parser::ValidatedTool, ToolCatalogError> {
    let manifest_source = fs::read_to_string(manifest_path)
        .map_err(|error| ToolCatalogError::io("reading tool manifest", manifest_path, error))?;
    let raw = runx_parser::parse_tool_manifest_json(&manifest_source).map_err(|error| {
        ToolCatalogError::InvalidManifest {
            path: manifest_path.to_path_buf(),
            message: error.to_string(),
        }
    })?;
    runx_parser::validate_tool_manifest(raw).map_err(|error| ToolCatalogError::InvalidManifest {
        path: manifest_path.to_path_buf(),
        message: error.to_string(),
    })
}

fn inspect_local_tool(
    options: &ToolInspectOptions,
    manifest_path: &Path,
    tool: runx_parser::ValidatedTool,
) -> Result<ToolInspectResult, ToolCatalogError> {
    Ok(ToolInspectResult {
        tool_ref: options.tool_ref.clone(),
        name: tool.name,
        description: tool.description,
        execution_source_type: tool.source.source_type.as_str().to_owned(),
        inputs: convert_inputs(tool.inputs)?,
        scopes: tool.scopes,
        mutating: tool.mutating,
        runtime: convert_optional_runtime(tool.runtime)?,
        risk: convert_optional_json(tool.risk)?,
        runx: convert_optional_object(tool.runx)?,
        reference_path: display_path(manifest_path),
        skill_directory: manifest_path
            .parent()
            .map(display_path)
            .unwrap_or_else(|| ".".to_owned()),
        provenance: local_provenance(),
    })
}

fn local_provenance() -> ToolInspectProvenance {
    ToolInspectProvenance {
        origin: ToolInspectOrigin::Local,
        source: None,
        source_label: None,
        source_type: None,
        namespace: None,
        external_name: None,
        catalog_ref: None,
        tool_id: None,
        tags: None,
    }
}

fn inspect_fixture_tool(tool_ref: &str, tool: &FixtureTool, root: &Path) -> ToolInspectResult {
    ToolInspectResult {
        tool_ref: tool_ref.to_owned(),
        name: tool.qualified_name(),
        description: tool.description.map(str::to_owned),
        execution_source_type: "catalog".to_owned(),
        inputs: fixture_inputs(tool),
        scopes: vec![tool.qualified_name()],
        mutating: None,
        runtime: None,
        risk: None,
        runx: Some(imported_runx(tool)),
        reference_path: format!("catalog:{}:{}", tool.source, tool.qualified_name()),
        skill_directory: display_path(root),
        provenance: ToolInspectProvenance {
            origin: ToolInspectOrigin::Imported,
            source: Some(tool.source.to_owned()),
            source_label: Some(tool.source_label.to_owned()),
            source_type: Some(tool.source_type.to_owned()),
            namespace: Some(tool.namespace.to_owned()),
            external_name: Some(tool.external_name.to_owned()),
            catalog_ref: Some(tool.catalog_ref()),
            tool_id: Some(tool.tool_id()),
            tags: Some(tool.tags.iter().map(|tag| (*tag).to_owned()).collect()),
        },
    }
}

fn fixture_inputs(tool: &FixtureTool) -> BTreeMap<String, ToolInput> {
    tool.inputs
        .iter()
        .map(|input| {
            (
                input.name.to_owned(),
                ToolInput {
                    input_type: input.input_type.to_owned(),
                    required: input.required,
                    description: input.description.map(str::to_owned),
                    default: None,
                    artifact: None,
                },
            )
        })
        .collect()
}

fn imported_runx(tool: &FixtureTool) -> ToolInspectRunx {
    let digest_payload = format!(
        r#"{{"source":"{}","namespace":"{}","external_name":"{}","source_type":"{}"}}"#,
        tool.source, tool.namespace, tool.external_name, tool.source_type
    );
    ToolInspectRunx::Imported {
        imported_from: ToolInspectImportedFrom {
            source: tool.source.to_owned(),
            source_label: tool.source_label.to_owned(),
            source_type: tool.source_type.to_owned(),
            namespace: tool.namespace.to_owned(),
            external_name: tool.external_name.to_owned(),
            digest: sha256_hex(digest_payload.as_bytes()),
        },
    }
}

fn resolve_local_manifest(options: &ToolInspectOptions) -> Result<PathBuf, ToolCatalogError> {
    if options.allow_explicit_manifest_path
        && let Some(path) =
            explicit_manifest_path(&options.tool_ref, &options.search_from_directory)?
    {
        return Ok(path);
    }

    let segments = tool_ref_segments(&options.tool_ref)?;
    for root in resolve_tool_roots(options) {
        let manifest = root
            .join(segments.iter().collect::<PathBuf>())
            .join("manifest.json");
        if manifest.exists() {
            return Ok(manifest);
        }
    }

    Err(ToolCatalogError::NotFound(format!(
        "Tool '{}' was not found in configured tool roots.",
        options.tool_ref
    )))
}

fn explicit_manifest_path(
    tool_ref: &str,
    search_from_directory: &Path,
) -> Result<Option<PathBuf>, ToolCatalogError> {
    let candidate = Path::new(tool_ref);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(ToolCatalogError::InvalidRequest(
            "Explicit tool manifest paths must be relative and must not contain '..'.".to_owned(),
        ));
    }
    let resolved = search_from_directory.join(candidate);
    if resolved.is_file() {
        return Ok(Some(resolved));
    }
    let manifest = resolved.join("manifest.json");
    if manifest.is_file() {
        return Ok(Some(manifest));
    }
    Ok(None)
}

fn tool_ref_segments(tool_ref: &str) -> Result<Vec<&str>, ToolCatalogError> {
    let segments = tool_ref
        .split('.')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.len() < 2 {
        return Err(ToolCatalogError::InvalidRequest(format!(
            "Tool '{tool_ref}' must include a namespace, for example fs.read."
        )));
    }
    Ok(segments)
}

fn resolve_tool_roots(options: &ToolInspectOptions) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    push_existing_dirs(&mut roots, options.tool_roots.iter().cloned());
    push_existing_dirs(&mut roots, [options.root.join("tools")]);
    let root = options.root.as_path();
    let mut current = options.search_from_directory.clone();
    if !current.starts_with(root) {
        return roots;
    }
    loop {
        push_existing_dirs(&mut roots, [current.join(".runx/tools")]);
        if current == root {
            break;
        }
        let Some(parent) = current.parent().map(Path::to_path_buf) else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    roots
}

fn push_existing_dirs(roots: &mut Vec<PathBuf>, candidates: impl IntoIterator<Item = PathBuf>) {
    for candidate in candidates {
        if candidate.is_dir() && !roots.iter().any(|root| root == &candidate) {
            roots.push(candidate);
        }
    }
}

fn convert_inputs(
    inputs: BTreeMap<String, runx_parser::SkillInput>,
) -> Result<BTreeMap<String, ToolInput>, ToolCatalogError> {
    inputs
        .into_iter()
        .map(|(name, input)| {
            Ok((
                name,
                ToolInput {
                    input_type: input.input_type,
                    required: input.required,
                    description: input.description,
                    default: convert_optional_json(input.default)?,
                    artifact: None,
                },
            ))
        })
        .collect()
}

fn convert_optional_object(
    value: Option<runx_contracts::JsonObject>,
) -> Result<Option<ToolInspectRunx>, ToolCatalogError> {
    value
        .map(|value| convert_json(runx_contracts::JsonValue::Object(value)))
        .transpose()?
        .map(|value| match value {
            JsonPayload::Object(object) => Ok(ToolInspectRunx::Object(object)),
            _ => Err(ToolCatalogError::InvalidRequest(
                "expected JSON object while converting tool metadata".to_owned(),
            )),
        })
        .transpose()
}

fn convert_optional_runtime(
    value: Option<runx_contracts::JsonValue>,
) -> Result<Option<RuntimeCommand>, ToolCatalogError> {
    value
        .map(|value| {
            let json = serde_json::to_string(&value)
                .map_err(|error| ToolCatalogError::InvalidRequest(error.to_string()))?;
            serde_json::from_str(&json)
                .map_err(|error| ToolCatalogError::InvalidRequest(error.to_string()))
        })
        .transpose()
}

fn convert_optional_json(
    value: Option<runx_contracts::JsonValue>,
) -> Result<Option<JsonPayload>, ToolCatalogError> {
    value.map(convert_json).transpose()
}

fn convert_json(value: runx_contracts::JsonValue) -> Result<JsonPayload, ToolCatalogError> {
    let json = serde_json::to_string(&value)
        .map_err(|error| ToolCatalogError::InvalidRequest(error.to_string()))?;
    serde_json::from_str(&json).map_err(|error| ToolCatalogError::InvalidRequest(error.to_string()))
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

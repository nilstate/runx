// rust-style-allow: large-file because the skill catalog adapter, its source
// resolution, artifact projection, and the catalog-coverage tests form one
// cohesive unit; splitting them would fracture how a skill is resolved and run.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use runx_contracts::{JsonObject, JsonValue, sha256_hex};
use runx_parser::{SkillArtifactContract, SkillInput, SkillSource};

use crate::RuntimeError;
use crate::adapter::{
    FanoutExecutionMode, InvocationStatus, SkillAdapter, SkillInvocation, SkillOutput,
};
use crate::adapter_pipeline::{AdapterCapture, AdapterProjection};
use crate::adapters::cli_tool::CliToolAdapter;
use crate::credentials::CredentialDelivery;
use crate::json_render::json_number_string;
use crate::tool_catalogs::search::{FixtureTool, fixture_tool};
use crate::tool_catalogs::{ToolCatalogError, ToolInspectOptions, resolve_local_tool};

const MISSING_CATALOG_REF: &str = "Catalog source requires source.catalog_ref metadata.";

#[derive(Clone, Debug, Default)]
pub struct CatalogAdapter {
    fixture_catalog_enabled: bool,
}

impl CatalogAdapter {
    #[must_use]
    pub fn fixture_catalog() -> Self {
        Self {
            fixture_catalog_enabled: true,
        }
    }
}

impl SkillAdapter for CatalogAdapter {
    fn adapter_type(&self) -> &'static str {
        "catalog"
    }

    fn invoke(&self, request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
        let started = Instant::now();
        if request.source.source_type != runx_parser::SourceKind::Catalog {
            return Err(RuntimeError::UnsupportedAdapter {
                adapter_type: request.source.source_type.as_str().to_owned(),
            });
        }
        let Some(catalog_ref) = request.source.catalog_ref.as_deref() else {
            return Ok(failure(MISSING_CATALOG_REF, started));
        };
        let catalog_ref = catalog_ref.trim();
        if catalog_ref.is_empty() {
            return Ok(failure(MISSING_CATALOG_REF, started));
        }

        if let Some(output) = invoke_local_tool(catalog_ref, &request, started)? {
            return Ok(output);
        }
        if !self.fixture_catalog_enabled {
            return Ok(missing_imported_tool(catalog_ref, started));
        }
        let Some(tool) = fixture_tool(catalog_ref) else {
            return Ok(missing_imported_tool(catalog_ref, started));
        };

        Ok(invoke_fixture_tool(
            &tool,
            &request.inputs,
            &request.env,
            started,
        ))
    }

    fn fanout_execution_mode(&self, source: &SkillSource) -> FanoutExecutionMode {
        if source.source_type == runx_parser::SourceKind::Catalog {
            FanoutExecutionMode::IsolatedParallel
        } else {
            FanoutExecutionMode::Serial
        }
    }

    fn clone_for_fanout(&self) -> Option<Box<dyn SkillAdapter + Send + Sync>> {
        Some(Box::new(self.clone()))
    }
}

/// The context needed to resolve a local tool by reference and invoke it. Borrowed
/// so both the catalog adapter (from its `SkillInvocation`) and the managed-agent
/// tool executor (from its run context) can share one resolve-and-invoke path.
pub(crate) struct LocalToolRequest<'a> {
    pub tool_ref: &'a str,
    pub inputs: &'a JsonObject,
    pub resolved_inputs: &'a JsonObject,
    pub env: &'a BTreeMap<String, String>,
    pub skill_directory: &'a Path,
    pub credential_delivery: &'a CredentialDelivery,
    pub skill_name: &'a str,
    pub allow_explicit_manifest_path: bool,
}

fn invoke_local_tool(
    catalog_ref: &str,
    request: &SkillInvocation,
    started: Instant,
) -> Result<Option<SkillOutput>, RuntimeError> {
    resolve_and_invoke_local_tool(
        &LocalToolRequest {
            tool_ref: catalog_ref,
            inputs: &request.inputs,
            resolved_inputs: &request.resolved_inputs,
            env: &request.env,
            skill_directory: &request.skill_directory,
            credential_delivery: &request.credential_delivery,
            skill_name: &request.skill_name,
            allow_explicit_manifest_path: true,
        },
        started,
    )
}

/// Resolve a local tool by reference and invoke it through the governed CLI-tool
/// adapter, applying any artifact wrappers. This is the single resolve-and-invoke
/// path shared by the catalog adapter and the managed-agent tool executor.
/// Returns `Ok(None)` when the reference does not resolve to a local tool.
pub(crate) fn resolve_and_invoke_local_tool(
    request: &LocalToolRequest<'_>,
    started: Instant,
) -> Result<Option<SkillOutput>, RuntimeError> {
    let resolution = match resolve_local_tool(&ToolInspectOptions {
        root: workspace_root(request.env, request.skill_directory),
        tool_ref: request.tool_ref.to_owned(),
        source: None,
        search_from_directory: request.skill_directory.to_path_buf(),
        tool_roots: configured_tool_roots(request.env),
        fixture_catalog_enabled: false,
        allow_explicit_manifest_path: request.allow_explicit_manifest_path,
    }) {
        Ok(resolution) => resolution,
        Err(error) if local_lookup_miss(&error) => return Ok(None),
        Err(error) => return Err(catalog_error(request.skill_name, error)),
    };

    let artifacts = resolution.tool.artifacts.clone();
    let declared_inputs = resolution.tool.inputs.clone();
    let tool_name = resolution.tool.name.clone();
    let source_type = resolution.tool.source.source_type;
    let mut source = resolution.tool.source;
    let tool_directory = manifest_directory(&resolution.manifest_path, request.skill_directory);
    if source_type == runx_parser::SourceKind::CliTool {
        normalize_local_cli_source(&mut source, &tool_directory);
    }
    let invocation = SkillInvocation {
        skill_name: tool_name,
        source,
        inputs: declared_tool_inputs(request.inputs, &declared_inputs),
        resolved_inputs: declared_tool_inputs(request.resolved_inputs, &declared_inputs),
        current_context: Vec::new(),
        skill_directory: tool_directory,
        env: request.env.clone(),
        credential_delivery: request.credential_delivery.clone(),
    };
    let mut output = match source_type {
        runx_parser::SourceKind::CliTool => CliToolAdapter.invoke(invocation)?,
        #[cfg(feature = "http")]
        runx_parser::SourceKind::Http => {
            crate::adapters::http::HttpSkillAdapter.invoke(invocation)?
        }
        other => {
            return Ok(Some(failure(
                format!(
                    "Resolved catalog tool '{}' uses unsupported Rust adapter '{other}'.",
                    invocation.skill_name
                ),
                started,
            )));
        }
    };
    apply_local_tool_artifact_wrappers(&mut output, artifacts.as_ref())?;
    Ok(Some(output))
}

fn declared_tool_inputs(
    inputs: &JsonObject,
    declared: &BTreeMap<String, SkillInput>,
) -> JsonObject {
    declared
        .keys()
        .filter_map(|key| inputs.get(key).cloned().map(|value| (key.clone(), value)))
        .collect()
}

fn apply_local_tool_artifact_wrappers(
    output: &mut SkillOutput,
    artifacts: Option<&SkillArtifactContract>,
) -> Result<(), RuntimeError> {
    let Some(artifacts) = artifacts else {
        return Ok(());
    };
    let Ok(JsonValue::Object(mut object)) = serde_json::from_str::<JsonValue>(&output.stdout)
    else {
        return Ok(());
    };

    let mut changed = false;
    if let Some(wrap_as) = artifacts.wrap_as.as_deref()
        && !object.contains_key(wrap_as)
    {
        let mut wrapper = JsonObject::new();
        wrapper.insert("data".to_owned(), JsonValue::Object(object.clone()));
        object.insert(wrap_as.to_owned(), JsonValue::Object(wrapper));
        changed = true;
    }

    if let Some(named_emits) = &artifacts.named_emits {
        for name in named_emits.keys() {
            let Some(value) = object.get(name).cloned() else {
                continue;
            };
            let mut wrapper = JsonObject::new();
            wrapper.insert("data".to_owned(), value);
            object.insert(name.clone(), JsonValue::Object(wrapper));
            changed = true;
        }
    }

    if changed {
        output.stdout = serde_json::to_string(&JsonValue::Object(object)).map_err(|source| {
            RuntimeError::json("serializing catalog artifact wrappers", source)
        })?;
    }
    Ok(())
}

fn configured_tool_roots(env: &std::collections::BTreeMap<String, String>) -> Vec<PathBuf> {
    env.get("RUNX_TOOL_ROOTS")
        .map(|value| {
            std::env::split_paths(value)
                .filter(|path| !path.as_os_str().is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn workspace_root(env: &std::collections::BTreeMap<String, String>, fallback: &Path) -> PathBuf {
    env.get("RUNX_CWD")
        .or_else(|| env.get("RUNX_PROJECT_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| fallback.to_path_buf())
}

fn local_lookup_miss(error: &ToolCatalogError) -> bool {
    match error {
        ToolCatalogError::NotFound(_) => true,
        ToolCatalogError::InvalidRequest(message) => message.contains("must include a namespace"),
        ToolCatalogError::Io { .. }
        | ToolCatalogError::Json { .. }
        | ToolCatalogError::InvalidManifest { .. } => false,
    }
}

fn catalog_error(skill_name: &str, error: ToolCatalogError) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: skill_name.to_owned(),
        message: error.to_string(),
    }
}

fn manifest_directory(manifest_path: &Path, fallback: &Path) -> PathBuf {
    manifest_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| fallback.to_path_buf())
}

fn normalize_local_cli_source(_source: &mut SkillSource, _skill_directory: &Path) {
    // Leave cwd unset: sandbox resolution already defaults cli-tool execution
    // to the resolved tool directory. Setting cwd to that same relative path
    // makes the sandbox join it twice.
}

fn invoke_fixture_tool(
    tool: &FixtureTool,
    inputs: &JsonObject,
    env: &BTreeMap<String, String>,
    started: Instant,
) -> SkillOutput {
    match tool.name {
        "echo" => success(
            json_string(inputs.get("message")).unwrap_or_default(),
            tool.name,
            started,
        ),
        "env" => success(env_value(inputs.get("name"), env), tool.name, started),
        "fail" => failure_with_metadata(
            format!(
                "MCP error -32000: fixture failure: {}",
                json_string(inputs.get("message")).unwrap_or_default()
            ),
            tool.name,
            started,
        ),
        "sleep" => failure_with_metadata(
            "MCP call timed out after 60000ms.".to_owned(),
            tool.name,
            started,
        ),
        _ => failure_with_metadata(
            format!("MCP error -32601: tool not found: {}", tool.name),
            tool.name,
            started,
        ),
    }
}

fn success(stdout: String, tool_name: &str, started: Instant) -> SkillOutput {
    AdapterProjection::from_started(started).output(
        InvocationStatus::Success,
        AdapterCapture::new(stdout, String::new()),
        Some(0),
        mcp_metadata(tool_name),
    )
}

fn failure(message: impl Into<String>, started: Instant) -> SkillOutput {
    AdapterProjection::from_started(started).failure(message.into(), JsonObject::new())
}

fn failure_with_metadata(message: String, tool_name: &str, started: Instant) -> SkillOutput {
    AdapterProjection::from_started(started).failure(message, mcp_metadata(tool_name))
}

fn missing_imported_tool(catalog_ref: &str, started: Instant) -> SkillOutput {
    failure(
        format!("Imported tool '{catalog_ref}' was not found in configured tool catalogs."),
        started,
    )
}

fn json_string(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(value)) => Some(value.clone()),
        Some(JsonValue::Bool(value)) => Some(value.to_string()),
        Some(JsonValue::Number(value)) => Some(json_number_string(value)),
        Some(JsonValue::Null) | None => None,
        Some(JsonValue::Array(_)) | Some(JsonValue::Object(_)) => {
            Some("[object Object]".to_owned())
        }
    }
}

fn env_value(name: Option<&JsonValue>, env: &BTreeMap<String, String>) -> String {
    let Some(name) = json_string(name) else {
        return String::new();
    };
    env.get(&name).cloned().unwrap_or_default()
}

fn mcp_metadata(tool_name: &str) -> JsonObject {
    let mut mcp = JsonObject::new();
    mcp.insert("tool".to_owned(), JsonValue::String(tool_name.to_owned()));
    mcp.insert(
        "server_command_hash".to_owned(),
        JsonValue::String(sha256_hex(b"runx-runtime-fixture-catalog")),
    );
    mcp.insert(
        "server_args_hash".to_owned(),
        JsonValue::String(sha256_hex(b"[]")),
    );

    let mut metadata = JsonObject::new();
    metadata.insert("mcp".to_owned(), JsonValue::Object(mcp));
    metadata
}

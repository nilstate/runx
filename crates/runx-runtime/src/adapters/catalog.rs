// rust-style-allow: large-file because the skill catalog adapter, its source
// resolution, artifact projection, and the catalog-coverage tests form one
// cohesive unit; splitting them would fracture how a skill is resolved and run.

use std::collections::BTreeMap;
use std::fs;
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
use crate::execution::output_projection::data_envelope;
use crate::json_render::json_number_string;
use crate::tool_catalogs::search::{FixtureTool, fixture_tool};
use crate::tool_catalogs::{ToolCatalogError, ToolInspectOptions, resolve_local_tool};

const MISSING_CATALOG_REF: &str = "Catalog source requires source.catalog_ref metadata.";
const DATA_SOURCE_ROUTER_TOOL_REF: &str = "data.source";
const RUNX_DATA_SOURCES_ENV: &str = "RUNX_DATA_SOURCES";
const PROJECT_DATA_SOURCES_PATH: &str = ".runx/data-sources.json";

#[derive(Clone, Debug)]
struct DataSourceConfigSource {
    value: String,
    required: bool,
}

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
        let Some(catalog_ref) = request.source.catalog_ref.clone() else {
            return Ok(failure(MISSING_CATALOG_REF, started));
        };
        let catalog_ref = catalog_ref.trim().to_owned();
        if catalog_ref.is_empty() {
            return Ok(failure(MISSING_CATALOG_REF, started));
        }

        let mut request = request;
        let catalog_ref = match resolve_data_source_router(&catalog_ref, &mut request) {
            Ok(resolved) => resolved.unwrap_or_else(|| catalog_ref.to_owned()),
            Err(message) => return Ok(failure(message, started)),
        };

        if let Some(output) = invoke_local_tool(&catalog_ref, &request, started)? {
            return Ok(output);
        }
        if !self.fixture_catalog_enabled {
            return Ok(missing_imported_tool(&catalog_ref, started));
        }
        let Some(tool) = fixture_tool(&catalog_ref) else {
            return Ok(missing_imported_tool(&catalog_ref, started));
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

fn resolve_data_source_router(
    catalog_ref: &str,
    request: &mut SkillInvocation,
) -> Result<Option<String>, String> {
    let Some((adapter, binding)) = router_target(
        catalog_ref,
        &request.inputs,
        &request.env,
        &request.skill_directory,
    )?
    else {
        return Ok(None);
    };

    request.inputs.insert(
        "data_source_binding".to_owned(),
        JsonValue::Object(binding.clone()),
    );
    request
        .resolved_inputs
        .insert("data_source_binding".to_owned(), JsonValue::Object(binding));
    Ok(Some(adapter))
}

/// Resolve the `data.source` router to the concrete adapter ref and binding it
/// dispatches to, without mutating the invocation. Shared by the invoke path
/// (which folds the binding into inputs) and the step-output artifact resolution
/// (which needs the concrete adapter's artifact contract, since the router ref
/// has no manifest of its own). Returns `Ok(None)` for any non-router tool ref.
fn router_target(
    catalog_ref: &str,
    inputs: &JsonObject,
    env: &BTreeMap<String, String>,
    skill_directory: &Path,
) -> Result<Option<(String, JsonObject)>, String> {
    if catalog_ref != DATA_SOURCE_ROUTER_TOOL_REF {
        return Ok(None);
    }

    let data_source_ref = string_input(inputs, "data_source_ref")
        .ok_or_else(|| "data.source requires input data_source_ref.".to_owned())?
        .to_owned();
    let binding = match data_source_binding(&data_source_ref, env, skill_directory)? {
        Some(binding) => binding,
        None if data_source_ref.starts_with("local://") => {
            default_local_data_source_binding(&data_source_ref, inputs)
        }
        None => {
            return Err(format!(
                "Data source '{data_source_ref}' is not bound to a data adapter. Add it to {PROJECT_DATA_SOURCES_PATH} or set {RUNX_DATA_SOURCES_ENV}."
            ));
        }
    };

    let adapter = string_input(&binding, "adapter")
        .ok_or_else(|| format!("Data source '{data_source_ref}' binding is missing adapter."))?;
    if adapter == DATA_SOURCE_ROUTER_TOOL_REF {
        return Err(format!(
            "Data source '{data_source_ref}' cannot bind to {DATA_SOURCE_ROUTER_TOOL_REF}; choose a concrete adapter."
        ));
    }
    if !adapter.contains('.') {
        return Err(format!(
            "Data source '{data_source_ref}' adapter '{adapter}' must be a namespaced tool ref such as data.local."
        ));
    }
    Ok(Some((adapter.to_owned(), binding)))
}

fn default_local_data_source_binding(data_source_ref: &str, inputs: &JsonObject) -> JsonObject {
    let mut object = JsonObject::new();
    object.insert(
        "data_source_ref".to_owned(),
        JsonValue::String(data_source_ref.to_owned()),
    );
    if string_input(inputs, "store_id").is_some() {
        object.insert(
            "adapter".to_owned(),
            JsonValue::String("data.local".to_owned()),
        );
        object.insert(
            "profile".to_owned(),
            JsonValue::String("local-fixture".to_owned()),
        );
        object.insert(
            "storage_class".to_owned(),
            JsonValue::String("local-json-fixture".to_owned()),
        );
    } else {
        let source_digest = sha256_hex(data_source_ref.as_bytes());
        let source_id = &source_digest[..16];
        object.insert(
            "adapter".to_owned(),
            JsonValue::String("data.sqlite".to_owned()),
        );
        object.insert(
            "profile".to_owned(),
            JsonValue::String("local-durable".to_owned()),
        );
        object.insert(
            "database_path".to_owned(),
            JsonValue::String(format!(
                ".runx/data/local-sources/source-{source_id}.sqlite"
            )),
        );
        object.insert(
            "storage_class".to_owned(),
            JsonValue::String("sqlite".to_owned()),
        );
    }
    object.insert("resources".to_owned(), JsonValue::Object(JsonObject::new()));
    object
}

fn data_source_binding(
    data_source_ref: &str,
    env: &BTreeMap<String, String>,
    skill_directory: &Path,
) -> Result<Option<JsonObject>, String> {
    for source in data_source_config_sources(env, skill_directory) {
        let Some(document) = read_data_source_config_source(&source)? else {
            continue;
        };
        let parsed: JsonValue = serde_json::from_str(&document).map_err(|error| {
            format!(
                "Data source config {} is not valid JSON: {error}",
                source.value
            )
        })?;
        let Some(binding) = binding_from_config(&parsed, data_source_ref) else {
            continue;
        };
        reject_secret_material(&binding, data_source_ref)?;
        return Ok(Some(binding));
    }
    Ok(None)
}

// rust-style-allow: long-function - the style scanner over-counts this compact source collector because of surrounding let-else control flow.
fn data_source_config_sources(
    env: &BTreeMap<String, String>,
    skill_directory: &Path,
) -> Vec<DataSourceConfigSource> {
    let mut sources = Vec::new();
    let root = workspace_root(env, skill_directory);
    if let Some(config) = env.get(RUNX_DATA_SOURCES_ENV) {
        let trimmed = config.trim();
        if !trimmed.is_empty() {
            let value = if trimmed.starts_with('{') || Path::new(trimmed).is_absolute() {
                trimmed.to_owned()
            } else {
                root.join(trimmed).to_string_lossy().into_owned()
            };
            sources.push(DataSourceConfigSource {
                value,
                required: true,
            });
        }
    }
    sources.push(DataSourceConfigSource {
        value: root
            .join(PROJECT_DATA_SOURCES_PATH)
            .to_string_lossy()
            .into_owned(),
        required: false,
    });
    sources
}

// rust-style-allow: long-function - the style scanner over-counts this compact config reader because of surrounding let-else control flow.
fn read_data_source_config_source(
    source: &DataSourceConfigSource,
) -> Result<Option<String>, String> {
    let trimmed = source.value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.starts_with('{') {
        return Ok(Some(trimmed.to_owned()));
    }
    match fs::read_to_string(trimmed) {
        Ok(document) => Ok(Some(document)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !source.required => Ok(None),
        Err(error) => Err(format!(
            "Failed to read data source config {trimmed}: {error}"
        )),
    }
}

fn binding_from_config(config: &JsonValue, data_source_ref: &str) -> Option<JsonObject> {
    let JsonValue::Object(root) = config else {
        return None;
    };
    let JsonValue::Object(sources) = root.get("data_sources")? else {
        return None;
    };
    let JsonValue::Object(binding) = sources.get(data_source_ref)? else {
        return None;
    };
    let mut normalized = binding.clone();
    normalized.insert(
        "data_source_ref".to_owned(),
        JsonValue::String(data_source_ref.to_owned()),
    );
    Some(normalized)
}

fn reject_secret_material(binding: &JsonObject, data_source_ref: &str) -> Result<(), String> {
    let Some(key) = first_secret_material_key(&JsonValue::Object(binding.clone())) else {
        return Ok(());
    };
    Err(format!(
        "Data source '{data_source_ref}' binding contains secret-like field '{key}'. Put provider credentials behind a runx credential profile or hosted grant instead."
    ))
}

fn first_secret_material_key(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::Object(object) => object.iter().find_map(|(key, value)| {
            if secret_material_key(key) {
                return Some(key.clone());
            }
            first_secret_material_key(value)
        }),
        JsonValue::Array(values) => values.iter().find_map(first_secret_material_key),
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_) => None,
    }
}

fn secret_material_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "apikey"
            | "accesstoken"
            | "refreshtoken"
            | "clientsecret"
            | "secretkey"
            | "privatekey"
            | "password"
            | "bearertoken"
    )
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
/// The `ToolInspectOptions` that resolve a local tool by reference for the given
/// invocation context. Shared by the resolve-and-invoke path and the artifact
/// contract lookup so both see the same tool from the same roots.
fn local_tool_inspect_options(request: &LocalToolRequest<'_>) -> ToolInspectOptions {
    ToolInspectOptions {
        root: workspace_root(request.env, request.skill_directory),
        tool_ref: request.tool_ref.to_owned(),
        source: None,
        search_from_directory: request.skill_directory.to_path_buf(),
        tool_roots: configured_tool_roots(request.env),
        fixture_catalog_enabled: false,
        allow_explicit_manifest_path: request.allow_explicit_manifest_path,
    }
}

/// Resolve only the artifact contract a local tool declares, for the step-output
/// projection of a `tool:` step. The catalog adapter wraps the packet into the
/// claim at invoke time; without the old auto-copy the OUTER step must expose that
/// packet via this contract, so `<step>.<wrap_as>.data.<field>` resolves.
/// Returns `Ok(None)` when the reference does not resolve to a local tool.
pub(crate) fn resolve_local_tool_artifacts(
    request: &LocalToolRequest<'_>,
) -> Result<Option<SkillArtifactContract>, RuntimeError> {
    // The `data.source` router ref has no manifest of its own; resolve it to the
    // concrete adapter the catalog will actually run so the artifact contract
    // matches the packet the adapter folds into the claim. A router that cannot
    // resolve here is left to the invoke path to report the binding error.
    let mut options = local_tool_inspect_options(request);
    if let Ok(Some((adapter, _))) = router_target(
        request.tool_ref,
        request.inputs,
        request.env,
        request.skill_directory,
    ) {
        options.tool_ref = adapter;
    }
    match resolve_local_tool(&options) {
        Ok(resolution) => Ok(resolution.tool.artifacts),
        Err(error) if local_lookup_miss(&error) => Ok(None),
        Err(error) => Err(catalog_error(request.skill_name, error)),
    }
}

pub(crate) fn resolve_and_invoke_local_tool(
    request: &LocalToolRequest<'_>,
    started: Instant,
) -> Result<Option<SkillOutput>, RuntimeError> {
    let resolution = match resolve_local_tool(&local_tool_inspect_options(request)) {
        Ok(resolution) => resolution,
        Err(error) if local_lookup_miss(&error) => return Ok(None),
        Err(error) => return Err(catalog_error(request.skill_name, error)),
    };
    crate::execution::prepared_skill::verify_prepared_artifact_at_use(
        request.env,
        &resolution.manifest_path,
    )?;

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
        credential_delivery: credential_delivery_for_local_tool(
            source_type,
            request.credential_delivery,
        ),
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

fn credential_delivery_for_local_tool(
    source_type: runx_parser::SourceKind,
    credential_delivery: &CredentialDelivery,
) -> CredentialDelivery {
    if source_type == runx_parser::SourceKind::CliTool {
        return CredentialDelivery::none();
    }
    credential_delivery.clone()
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
        // Wrap the claim in the canonical `{ data: ... }` envelope idempotently: a tool
        // that already emits a self-described `{ schema, data }` packet is exposed as-is
        // (single `.data`) rather than re-wrapped into `.data.data`. Mirrors the
        // `named_emits` branch so artifact depth is uniform across both forms.
        let wrapped = data_envelope(JsonValue::Object(object.clone()));
        object.insert(wrap_as.to_owned(), wrapped);
        changed = true;
    }

    if let Some(named_emits) = &artifacts.named_emits {
        for name in named_emits.keys() {
            let Some(value) = object.get(name).cloned() else {
                continue;
            };
            object.insert(name.clone(), data_envelope(value));
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
    crate::config::resolve_runx_workspace_base(env, fallback)
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

fn string_input<'a>(object: &'a JsonObject, key: &str) -> Option<&'a str> {
    match object.get(key) {
        Some(JsonValue::String(value)) if !value.trim().is_empty() => Some(value.trim()),
        _ => None,
    }
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

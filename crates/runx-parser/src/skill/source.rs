// Module rationale: skill-source validation keeps the source-kind
// parsing, the artifact/mint coherence rules, and their error construction as one
// cohesive unit; splitting it would scatter the source contract across files.
use std::path::{Component, Path};

use runx_contracts::javascript_worker::MAX_INPUT_BYTES;
use runx_contracts::{JsonObject, JsonValue};

use crate::ValidationError;
use crate::graph::{RawGraphIr, validate_graph_document};

use crate::graph::MintScopeSource;

use super::{
    ActDeclaration, FIELDS, InputMode, SkillExternalAdapterManifest, SkillMcpServer, SkillSource,
    SourceKind, validate_environment_requirements,
};

const SOURCE_FIELDS: &[&str] = &[
    "act",
    "agent",
    "agent_card_url",
    "agent_identity",
    "args",
    "arguments",
    "command",
    "cwd",
    "environment",
    "external_adapter",
    "export",
    "graph",
    "input_mode",
    "module",
    "outputs",
    "pages",
    "server",
    "task",
    "thread_outbox_provider",
    "timeout_seconds",
    "tool",
    "type",
];

pub fn validate_skill_source(source: &JsonObject) -> Result<SkillSource, ValidationError> {
    validate_source(source)
}

pub(crate) fn validate_inline_graph_source(
    source: &JsonObject,
) -> Result<SkillSource, ValidationError> {
    validate_source_with_context(source, SourceValidationContext::InlineGraph)
}

pub(super) fn validate_source_fields(
    source: &JsonObject,
    field: &str,
) -> Result<(), ValidationError> {
    FIELDS.reject_unknown_fields(source, field, SOURCE_FIELDS)
}

pub(super) fn flattened_source_record(record: &JsonObject) -> JsonObject {
    record
        .iter()
        .filter(|(field, _)| SOURCE_FIELDS.contains(&field.as_str()))
        .map(|(field, value)| (field.clone(), value.clone()))
        .collect()
}

pub(super) fn validate_source(source: &JsonObject) -> Result<SkillSource, ValidationError> {
    validate_source_with_context(source, SourceValidationContext::Skill)
}

#[derive(Clone, Copy)]
enum SourceValidationContext {
    Skill,
    InlineGraph,
}

fn validate_source_with_context(
    source: &JsonObject,
    context: SourceValidationContext,
) -> Result<SkillSource, ValidationError> {
    let source_type = FIELDS.required_string(source.get("type"), "source.type")?;
    if source_type == "http" {
        return Err(retired_http_source_error("source.type"));
    }
    if source_type == "catalog" {
        return Err(retired_catalog_source_error("source.type"));
    }
    validate_source_fields(source, "source")?;
    let args = FIELDS
        .optional_string_array(source.get("args"), "source.args")?
        .unwrap_or_default();
    let input_mode = optional_input_mode(source.get("input_mode"))?;
    let timeout_seconds =
        FIELDS.optional_u64(source.get("timeout_seconds"), "source.timeout_seconds")?;

    if source_type == "cli-tool" {
        FIELDS.required_string(source.get("command"), "source.command")?;
    }
    let (module, javascript_export) = validate_javascript_source(source, &source_type)?;
    validate_agent_command_boundary(source, &source_type)?;
    let source_kind = parse_source_kind(&source_type, "source.type")?;
    validate_source_timeout(&source_kind, timeout_seconds)?;
    let external_adapter = validate_external_adapter_manifest(source, source_kind)?;
    let thread_outbox_provider = validate_thread_outbox_provider(source, source_kind)?;
    let outputs = FIELDS.optional_object(source.get("outputs"), "source.outputs")?;
    if let Some(outputs) = &outputs {
        runx_contracts::parse_output_contract(outputs).map_err(|error| {
            FIELDS.validation_error(format!("source.outputs is invalid: {error}"))
        })?;
    }
    Ok(SkillSource {
        command: FIELDS.optional_string(source.get("command"), "source.command")?,
        module,
        javascript_export,
        pages: validate_artifact_pages(source.get("pages"), &source_kind)?,
        args,
        cwd: FIELDS.optional_string(source.get("cwd"), "source.cwd")?,
        timeout_seconds,
        input_mode,
        environment: validate_environment_requirements(source.get("environment"))?,
        server: validate_mcp_server(source, &source_type)?,
        tool: validate_mcp_tool(source, &source_type)?,
        arguments: FIELDS.optional_object(source.get("arguments"), "source.arguments")?,
        agent_card_url: validate_a2a_url(source, &source_type)?,
        agent_identity: FIELDS
            .optional_string(source.get("agent_identity"), "source.agent_identity")?,
        agent: validate_agent(source, &source_type, context)?,
        task: validate_task(source, &source_type, context)?,
        outputs,
        graph: validate_graph_source(source, &source_type)?,
        external_adapter,
        thread_outbox_provider,
        act: validate_act_declaration(source.get("act"))?,
        raw: source.clone(),
        source_type: source_kind,
    })
}

fn validate_artifact_pages(
    value: Option<&JsonValue>,
    source_kind: &SourceKind,
) -> Result<Option<super::ArtifactPageSource>, ValidationError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if *source_kind != SourceKind::JavaScript {
        return Err(FIELDS
            .validation_error("source.pages is only valid for deterministic javascript sources."));
    }
    let value = FIELDS.required_object(Some(value), "source.pages")?;
    FIELDS.reject_unknown_fields(
        value,
        "source.pages",
        &[
            "framing",
            "media_type",
            "page_bytes",
            "path_from",
            "path_scope_from",
        ],
    )?;
    let path_from = page_input_name(value, "path_from")?;
    let path_scope_from = FIELDS
        .optional_string(value.get("path_scope_from"), "source.pages.path_scope_from")?
        .map(|name| validate_page_input_name(&name, "source.pages.path_scope_from"))
        .transpose()?;
    if path_from == "runx_page" || path_scope_from.as_deref() == Some("runx_page") {
        return Err(FIELDS.validation_error(
            "source.pages input names cannot use the runtime-reserved runx_page field.",
        ));
    }
    if path_scope_from.as_deref() == Some(path_from.as_str()) {
        return Err(FIELDS.validation_error(
            "source.pages.path_from and path_scope_from must name different inputs.",
        ));
    }
    let media_type = FIELDS.required_string(value.get("media_type"), "source.pages.media_type")?;
    let framing = match FIELDS
        .required_string(value.get("framing"), "source.pages.framing")?
        .as_str()
    {
        "json_array" => super::ArtifactPageFraming::JsonArray,
        other => {
            return Err(FIELDS.validation_error(format!(
                "source.pages.framing {other:?} is unsupported; expected json_array."
            )));
        }
    };
    let page_bytes = FIELDS
        .optional_u64(value.get("page_bytes"), "source.pages.page_bytes")?
        .unwrap_or(1024 * 1024);
    let maximum_page_bytes = u64::try_from(MAX_INPUT_BYTES).unwrap_or(u64::MAX);
    if page_bytes == 0 || page_bytes > maximum_page_bytes {
        return Err(FIELDS.validation_error(format!(
            "source.pages.page_bytes must be between 1 and {maximum_page_bytes}."
        )));
    }
    Ok(Some(super::ArtifactPageSource {
        path_from,
        path_scope_from,
        media_type,
        framing,
        page_bytes,
    }))
}

fn page_input_name(value: &JsonObject, field: &str) -> Result<String, ValidationError> {
    let qualified = format!("source.pages.{field}");
    let name = FIELDS.required_string(value.get(field), &qualified)?;
    validate_page_input_name(&name, &qualified)
}

fn validate_page_input_name(name: &str, field: &str) -> Result<String, ValidationError> {
    if !name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(FIELDS.validation_error(format!(
            "{field} must name one declared input using letters, digits, '_' or '-'."
        )));
    }
    Ok(name.to_owned())
}

fn validate_external_adapter_manifest(
    source: &JsonObject,
    source_kind: SourceKind,
) -> Result<Option<SkillExternalAdapterManifest>, ValidationError> {
    let declaration = source.get("external_adapter");
    if source_kind != SourceKind::ExternalAdapter {
        if declaration.is_some() {
            return Err(FIELDS.validation_error(
                "source.external_adapter is only valid for external-adapter sources.",
            ));
        }
        return Ok(None);
    }
    let declaration = FIELDS.required_object(declaration, "source.external_adapter")?;
    FIELDS.reject_unknown_fields(
        declaration,
        "source.external_adapter",
        &["manifest", "manifest_path"],
    )?;
    match (
        declaration.get("manifest"),
        declaration.get("manifest_path"),
    ) {
        (Some(_), Some(_)) => Err(FIELDS.validation_error(
            "source.external_adapter must declare exactly one of manifest or manifest_path.",
        )),
        (None, None) => Err(FIELDS.validation_error(
            "source.external_adapter must declare exactly one of manifest or manifest_path.",
        )),
        (Some(manifest), None) => {
            let value = serde_json::to_value(manifest).map_err(|error| {
                FIELDS.validation_error(format!(
                    "source.external_adapter.manifest could not be serialized: {error}"
                ))
            })?;
            let manifest = serde_json::from_value(value).map_err(|error| {
                FIELDS.validation_error(format!(
                    "source.external_adapter.manifest is invalid: {error}"
                ))
            })?;
            Ok(Some(SkillExternalAdapterManifest::Inline(Box::new(
                manifest,
            ))))
        }
        (None, Some(path)) => {
            let path =
                FIELDS.required_string(Some(path), "source.external_adapter.manifest_path")?;
            if !safe_external_adapter_manifest_path(&path) {
                return Err(FIELDS.validation_error(format!(
                    "source.external_adapter.manifest_path must be a relative path below the skill directory: '{path}'"
                )));
            }
            Ok(Some(SkillExternalAdapterManifest::Path(path)))
        }
    }
}

fn safe_external_adapter_manifest_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.trim().is_empty()
        && path.is_relative()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn validate_thread_outbox_provider(
    source: &JsonObject,
    source_kind: SourceKind,
) -> Result<Option<super::SkillThreadOutboxProviderSource>, ValidationError> {
    let declaration = source.get("thread_outbox_provider");
    if source_kind != SourceKind::ThreadOutboxProvider {
        if declaration.is_some() {
            return Err(FIELDS.validation_error(
                "source.thread_outbox_provider is only valid for thread-outbox-provider sources.",
            ));
        }
        return Ok(None);
    }
    let declaration = FIELDS.required_object(declaration, "source.thread_outbox_provider")?;
    FIELDS.reject_unknown_fields(
        declaration,
        "source.thread_outbox_provider",
        &["operation", "manifest_path", "push_path", "fetch_path"],
    )?;
    let operation = match FIELDS
        .required_string(
            declaration.get("operation"),
            "source.thread_outbox_provider.operation",
        )?
        .as_str()
    {
        "push" => runx_contracts::ThreadOutboxProviderOperation::Push,
        "fetch" => runx_contracts::ThreadOutboxProviderOperation::Fetch,
        other => {
            return Err(FIELDS.validation_error(format!(
                "source.thread_outbox_provider.operation must be push or fetch, got '{other}'."
            )));
        }
    };
    let manifest_path = required_thread_outbox_path(declaration, "manifest_path")?;
    let push_path = optional_thread_outbox_path(declaration, "push_path")?;
    let fetch_path = optional_thread_outbox_path(declaration, "fetch_path")?;
    match operation {
        runx_contracts::ThreadOutboxProviderOperation::Push if fetch_path.is_some() => {
            return Err(FIELDS.validation_error(
                "source.thread_outbox_provider.fetch_path is only valid for fetch operations.",
            ));
        }
        runx_contracts::ThreadOutboxProviderOperation::Fetch if push_path.is_some() => {
            return Err(FIELDS.validation_error(
                "source.thread_outbox_provider.push_path is only valid for push operations.",
            ));
        }
        runx_contracts::ThreadOutboxProviderOperation::Fetch if fetch_path.is_none() => {
            return Err(FIELDS.validation_error(
                "source.thread_outbox_provider.fetch_path is required for fetch operations.",
            ));
        }
        _ => {}
    }
    Ok(Some(super::SkillThreadOutboxProviderSource {
        operation,
        manifest_path,
        push_path,
        fetch_path,
    }))
}

fn required_thread_outbox_path(
    declaration: &JsonObject,
    field: &str,
) -> Result<String, ValidationError> {
    let qualified = format!("source.thread_outbox_provider.{field}");
    let path = FIELDS.required_string(declaration.get(field), &qualified)?;
    validate_thread_outbox_path(&qualified, &path)?;
    Ok(path)
}

fn optional_thread_outbox_path(
    declaration: &JsonObject,
    field: &str,
) -> Result<Option<String>, ValidationError> {
    let qualified = format!("source.thread_outbox_provider.{field}");
    let path = FIELDS.optional_string(declaration.get(field), &qualified)?;
    if let Some(path) = path.as_deref() {
        validate_thread_outbox_path(&qualified, path)?;
    }
    Ok(path)
}

fn validate_thread_outbox_path(qualified: &str, path: &str) -> Result<(), ValidationError> {
    if !safe_external_adapter_manifest_path(path) {
        return Err(FIELDS.validation_error(format!(
            "{qualified} must be a relative path below the skill directory: '{path}'"
        )));
    }
    Ok(())
}

fn validate_javascript_source(
    source: &JsonObject,
    source_type: &str,
) -> Result<(Option<String>, Option<String>), ValidationError> {
    if source_type == "javascript" {
        validate_javascript_fields(source)?;
        return Ok((
            Some(validate_javascript_module(source.get("module"))?),
            validate_javascript_export(source.get("export"))?,
        ));
    }
    if source.contains_key("module") || source.contains_key("export") {
        return Err(FIELDS.validation_error(
            "source.module and source.export are only valid for javascript sources.",
        ));
    }
    Ok((None, None))
}

fn validate_javascript_fields(source: &JsonObject) -> Result<(), ValidationError> {
    const FORBIDDEN: &[&str] = &[
        "agent",
        "agent_card_url",
        "agent_identity",
        "allow_private_network",
        "args",
        "arguments",
        "command",
        "cwd",
        "external_adapter",
        "graph",
        "headers",
        "hook",
        "http",
        "input_mode",
        "method",
        "server",
        "task",
        "tool",
        "url",
    ];
    let present = FORBIDDEN
        .iter()
        .copied()
        .filter(|field| source.contains_key(*field))
        .collect::<Vec<_>>();
    if present.is_empty() {
        return Ok(());
    }
    Err(FIELDS.validation_error(format!(
        "javascript sources are pure domain modules and cannot declare effect or process fields: {}.",
        present.join(", ")
    )))
}

fn validate_source_timeout(
    source_kind: &SourceKind,
    timeout_seconds: Option<u64>,
) -> Result<(), ValidationError> {
    if *source_kind != SourceKind::JavaScript {
        return Ok(());
    }
    let Some(timeout_seconds) = timeout_seconds else {
        return Ok(());
    };
    let maximum = runx_contracts::javascript_worker::MAX_WALL_MILLISECONDS / 1_000;
    if timeout_seconds == 0 || timeout_seconds > maximum {
        return Err(FIELDS.validation_error(format!(
            "source.timeout_seconds for javascript must be between 1 and {maximum}."
        )));
    }
    Ok(())
}

/// Validate a declared `act:` block at load: deserialize it into the typed
/// `ActDeclaration` and fail closed if it is present but malformed, so a skill
/// author sees the error instead of silently sealing a generic observation act.
fn validate_act_declaration(
    value: Option<&JsonValue>,
) -> Result<Option<ActDeclaration>, ValidationError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let act = serde_json::to_value(value)
        .and_then(serde_json::from_value::<ActDeclaration>)
        .map_err(|error| FIELDS.validation_error(format!("source.act is malformed: {error}")))?;
    validate_act_authority_coherence(&act)?;
    Ok(Some(act))
}

/// Reject incoherent authority declarations: the compute path (`mint_authority`)
/// and the explicit pre-built path (`authority_*_from`) are mutually exclusive,
/// and each mint source draws from exactly one place (`requested_scope` needs
/// `requested_scope_from`; `static_scopes` must not declare it).
fn validate_act_authority_coherence(act: &ActDeclaration) -> Result<(), ValidationError> {
    let Some(directive) = act.mint_authority else {
        if act.requested_scope_from.is_some() {
            return Err(FIELDS.validation_error(
                "source.act.requested_scope_from is only valid with a mint_authority directive.",
            ));
        }
        return Ok(());
    };
    if act.authority_term_from.is_some()
        || act.authority_parent_from.is_some()
        || act.authority_subset_proof_from.is_some()
    {
        return Err(FIELDS.validation_error(
            "source.act.mint_authority (compute path) is mutually exclusive with the pre-built authority_term_from / authority_parent_from / authority_subset_proof_from keys.",
        ));
    }
    match directive.source {
        MintScopeSource::StaticScopes => {
            if act.requested_scope_from.is_some() {
                return Err(FIELDS.validation_error(
                    "source.act.mint_authority source static_scopes must not declare requested_scope_from.",
                ));
            }
        }
        MintScopeSource::RequestedScope => {
            if act.requested_scope_from.is_none() {
                return Err(FIELDS.validation_error(
                    "source.act.mint_authority source requested_scope requires requested_scope_from.",
                ));
            }
        }
    }
    Ok(())
}

fn parse_source_kind(value: &str, field: &str) -> Result<SourceKind, ValidationError> {
    match value {
        "cli-tool" => Ok(SourceKind::CliTool),
        "javascript" => Ok(SourceKind::JavaScript),
        "mcp" => Ok(SourceKind::Mcp),
        "a2a" => Ok(SourceKind::A2a),
        "agent" => Ok(SourceKind::Agent),
        "agent-task" => Ok(SourceKind::AgentStep),
        "graph" => Ok(SourceKind::Graph),
        "external-adapter" => Ok(SourceKind::ExternalAdapter),
        "thread-outbox-provider" => Ok(SourceKind::ThreadOutboxProvider),
        "http" => Err(retired_http_source_error(field)),
        "catalog" => Err(retired_catalog_source_error(field)),
        other => {
            Err(FIELDS.validation_error(format!("{field} {other} is not a supported source type.")))
        }
    }
}

fn retired_http_source_error(field: &str) -> ValidationError {
    FIELDS.validation_error(format!(
        "{field} http was removed; compose http.read, http.query, or http.execute in a graph."
    ))
}

fn retired_catalog_source_error(field: &str) -> ValidationError {
    FIELDS.validation_error(format!(
        "{field} catalog was removed; invoke catalog tools from a graph tool step."
    ))
}

fn validate_javascript_module(value: Option<&JsonValue>) -> Result<String, ValidationError> {
    let module = FIELDS.required_string(value, "source.module")?;
    let segments = module.split('/').collect::<Vec<_>>();
    if module.starts_with('/')
        || module.contains('\\')
        || segments
            .iter()
            .any(|segment| segment.is_empty() || matches!(*segment, "." | ".."))
        || !matches!(segments.last(), Some(name) if name.ends_with(".mjs") || name.ends_with(".js"))
    {
        return Err(FIELDS.validation_error(
            "source.module must be a portable relative .mjs or .js path without '.', '..', or backslash segments.",
        ));
    }
    Ok(module)
}

fn validate_javascript_export(
    value: Option<&JsonValue>,
) -> Result<Option<String>, ValidationError> {
    let Some(name) = FIELDS.optional_string(value, "source.export")? else {
        return Ok(None);
    };
    let mut chars = name.chars();
    let valid_start = chars
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || matches!(character, '_' | '$'));
    if !valid_start
        || !chars
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '$'))
    {
        return Err(FIELDS.validation_error("source.export must be a JavaScript identifier."));
    }
    Ok(Some(name))
}

fn optional_input_mode(value: Option<&JsonValue>) -> Result<Option<InputMode>, ValidationError> {
    let Some(value) = FIELDS.optional_string(value, "source.input_mode")? else {
        return Ok(None);
    };
    match value.as_str() {
        "args" => Ok(Some(InputMode::Args)),
        "stdin" => Ok(Some(InputMode::Stdin)),
        "none" => Ok(Some(InputMode::None)),
        _ => Err(FIELDS.validation_error("source.input_mode must be args, stdin, or none.")),
    }
}

pub(super) fn default_agent_source() -> JsonObject {
    [("type".to_owned(), JsonValue::String("agent".to_owned()))]
        .into_iter()
        .collect()
}

fn validate_mcp_server(
    source: &JsonObject,
    source_type: &str,
) -> Result<Option<SkillMcpServer>, ValidationError> {
    if source_type != "mcp" {
        return Ok(None);
    }
    let server = FIELDS.required_object(source.get("server"), "source.server")?;
    Ok(Some(SkillMcpServer {
        command: FIELDS.required_string(server.get("command"), "source.server.command")?,
        args: FIELDS
            .optional_string_array(server.get("args"), "source.server.args")?
            .unwrap_or_default(),
        cwd: FIELDS.optional_string(server.get("cwd"), "source.server.cwd")?,
    }))
}

fn validate_mcp_tool(
    source: &JsonObject,
    source_type: &str,
) -> Result<Option<String>, ValidationError> {
    if source_type == "mcp" {
        return Ok(Some(
            FIELDS.required_string(source.get("tool"), "source.tool")?,
        ));
    }
    FIELDS.optional_string(source.get("tool"), "source.tool")
}

fn validate_a2a_url(
    source: &JsonObject,
    source_type: &str,
) -> Result<Option<String>, ValidationError> {
    if source_type == "a2a" {
        return Ok(Some(FIELDS.required_string(
            source.get("agent_card_url"),
            "source.agent_card_url",
        )?));
    }
    FIELDS.optional_string(source.get("agent_card_url"), "source.agent_card_url")
}

fn validate_agent(
    source: &JsonObject,
    source_type: &str,
    context: SourceValidationContext,
) -> Result<Option<String>, ValidationError> {
    if source_type == "agent-task" && matches!(context, SourceValidationContext::Skill) {
        return Ok(Some(
            FIELDS.required_string(source.get("agent"), "source.agent")?,
        ));
    }
    FIELDS.optional_string(source.get("agent"), "source.agent")
}

fn validate_task(
    source: &JsonObject,
    source_type: &str,
    context: SourceValidationContext,
) -> Result<Option<String>, ValidationError> {
    if source_type == "a2a"
        || (source_type == "agent-task" && matches!(context, SourceValidationContext::Skill))
    {
        return Ok(Some(
            FIELDS.required_string(source.get("task"), "source.task")?,
        ));
    }
    FIELDS.optional_string(source.get("task"), "source.task")
}

fn validate_graph_source(
    source: &JsonObject,
    source_type: &str,
) -> Result<Option<crate::ExecutionGraph>, ValidationError> {
    if source_type != "graph" {
        return Ok(None);
    }
    let graph = FIELDS
        .required_object(source.get("graph"), "source.graph")?
        .clone();
    validate_graph_document(graph.clone(), Some(RawGraphIr { document: graph })).map(Some)
}

fn validate_agent_command_boundary(
    source: &JsonObject,
    source_type: &str,
) -> Result<(), ValidationError> {
    if source_type == "agent-task"
        && (source.contains_key("command") || source.contains_key("args"))
    {
        return Err(FIELDS.validation_error(format!(
            "{source_type} sources must not declare source.command or source.args."
        )));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use crate::graph::MintScopeSource;
    use runx_contracts::JsonValue;

    use super::validate_act_declaration;
    use serde_json::json;

    fn act_value(value: serde_json::Value) -> JsonValue {
        serde_json::from_value(value).expect("convertible act value")
    }

    fn act_err(value: serde_json::Value) -> String {
        validate_act_declaration(Some(&act_value(value)))
            .err()
            .map(|error| error.to_string())
            .expect("act unexpectedly validated")
    }

    #[test]
    fn requested_scope_mint_act_validates() {
        let act = validate_act_declaration(Some(&act_value(json!({
            "mint_authority": {"source": "requested_scope"},
            "requested_scope_from": "needed_scope",
        }))))
        .expect("valid act")
        .expect("present act");
        assert_eq!(
            act.mint_authority.map(|directive| directive.source),
            Some(MintScopeSource::RequestedScope)
        );
    }

    #[test]
    fn mint_authority_conflicts_with_prebuilt_path() {
        let message = act_err(json!({
            "mint_authority": {"source": "static_scopes"},
            "authority_term_from": "member_authority",
        }));
        assert!(message.contains("mutually exclusive"));
    }

    #[test]
    fn requested_scope_act_requires_input_key() {
        let message = act_err(json!({
            "mint_authority": {"source": "requested_scope"},
        }));
        assert!(message.contains("requires requested_scope_from"));
    }

    #[test]
    fn static_scopes_act_rejects_requested_scope_from() {
        let message = act_err(json!({
            "mint_authority": {"source": "static_scopes"},
            "requested_scope_from": "needed_scope",
        }));
        assert!(message.contains("must not declare requested_scope_from"));
    }

    #[test]
    fn dangling_requested_scope_from_in_act_is_rejected() {
        let message = act_err(json!({
            "requested_scope_from": "needed_scope",
        }));
        assert!(message.contains("only valid with a mint_authority directive"));
    }
}

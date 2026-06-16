use runx_contracts::{JsonObject, JsonValue};

use crate::ValidationError;
use crate::graph::{RawGraphIr, validate_graph_document};

use super::{
    ActDeclaration, FIELDS, InputMode, SkillHttpSource, SkillMcpServer, SkillSource, SourceKind,
    field_value, first_value, validate_sandbox,
};

pub fn validate_skill_source(
    source: &JsonObject,
    runx: Option<&JsonObject>,
) -> Result<SkillSource, ValidationError> {
    validate_source(source, runx)
}

pub(super) fn validate_source(
    source: &JsonObject,
    runx: Option<&JsonObject>,
) -> Result<SkillSource, ValidationError> {
    let source_type = FIELDS.required_string(source.get("type"), "source.type")?;
    let args = FIELDS
        .optional_string_array(source.get("args"), "source.args")?
        .unwrap_or_default();
    let input_mode = optional_input_mode(source.get("input_mode"))?;
    let timeout_seconds =
        FIELDS.optional_u64(source.get("timeout_seconds"), "source.timeout_seconds")?;

    if source_type == "cli-tool" {
        FIELDS.required_string(source.get("command"), "source.command")?;
    }
    validate_agent_command_boundary(source, &source_type)?;
    let source_kind = parse_source_kind(&source_type, "source.type")?;

    Ok(SkillSource {
        command: FIELDS.optional_string(source.get("command"), "source.command")?,
        args,
        cwd: FIELDS.optional_string(source.get("cwd"), "source.cwd")?,
        timeout_seconds,
        input_mode,
        sandbox: validate_sandbox(first_value(
            source.get("sandbox"),
            field_value(runx, "sandbox"),
        ))?,
        server: validate_mcp_server(source, &source_type)?,
        catalog_ref: validate_catalog_ref(source, &source_type)?,
        tool: validate_mcp_tool(source, &source_type)?,
        arguments: FIELDS.optional_object(source.get("arguments"), "source.arguments")?,
        agent_card_url: validate_a2a_url(source, &source_type)?,
        agent_identity: FIELDS
            .optional_string(source.get("agent_identity"), "source.agent_identity")?,
        agent: validate_agent(source, &source_type)?,
        task: validate_task(source, &source_type)?,
        hook: validate_hook(source, &source_type)?,
        outputs: FIELDS.optional_object(source.get("outputs"), "source.outputs")?,
        graph: validate_graph_source(source, &source_type)?,
        http: validate_http_source(source, &source_type)?,
        act: validate_act_declaration(source.get("act"))?,
        raw: source.clone(),
        source_type: source_kind,
    })
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
    serde_json::to_value(value)
        .and_then(serde_json::from_value::<ActDeclaration>)
        .map(Some)
        .map_err(|error| FIELDS.validation_error(format!("source.act is malformed: {error}")))
}

fn parse_source_kind(value: &str, field: &str) -> Result<SourceKind, ValidationError> {
    match value {
        "cli-tool" => Ok(SourceKind::CliTool),
        "mcp" => Ok(SourceKind::Mcp),
        "catalog" => Ok(SourceKind::Catalog),
        "a2a" => Ok(SourceKind::A2a),
        "agent" => Ok(SourceKind::Agent),
        "agent-task" => Ok(SourceKind::AgentStep),
        "harness-hook" => Ok(SourceKind::HarnessHook),
        "graph" => Ok(SourceKind::Graph),
        "http" => Ok(SourceKind::Http),
        "external-adapter" => Ok(SourceKind::ExternalAdapter),
        "thread-outbox-provider" => Ok(SourceKind::ThreadOutboxProvider),
        other => {
            Err(FIELDS.validation_error(format!("{field} {other} is not a supported source type.")))
        }
    }
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

fn validate_catalog_ref(
    source: &JsonObject,
    source_type: &str,
) -> Result<Option<String>, ValidationError> {
    if source_type == "catalog" {
        return Ok(Some(FIELDS.required_string(
            source.get("catalog_ref"),
            "source.catalog_ref",
        )?));
    }
    FIELDS.optional_string(source.get("catalog_ref"), "source.catalog_ref")
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
) -> Result<Option<String>, ValidationError> {
    if source_type == "agent-task" {
        return Ok(Some(
            FIELDS.required_string(source.get("agent"), "source.agent")?,
        ));
    }
    FIELDS.optional_string(source.get("agent"), "source.agent")
}

fn validate_task(
    source: &JsonObject,
    source_type: &str,
) -> Result<Option<String>, ValidationError> {
    if matches!(source_type, "agent-task" | "a2a") {
        return Ok(Some(
            FIELDS.required_string(source.get("task"), "source.task")?,
        ));
    }
    FIELDS.optional_string(source.get("task"), "source.task")
}

fn validate_hook(
    source: &JsonObject,
    source_type: &str,
) -> Result<Option<String>, ValidationError> {
    if source_type == "harness-hook" {
        return Ok(Some(
            FIELDS.required_string(source.get("hook"), "source.hook")?,
        ));
    }
    FIELDS.optional_string(source.get("hook"), "source.hook")
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

fn validate_http_source(
    source: &JsonObject,
    source_type: &str,
) -> Result<Option<SkillHttpSource>, ValidationError> {
    if source_type != "http" {
        return Ok(None);
    }
    let url = FIELDS.required_string(source.get("url"), "source.url")?;
    let method = match FIELDS.optional_string(source.get("method"), "source.method")? {
        Some(method) => {
            if !matches!(
                method.to_ascii_uppercase().as_str(),
                "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
            ) {
                return Err(FIELDS.validation_error(format!(
                    "source.method {method} is not supported; use GET, POST, PUT, PATCH, or DELETE."
                )));
            }
            Some(method)
        }
        None => None,
    };
    Ok(Some(SkillHttpSource {
        url,
        method,
        headers: validate_http_headers(source.get("headers"))?,
        allow_private_network: FIELDS.optional_bool(
            source.get("allow_private_network"),
            "source.allow_private_network",
        )?,
    }))
}

fn validate_http_headers(
    value: Option<&JsonValue>,
) -> Result<Option<std::collections::BTreeMap<String, String>>, ValidationError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let object = value.as_object().ok_or_else(|| {
        FIELDS.validation_error(
            "source.headers must be an object of header name to value.".to_owned(),
        )
    })?;
    let mut headers = std::collections::BTreeMap::new();
    for (name, value) in object {
        let value = value.as_str().ok_or_else(|| {
            FIELDS.validation_error(format!("source.headers.{name} must be a string."))
        })?;
        headers.insert(name.clone(), value.to_owned());
    }
    Ok(Some(headers))
}

fn validate_agent_command_boundary(
    source: &JsonObject,
    source_type: &str,
) -> Result<(), ValidationError> {
    if matches!(source_type, "agent-task" | "harness-hook")
        && (source.contains_key("command") || source.contains_key("args"))
    {
        return Err(FIELDS.validation_error(format!(
            "{source_type} sources must not declare source.command or source.args."
        )));
    }
    Ok(())
}

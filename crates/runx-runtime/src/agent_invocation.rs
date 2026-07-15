use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use runx_contracts::schema::NonEmptyString;
use runx_contracts::{
    AgentActInvocation, AgentActSourceType, AgentContextEnvelope, ExecutionLocation, JsonObject,
    JsonValue, Output, OutputField, ResolutionRequest,
};
use runx_parser::parse_skill_markdown;

use crate::RuntimeError;
use crate::SkillInvocation;

const TRUST_BOUNDARY: &str = "native-managed: runx executes the model and tool loop directly, receipts the result, and only yields to a surface for explicit human resolution outside this path";

mod profiles;

pub(crate) use profiles::agent_profile_metadata;

struct SkillMarkdownContext {
    body: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgentActInvocationSourceType {
    Agent,
    AgentStep,
}

impl AgentActInvocationSourceType {
    pub(crate) fn from_contract_value(value: &str) -> Option<Self> {
        match value {
            "agent" => Some(Self::Agent),
            "agent-task" => Some(Self::AgentStep),
            _ => None,
        }
    }

    const fn contract_source_type(self) -> AgentActSourceType {
        match self {
            Self::Agent => AgentActSourceType::Agent,
            Self::AgentStep => AgentActSourceType::AgentStep,
        }
    }
}

pub(crate) fn agent_act_resolution_request(
    request: &SkillInvocation,
    source_type: AgentActInvocationSourceType,
) -> Result<ResolutionRequest, RuntimeError> {
    let id = agent_act_invocation_id(request, source_type);
    Ok(ResolutionRequest::AgentAct {
        id: id.clone().into(),
        invocation: Box::new(build_agent_act_invocation(request, source_type)?),
    })
}

pub(crate) fn agent_act_invocation_id(
    request: &SkillInvocation,
    source_type: AgentActInvocationSourceType,
) -> String {
    let skill_name = skill_name(request, source_type);
    match source_type {
        AgentActInvocationSourceType::Agent => {
            format!("agent.{}.output", normalize_request_id(&skill_name))
        }
        AgentActInvocationSourceType::AgentStep => {
            let name = request.source.task.as_deref().unwrap_or(&skill_name);
            format!("agent_task.{}.output", normalize_request_id(name))
        }
    }
}

pub(crate) fn build_agent_act_invocation(
    request: &SkillInvocation,
    source_type: AgentActInvocationSourceType,
) -> Result<AgentActInvocation, RuntimeError> {
    Ok(AgentActInvocation {
        id: agent_act_invocation_id(request, source_type).into(),
        source_type: source_type.contract_source_type(),
        agent: optional_non_empty(request.source.agent.as_deref()),
        task: optional_non_empty(request.source.task.as_deref()),
        envelope: envelope(request, source_type)?,
    })
}

fn envelope(
    request: &SkillInvocation,
    source_type: AgentActInvocationSourceType,
) -> Result<AgentContextEnvelope, RuntimeError> {
    let skill_context = load_skill_markdown_context(&request.skill_directory)?;
    let output = request
        .source
        .outputs
        .as_ref()
        .filter(|fields| !fields.is_empty())
        .ok_or_else(|| {
            invalid_agent_invocation(
                request,
                "agent-mediated runners must declare at least one output",
            )
        })?;
    Ok(AgentContextEnvelope {
        run_id: "rx_pending".into(),
        step_id: None,
        skill: skill_name(request, source_type).into(),
        instructions: envelope_instructions(request, skill_context.as_ref()).into(),
        inputs: request.inputs.clone(),
        allowed_tools: envelope_allowed_tools(request)?,
        current_context: request.current_context.clone(),
        historical_context: Vec::new(),
        provenance: Vec::new(),
        context: None,
        voice_profile: Some(profiles::resolve_voice_profile(request)?),
        execution_location: Some(execution_location(&request.skill_directory, &request.env)),
        output: Some(output_schema_fields(output)?),
        trust_boundary: TRUST_BOUNDARY.into(),
    })
}

fn envelope_instructions(
    request: &SkillInvocation,
    skill_context: Option<&SkillMarkdownContext>,
) -> String {
    request
        .source
        .raw
        .get("instructions")
        .and_then(JsonValue::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            skill_context
                .map(|context| context.body.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| {
            "Resolve the runx agent act using the supplied inputs and context.".to_owned()
        })
}

fn load_skill_markdown_context(
    skill_directory: &Path,
) -> Result<Option<SkillMarkdownContext>, RuntimeError> {
    let path = skill_directory.join("SKILL.md");
    if !path.is_file() {
        return Ok(None);
    }
    let source = fs::read_to_string(&path)
        .map_err(|error| RuntimeError::io(format!("reading {}", path.display()), error))?;
    let raw = parse_skill_markdown(&source)?;
    Ok(Some(SkillMarkdownContext { body: raw.body }))
}

fn envelope_allowed_tools(request: &SkillInvocation) -> Result<Vec<NonEmptyString>, RuntimeError> {
    let Some(value) = request.source.raw.get("allowed_tools") else {
        return Ok(Vec::new());
    };
    let JsonValue::Array(tools) = value else {
        return Err(invalid_agent_invocation(
            request,
            "allowed_tools must be an array of non-empty strings",
        ));
    };
    let mut allowed_tools = Vec::new();
    for (index, value) in tools.iter().enumerate() {
        let Some(tool) = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .and_then(|value| NonEmptyString::new(value.to_owned()))
        else {
            return Err(invalid_agent_invocation(
                request,
                format!("allowed_tools[{index}] must be a non-empty string"),
            ));
        };
        allowed_tools.push(tool);
    }
    Ok(allowed_tools)
}

fn invalid_agent_invocation(request: &SkillInvocation, message: impl Into<String>) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: if request.skill_name.is_empty() {
            "agent".to_owned()
        } else {
            request.skill_name.clone()
        },
        message: message.into(),
    }
}

#[cfg(test)]
mod tests;

fn optional_non_empty(value: Option<&str>) -> Option<NonEmptyString> {
    value.and_then(NonEmptyString::new)
}

fn output_schema_fields(raw: &JsonObject) -> Result<BTreeMap<String, OutputField>, RuntimeError> {
    let value = serde_json::to_value(JsonValue::Object(raw.clone()))
        .map_err(|source| RuntimeError::json("serializing agent output contract", source))?;
    let Output(output) = serde_json::from_value(value)
        .map_err(|source| RuntimeError::json("parsing agent output contract", source))?;
    Ok(output)
}

fn execution_location(skill_directory: &Path, env: &BTreeMap<String, String>) -> ExecutionLocation {
    let tool_roots = parse_configured_tool_roots(env);
    ExecutionLocation {
        skill_directory: skill_directory.to_string_lossy().into_owned().into(),
        tool_roots: if tool_roots.is_empty() {
            None
        } else {
            Some(tool_roots.into_iter().map(Into::into).collect())
        },
    }
}

fn parse_configured_tool_roots(env: &BTreeMap<String, String>) -> Vec<String> {
    let Some(value) = env.get("RUNX_TOOL_ROOTS") else {
        return Vec::new();
    };
    std::env::split_paths(value)
        .filter(|path| !path.as_os_str().is_empty())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn skill_name(request: &SkillInvocation, source_type: AgentActInvocationSourceType) -> String {
    if request.skill_name.is_empty() {
        return match source_type {
            AgentActInvocationSourceType::Agent => "skill".to_owned(),
            AgentActInvocationSourceType::AgentStep => "agent-task".to_owned(),
        };
    }
    request.skill_name.clone()
}

fn normalize_request_id(value: &str) -> String {
    let mut normalized = String::new();
    let mut replaced = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') {
            normalized.push(character);
            replaced = false;
        } else if !replaced {
            normalized.push('_');
            replaced = true;
        }
    }
    normalized
}

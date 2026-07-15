// rust-style-allow: large-file because skill execution, graph fallback,
// runx envelope construction, and host plumbing for `runx mcp serve` stay
// adjacent to the server execution boundary.
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::{
    ExecutionEvent, JsonObject, JsonValue, Question, ResolutionRequest, ResolutionResponse,
};
use runx_core::state_machine::GraphStatus;
use runx_parser::{SkillInput, ValidatedSkill};

use crate::adapter::{SkillAdapter, SkillInvocation, SkillOutput};
use crate::host::Host;
use crate::receipts::step_receipt_with_signature_policy;
use crate::registry::scopes::required_scopes_from_skill;
use crate::services::ReceiptServices;
use crate::{GraphRun, Runtime, RuntimeError, RuntimeOptions};

use super::adapter::McpAdapter;
use super::server::mcp_tool_result_from_host_result;
use super::types::{
    McpHostRunResult, McpServerExecutionOptions, McpServerOptions, McpServerSkillExecution,
    McpServerTool, McpServerToolBehavior, McpToolResult,
};

impl McpServerOptions {
    pub fn from_skill_paths(
        skill_paths: &[PathBuf],
        package_name: impl Into<String>,
        package_version: impl Into<String>,
    ) -> Result<Self, RuntimeError> {
        Self::from_skill_paths_with_execution(
            skill_paths,
            package_name,
            package_version,
            McpServerExecutionOptions::default(),
        )
    }

    pub fn from_skill_paths_with_execution(
        skill_paths: &[PathBuf],
        package_name: impl Into<String>,
        package_version: impl Into<String>,
        execution: McpServerExecutionOptions,
    ) -> Result<Self, RuntimeError> {
        if let Some(runner) = &execution.runner {
            return Err(RuntimeError::UnsupportedRunnerSelection {
                runner: runner.clone(),
            });
        }
        let tools = skill_paths
            .iter()
            .map(|path| load_mcp_server_tool(path, &execution))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            package_name: package_name.into(),
            package_version: package_version.into(),
            tools,
        })
    }
}

pub(super) fn load_mcp_server_tool(
    skill_path: &Path,
    execution: &McpServerExecutionOptions,
) -> Result<McpServerTool, RuntimeError> {
    let skill_path = canonical_skill_path(skill_path)?;
    let skill = load_skill_for_mcp(&skill_path)?;
    let required_scopes =
        required_scopes_from_skill(&skill).map_err(|error| RuntimeError::SkillFailed {
            skill_name: skill.name.clone(),
            message: format!("invalid required scopes: {error}"),
        })?;
    Ok(McpServerTool {
        name: skill.name.clone(),
        description: skill
            .description
            .clone()
            .unwrap_or_else(|| format!("runx skill {}", skill.name)),
        input_schema: skill_inputs_to_json_schema(&skill.inputs),
        required_scopes,
        result: McpServerToolBehavior::Skill(Box::new(McpServerSkillExecution {
            skill_path,
            skill,
            receipt_dir: execution.receipt_dir.clone(),
            env: execution.env.clone(),
        })),
    })
}

fn canonical_skill_path(skill_path: &Path) -> Result<PathBuf, RuntimeError> {
    let manifest_path = if skill_path.is_dir() {
        skill_path.join("SKILL.md")
    } else {
        skill_path.to_path_buf()
    };
    if !manifest_path.exists() {
        return Err(RuntimeError::SkillFileMissing {
            path: manifest_path,
        });
    }
    skill_path
        .canonicalize()
        .map_err(|source| RuntimeError::io("canonicalizing skill path", source))
}

fn load_skill_for_mcp(skill_path: &Path) -> Result<ValidatedSkill, RuntimeError> {
    let manifest_path = if skill_path.is_dir() {
        skill_path.join("SKILL.md")
    } else {
        skill_path.to_path_buf()
    };
    if !manifest_path.exists() {
        return Err(RuntimeError::SkillFileMissing {
            path: manifest_path,
        });
    }
    let source = fs::read_to_string(&manifest_path)
        .map_err(|source| RuntimeError::io("reading skill markdown", source))?;
    let raw = runx_parser::parse_skill_markdown(&source)?;
    runx_parser::validate_skill(raw).map_err(RuntimeError::from)
}

fn skill_inputs_to_json_schema(inputs: &BTreeMap<String, SkillInput>) -> JsonObject {
    let properties = inputs
        .iter()
        .map(|(name, input)| (name.clone(), JsonValue::Object(skill_input_schema(input))))
        .collect::<JsonObject>();
    let required = inputs
        .iter()
        .filter(|(_name, input)| input.required)
        .map(|(name, _input)| JsonValue::String(name.clone()))
        .collect::<Vec<_>>();
    [
        ("type".to_owned(), JsonValue::String("object".to_owned())),
        ("properties".to_owned(), JsonValue::Object(properties)),
        ("required".to_owned(), JsonValue::Array(required)),
        ("additionalProperties".to_owned(), JsonValue::Bool(false)),
    ]
    .into()
}

fn skill_input_schema(input: &SkillInput) -> JsonObject {
    let mut schema = JsonObject::new();
    if let Some(input_type) = normalize_input_type(&input.input_type) {
        schema.insert("type".to_owned(), JsonValue::String(input_type.to_owned()));
    }
    if let Some(description) = &input.description {
        schema.insert(
            "description".to_owned(),
            JsonValue::String(description.clone()),
        );
    }
    if let Some(default) = &input.default {
        schema.insert("default".to_owned(), default.clone());
    }
    schema
}

fn normalize_input_type(input_type: &str) -> Option<&str> {
    match input_type {
        "string" | "number" | "integer" | "boolean" | "object" | "array" => Some(input_type),
        _ => None,
    }
}

pub(super) fn execute_mcp_server_skill(
    run_id: &str,
    execution: McpServerSkillExecution,
    inputs: JsonObject,
) -> Result<McpToolResult, RuntimeError> {
    let inputs = apply_input_defaults(&execution.skill, inputs);
    if let Some(request) = input_resolution_request(&execution.skill, &inputs) {
        let skill_name = execution.skill.name.clone();
        return Ok(mcp_tool_result_from_host_result(
            McpHostRunResult::NeedsAgent {
                skill_name: skill_name.clone(),
                run_id: run_id.to_owned(),
                request_count: 1,
                runx: needs_agent_runx(&skill_name, run_id, &[request])?,
            },
        ));
    }

    if execution.skill.source.source_type == runx_parser::SourceKind::Graph {
        return execute_mcp_server_graph(run_id, execution, inputs);
    }
    complete_mcp_server_skill(run_id, execution, inputs)
}

fn execute_mcp_server_graph(
    run_id: &str,
    execution: McpServerSkillExecution,
    _inputs: JsonObject,
) -> Result<McpToolResult, RuntimeError> {
    let graph =
        execution
            .skill
            .source
            .graph
            .clone()
            .ok_or_else(|| RuntimeError::UnsupportedAdapter {
                adapter_type: "graph".to_owned(),
            })?;
    let graph_dir = skill_directory_for_execution(&execution.skill_path);
    let mut env = execution.env.clone();
    env.insert(crate::RUNX_RUN_ID_ENV.to_owned(), run_id.to_owned());
    let receipts =
        ReceiptServices::from_env(&env).map_err(|error| RuntimeError::ReceiptInvalid {
            message: error.to_string(),
        })?;
    let runtime = Runtime::new(
        McpServerGraphAdapter,
        RuntimeOptions {
            created_at: crate::time::now_iso8601(),
            env,
            receipt_signature: receipts.signature_config().clone(),
            effects: Default::default(),
            credential_delivery: Default::default(),
        },
    );
    let mut host = McpServerHost::default();
    let checkpoint = match runtime.run_graph_until_steps_with_host(&graph_dir, &graph, 1, &mut host)
    {
        Ok(checkpoint) => checkpoint,
        Err(RuntimeError::GraphBlocked { .. }) if !host.requests.is_empty() => {
            return pending_mcp_graph_result(run_id, &execution.skill.name, &host.requests[0]);
        }
        Err(error) => return Err(error),
    };
    if let Some(request) = host.requests.first() {
        return pending_mcp_graph_result(run_id, &execution.skill.name, request);
    }
    let run = runtime.resume_graph_with_host(&graph_dir, graph, checkpoint, &mut host)?;
    graph_run_mcp_result(&execution.skill.name, run_id, run)
}

fn pending_mcp_graph_result(
    run_id: &str,
    skill_name: &str,
    request: &ResolutionRequest,
) -> Result<McpToolResult, RuntimeError> {
    Ok(mcp_tool_result_from_host_result(
        McpHostRunResult::NeedsAgent {
            skill_name: skill_name.to_owned(),
            run_id: run_id.to_owned(),
            request_count: 1,
            runx: needs_agent_runx(skill_name, run_id, std::slice::from_ref(request))?,
        },
    ))
}

fn graph_run_mcp_result(
    skill_name: &str,
    run_id: &str,
    run: GraphRun,
) -> Result<McpToolResult, RuntimeError> {
    let status = if run.state.status == GraphStatus::Succeeded {
        "completed"
    } else {
        "failed"
    };
    let result = if status == "completed" {
        McpHostRunResult::Completed {
            skill_name: skill_name.to_owned(),
            output: String::new(),
            receipt_id: run.receipt.id.to_string(),
            runx: terminal_runx("completed", skill_name, run_id, &run.receipt.id),
        }
    } else {
        McpHostRunResult::Failed {
            skill_name: skill_name.to_owned(),
            receipt_id: Some(run.receipt.id.to_string()),
            error: format!("graph ended with status {:?}", run.state.status),
            runx: terminal_runx("failed", skill_name, run_id, &run.receipt.id),
        }
    };
    Ok(mcp_tool_result_from_host_result(result))
}

fn complete_mcp_server_skill(
    run_id: &str,
    execution: McpServerSkillExecution,
    inputs: JsonObject,
) -> Result<McpToolResult, RuntimeError> {
    let receipts = ReceiptServices::from_env(&execution.env).map_err(|error| {
        RuntimeError::ReceiptInvalid {
            message: error.to_string(),
        }
    })?;
    let output = invoke_mcp_server_skill(&execution, inputs)?;
    let receipt = step_receipt_with_signature_policy(
        run_id,
        &execution.skill.name,
        1,
        &output,
        &crate::time::now_iso8601(),
        receipts.signature_config().signature_policy(),
    )?;
    if let Some(receipt_dir) = &execution.receipt_dir {
        receipts
            .write_local_receipt_dir(&receipt, receipt_dir)
            .map_err(|source| RuntimeError::ReceiptInvalid {
                message: source.to_string(),
            })?;
    }
    let result = if output.succeeded() {
        McpHostRunResult::Completed {
            skill_name: execution.skill.name.clone(),
            output: output.stdout.clone(),
            receipt_id: receipt.id.to_string(),
            runx: completed_runx(&execution.skill.name, run_id, &receipt.id, &output),
        }
    } else {
        McpHostRunResult::Failed {
            skill_name: execution.skill.name.clone(),
            receipt_id: Some(receipt.id.to_string()),
            error: if output.stderr.is_empty() {
                "skill execution failed".to_owned()
            } else {
                output.stderr.clone()
            },
            runx: terminal_runx("failed", &execution.skill.name, run_id, &receipt.id),
        }
    };
    Ok(mcp_tool_result_from_host_result(result))
}

fn invoke_mcp_server_skill(
    execution: &McpServerSkillExecution,
    inputs: JsonObject,
) -> Result<SkillOutput, RuntimeError> {
    let invocation = SkillInvocation {
        skill_name: execution.skill.name.clone(),
        source: execution.skill.source.clone(),
        inputs,
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: skill_directory_for_execution(&execution.skill_path),
        env: execution.env.clone(),
        credential_delivery: crate::credentials::CredentialDelivery::none(),
    };
    match execution.skill.source.source_type.as_str() {
        "mcp" => McpAdapter::default().invoke(invocation),
        "cli-tool" => invoke_cli_tool_server_skill(invocation),
        "graph" => Err(RuntimeError::UnsupportedAdapter {
            adapter_type: "graph".to_owned(),
        }),
        other => Err(RuntimeError::UnsupportedAdapter {
            adapter_type: other.to_owned(),
        }),
    }
}

#[cfg(feature = "cli-tool")]
fn invoke_cli_tool_server_skill(invocation: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
    crate::adapters::cli_tool::CliToolAdapter.invoke(invocation)
}

#[cfg(not(feature = "cli-tool"))]
fn invoke_cli_tool_server_skill(invocation: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
    Err(RuntimeError::UnsupportedAdapter {
        adapter_type: invocation.source.source_type.as_str().to_owned(),
    })
}

#[derive(Clone, Copy, Debug, Default)]
struct McpServerGraphAdapter;

impl SkillAdapter for McpServerGraphAdapter {
    fn adapter_type(&self) -> &'static str {
        "mcp-server-graph"
    }

    fn invoke(&self, request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
        match request.source.source_type.as_str() {
            "mcp" => McpAdapter::default().invoke(request),
            "cli-tool" => invoke_cli_tool_server_skill(request),
            other => Err(RuntimeError::UnsupportedAdapter {
                adapter_type: other.to_owned(),
            }),
        }
    }
}

#[derive(Default)]
struct McpServerHost {
    requests: Vec<ResolutionRequest>,
}

impl Host for McpServerHost {
    fn report(&mut self, _event: ExecutionEvent) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn resolve(
        &mut self,
        request: ResolutionRequest,
    ) -> Result<Option<ResolutionResponse>, RuntimeError> {
        self.requests.push(request);
        Ok(None)
    }
}

fn apply_input_defaults(skill: &ValidatedSkill, mut inputs: JsonObject) -> JsonObject {
    for (name, input) in &skill.inputs {
        if !inputs.contains_key(name)
            && let Some(default) = &input.default
        {
            inputs.insert(name.clone(), default.clone());
        }
    }
    inputs
}

fn input_resolution_request(
    skill: &ValidatedSkill,
    inputs: &JsonObject,
) -> Option<ResolutionRequest> {
    let questions = skill
        .inputs
        .iter()
        .filter(|(name, input)| input.required && missing_input(inputs.get(*name)))
        .map(|(name, input)| Question {
            id: name.clone().into(),
            prompt: input
                .description
                .clone()
                .unwrap_or_else(|| format!("Provide {name}."))
                .into(),
            description: input.description.clone(),
            required: true,
            question_type: input.input_type.clone().into(),
        })
        .collect::<Vec<_>>();
    (!questions.is_empty()).then(|| ResolutionRequest::Input {
        id: format!(
            "input.{}.{}",
            identifier_segment(&skill.name),
            questions
                .iter()
                .map(|question| identifier_segment(question.id.as_str()))
                .collect::<Vec<_>>()
                .join(".")
        )
        .into(),
        questions,
    })
}

fn missing_input(value: Option<&JsonValue>) -> bool {
    match value {
        None | Some(JsonValue::Null) => true,
        Some(JsonValue::String(value)) => value.is_empty(),
        Some(_) => false,
    }
}

fn completed_runx(
    skill_name: &str,
    run_id: &str,
    receipt_id: &str,
    output: &SkillOutput,
) -> JsonObject {
    let mut runx = terminal_runx("completed", skill_name, run_id, receipt_id);
    runx.insert(
        "output".to_owned(),
        JsonValue::String(output.stdout.clone()),
    );
    runx
}

pub(super) fn terminal_runx(
    status: &str,
    skill_name: &str,
    run_id: &str,
    receipt_id: &str,
) -> JsonObject {
    [
        ("status".to_owned(), JsonValue::String(status.to_owned())),
        (
            "skillName".to_owned(),
            JsonValue::String(skill_name.to_owned()),
        ),
        ("runId".to_owned(), JsonValue::String(run_id.to_owned())),
        (
            "receiptId".to_owned(),
            JsonValue::String(receipt_id.to_owned()),
        ),
        ("events".to_owned(), JsonValue::Array(Vec::new())),
    ]
    .into()
}

pub(super) fn needs_agent_runx(
    skill_name: &str,
    run_id: &str,
    requests: &[ResolutionRequest],
) -> Result<JsonObject, RuntimeError> {
    Ok([
        (
            "status".to_owned(),
            JsonValue::String("needs_agent".to_owned()),
        ),
        (
            "skillName".to_owned(),
            JsonValue::String(skill_name.to_owned()),
        ),
        ("runId".to_owned(), JsonValue::String(run_id.to_owned())),
        (
            "requests".to_owned(),
            JsonValue::Array(
                requests
                    .iter()
                    .map(serde_json_value)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        ),
        ("events".to_owned(), JsonValue::Array(Vec::new())),
    ]
    .into())
}

fn serde_json_value<T: serde::Serialize>(value: &T) -> Result<JsonValue, RuntimeError> {
    let serialized = serde_json::to_string(value)
        .map_err(|source| RuntimeError::json("serializing MCP host result", source))?;
    serde_json::from_str(&serialized)
        .map_err(|source| RuntimeError::json("deserializing MCP host result", source))
}

fn skill_directory_for_execution(skill_path: &Path) -> PathBuf {
    if skill_path.is_dir() {
        skill_path.to_path_buf()
    } else {
        skill_path
            .parent()
            .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
    }
}

pub(super) fn identifier_segment(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_owned()
}

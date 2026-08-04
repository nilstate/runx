// Module rationale: skill execution, graph fallback,
// runx envelope construction, and host plumbing for `runx mcp serve` stay
// adjacent to the server execution boundary.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use runx_contracts::{
    ExecutionEvent, JsonObject, JsonValue, Question, ResolutionRequest, ResolutionResponse,
};
use runx_core::state_machine::GraphStatus;
use runx_parser::{SkillInput, SkillRunnerDefinition, ValidatedSkill};

use crate::adapter::{InvocationOutput, SkillAdapter, SkillInvocation};
use crate::agent_invocation::{AgentActInvocationSourceType, agent_act_resolution_request};
use crate::execution::output_projection::project_step_claim;
use crate::host::Host;
use crate::output_contract::{
    attach_verified_metadata, project_declared_output_claim,
    verified_runner_metadata_with_artifacts,
};
use crate::receipts::{StepReceiptWithDisposition, step_receipt_with_declared_claim_and_policy};
use crate::services::ReceiptServices;
use crate::{GraphRun, Runtime, RuntimeError, RuntimeOptions};

use super::server::mcp_tool_result_from_host_result;
use super::types::{
    McpHostRunResult, McpServerExecutionOptions, McpServerOptions, McpServerSkillExecution,
    McpServerTool, McpServerToolBehavior, McpToolResult,
};

impl McpServerOptions {
    pub fn from_skill_paths_with_execution(
        skill_paths: &[PathBuf],
        package_name: impl Into<String>,
        package_version: impl Into<String>,
        execution: McpServerExecutionOptions,
    ) -> Result<Self, RuntimeError> {
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
    let loaded = crate::load_validated_skill_package(skill_path)?;
    let skill_path = loaded
        .directory
        .canonicalize()
        .map_err(|source| RuntimeError::io("canonicalizing skill path", source))?;
    let (skill, runner, requirements) =
        selected_mcp_runner(loaded.package, execution.runner.as_deref())?;
    let required_scopes = runner.declared_scopes();
    let credential_delivery = execution
        .credential_deliveries
        .get(&skill_path)
        .cloned()
        .unwrap_or_default();
    Ok(McpServerTool {
        name: skill.name.clone(),
        description: skill
            .description
            .clone()
            .unwrap_or_else(|| format!("runx skill {}", skill.name)),
        input_schema: skill_inputs_to_json_schema(&runner.inputs),
        required_scopes,
        result: McpServerToolBehavior::Skill(Box::new(McpServerSkillExecution {
            skill_path,
            skill_name: skill.name,
            runner,
            requirements,
            receipt_dir: execution.receipt_dir.clone(),
            env: execution.env.clone(),
            credential_delivery,
        })),
    })
}

fn selected_mcp_runner(
    package: runx_parser::ValidatedSkillPackage,
    requested_runner: Option<&str>,
) -> Result<
    (
        ValidatedSkill,
        SkillRunnerDefinition,
        runx_contracts::ExecutionRequirements,
    ),
    RuntimeError,
> {
    let manifest = package
        .root_manifest()
        .cloned()
        .ok_or_else(|| RuntimeError::SkillFailed {
            skill_name: package.skill.name.clone(),
            message: "skill package does not declare X.yaml runners".to_owned(),
        })?;
    let skill = package.skill;
    let runner = crate::execution::skill_front::runner_manifest::selected_runner(
        &manifest,
        requested_runner,
    )
    .map_err(|error| mcp_runner_error(&skill.name, error))?;
    Ok((
        skill,
        runner.clone(),
        manifest.execution_requirements(runner),
    ))
}

fn mcp_runner_error(skill_name: &str, error: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: skill_name.to_owned(),
        message: error.to_string(),
    }
}

fn skill_inputs_to_json_schema(inputs: &BTreeMap<String, SkillInput>) -> JsonObject {
    runx_contracts::input_contract_schema(inputs)
}

pub(super) fn execute_mcp_server_skill(
    run_id: &str,
    execution: McpServerSkillExecution,
    inputs: JsonObject,
    javascript: crate::adapters::javascript::JavaScriptAdapter,
) -> Result<McpToolResult, RuntimeError> {
    let mut inputs = inputs;
    crate::input_contract::apply_defaults(&execution.runner.inputs, &mut inputs);
    if let Some(request) =
        input_resolution_request(&execution.skill_name, &execution.runner.inputs, &inputs)
    {
        let skill_name = execution.skill_name.clone();
        return Ok(mcp_tool_result_from_host_result(
            McpHostRunResult::NeedsAgent {
                skill_name: skill_name.clone(),
                run_id: run_id.to_owned(),
                request_count: 1,
                runx: needs_agent_runx(&skill_name, run_id, &[request])?,
            },
        ));
    }

    if execution.runner.source.source_type == runx_parser::SourceKind::Graph {
        return execute_mcp_server_graph(run_id, execution, inputs, javascript);
    }
    if let Some(source_type) = AgentActInvocationSourceType::from_contract_value(
        execution.runner.source.source_type.as_str(),
    ) {
        let skill_name = execution.skill_name.clone();
        let mut invocation = mcp_skill_invocation(&execution, inputs);
        invocation.env.insert(
            crate::execution::runner::RUNX_RUN_ID_ENV.to_owned(),
            run_id.to_owned(),
        );
        let request = agent_act_resolution_request(&invocation, source_type)?;
        return pending_mcp_resolution_result(run_id, &skill_name, &request);
    }
    complete_mcp_server_skill(run_id, execution, inputs, &javascript)
}

fn execute_mcp_server_graph(
    run_id: &str,
    execution: McpServerSkillExecution,
    _inputs: JsonObject,
    javascript: crate::adapters::javascript::JavaScriptAdapter,
) -> Result<McpToolResult, RuntimeError> {
    let graph =
        execution
            .runner
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
    let runtime = Runtime::with_native_services(
        crate::execution::skill_front::SkillSourceAdapter::with_javascript(javascript.clone()),
        RuntimeOptions {
            created_at: crate::time::now_iso8601(),
            env,
            receipt_signature: receipts.signature_config().clone(),
            effects: Default::default(),
            credential_delivery: execution.credential_delivery.clone(),
        },
        javascript,
        crate::services::LocalArtifactService::default(),
    );
    let mut host = McpServerHost::default();
    let checkpoint = match runtime.run_graph_until_steps_with_host(&graph_dir, &graph, 1, &mut host)
    {
        Ok(checkpoint) => checkpoint,
        Err(RuntimeError::GraphBlocked { .. }) if !host.requests.is_empty() => {
            return pending_mcp_resolution_result(run_id, &execution.skill_name, &host.requests[0]);
        }
        Err(error) => return Err(error),
    };
    if let Some(request) = host.requests.first() {
        return pending_mcp_resolution_result(run_id, &execution.skill_name, request);
    }
    let run = runtime.resume_graph_with_host(&graph_dir, graph, checkpoint, &mut host)?;
    graph_run_mcp_result(&execution.skill_name, run_id, run)
}

fn pending_mcp_resolution_result(
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
        let output = crate::runner::graph_run_result(&run)?;
        let mut runx = terminal_runx("completed", skill_name, run_id, &run.receipt.id);
        runx.insert("output".to_owned(), output.clone());
        McpHostRunResult::Completed {
            skill_name: skill_name.to_owned(),
            output,
            receipt_id: run.receipt.id.to_string(),
            runx,
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
    javascript: &crate::adapters::javascript::JavaScriptAdapter,
) -> Result<McpToolResult, RuntimeError> {
    let receipts = ReceiptServices::from_env(&execution.env).map_err(|error| {
        RuntimeError::ReceiptInvalid {
            message: error.to_string(),
        }
    })?;
    let output = invoke_mcp_server_skill(&execution, inputs, javascript)?;
    let claim = if output.succeeded() {
        project_declared_output_claim(
            &execution.skill_name,
            &output.value,
            execution.runner.source.outputs.as_ref(),
            execution.runner.artifacts.as_ref(),
        )?
    } else {
        JsonObject::new()
    };
    let projection = project_step_claim(claim);
    let created_at = crate::time::now_iso8601();
    let receipt = step_receipt_with_declared_claim_and_policy(
        StepReceiptWithDisposition::with_default_closure(
            run_id,
            &execution.skill_name,
            1,
            &output,
            &created_at,
        ),
        &projection.outputs,
        projection.refs,
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
            skill_name: execution.skill_name.clone(),
            output: output.value.clone(),
            receipt_id: receipt.id.to_string(),
            runx: completed_runx(&execution.skill_name, run_id, &receipt.id, &output),
        }
    } else {
        McpHostRunResult::Failed {
            skill_name: execution.skill_name.clone(),
            receipt_id: Some(receipt.id.to_string()),
            error: output
                .failure_message()
                .unwrap_or_else(|| "skill execution failed".to_owned()),
            runx: terminal_runx("failed", &execution.skill_name, run_id, &receipt.id),
        }
    };
    Ok(mcp_tool_result_from_host_result(result))
}

fn invoke_mcp_server_skill(
    execution: &McpServerSkillExecution,
    inputs: JsonObject,
    javascript: &crate::adapters::javascript::JavaScriptAdapter,
) -> Result<InvocationOutput, RuntimeError> {
    let invocation = mcp_skill_invocation(execution, inputs);
    let mut output =
        crate::execution::skill_front::SkillSourceAdapter::with_javascript(javascript.clone())
            .invoke(invocation)?;
    if output.succeeded() {
        let metadata = verified_runner_metadata_with_artifacts(
            &execution.skill_name,
            &output.value,
            execution.runner.source.outputs.as_ref(),
            execution.runner.artifacts.as_ref(),
            &skill_directory_for_execution(&execution.skill_path),
            &execution.env,
        )?;
        attach_verified_metadata(&mut output, metadata)?;
    }
    Ok(output)
}

fn mcp_skill_invocation(
    execution: &McpServerSkillExecution,
    inputs: JsonObject,
) -> SkillInvocation {
    SkillInvocation {
        skill_name: execution.skill_name.clone(),
        step_id: None,
        source: execution.runner.source.clone(),
        requirements: execution.requirements.clone(),
        artifacts: execution.runner.artifacts.clone(),
        allowed_tools: execution.runner.allowed_tools.clone(),
        inputs,
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        provenance: Vec::new(),
        skill_directory: skill_directory_for_execution(&execution.skill_path),
        env: execution.env.clone(),
        credential_delivery: execution.credential_delivery.clone(),
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

    fn log(&mut self, _message: String) -> Result<(), RuntimeError> {
        Ok(())
    }
}

fn input_resolution_request(
    skill_name: &str,
    declared_inputs: &BTreeMap<String, SkillInput>,
    inputs: &JsonObject,
) -> Option<ResolutionRequest> {
    let questions = declared_inputs
        .iter()
        .filter(|(name, input)| {
            input.required && crate::input_contract::is_missing(inputs.get(*name))
        })
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
            identifier_segment(skill_name),
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

fn completed_runx(
    skill_name: &str,
    run_id: &str,
    receipt_id: &str,
    output: &InvocationOutput,
) -> JsonObject {
    let mut runx = terminal_runx("completed", skill_name, run_id, receipt_id);
    runx.insert("output".to_owned(), output.value.clone());
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

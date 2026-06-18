// rust-style-allow: large-file because harness replay owns fixture loading,
// adapter invocation, receipt assertion, and graph replay sealing as one
// deterministic proof path until MCP replay creates a separate module boundary.

mod dispositions;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use dispositions::{
    agent_answer_disposition, agent_task_output, disposition_from_expected_status,
    disposition_suffix, named_reason_code, process_reason_code, required_string_metadata,
    skill_output_object, string_metadata,
};
use runx_contracts::{
    ClosureDisposition, ExecutionEvent, JsonObject, JsonValue, Receipt, ResolutionRequest,
    ResolutionResponse, ResolutionResponseActor,
};
use runx_core::state_machine::StepAdmissionWitness;
use runx_parser::{
    SkillRunnerDefinition, SkillRunnerManifest, parse_runner_manifest_yaml,
    validate_runner_manifest,
};
use thiserror::Error;

use super::super::graph::{load_skill, materialize_graph_inputs};
use super::assertions::{assert_expectations, status_from_disposition};
use super::fixtures::{
    HarnessExpectedStatus, HarnessFixture, HarnessFixtureError, HarnessFixtureKind,
    fixture_kind_name, load_harness_fixture,
};
use crate::RuntimeError;
use crate::adapter::{InvocationStatus, SkillAdapter, SkillInvocation, SkillOutput};
use crate::agent_invocation::{AgentActInvocationSourceType, agent_act_invocation_id};
use crate::effects::RuntimeEffectRegistry;
use crate::execution::runner::{GraphRun, Runtime, RuntimeOptions, StepRun};
use crate::host::Host;
use crate::receipts::{
    GraphClosure, StepReceiptWithDisposition, graph_receipt_with_disposition_and_policy,
    step_receipt_with_disposition_and_policy,
};

#[derive(Clone, Debug)]
pub struct HarnessReplayOutput {
    pub fixture: HarnessFixture,
    pub status: HarnessExpectedStatus,
    pub receipt: Receipt,
    pub step_receipts: Vec<Receipt>,
    pub steps: Vec<StepRun>,
    pub skill_output: Option<SkillOutput>,
}

#[derive(Debug, Error)]
pub enum HarnessReplayError {
    #[error(transparent)]
    Fixture(#[from] HarnessFixtureError),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    #[error("harness fixture target {target} has no parent directory")]
    TargetWithoutParent { target: PathBuf },
    #[error("harness expectation mismatch at {field}: expected {expected}, actual {actual}")]
    Mismatch {
        field: &'static str,
        expected: String,
        actual: String,
    },
    #[error("receipt digest failed: {message}")]
    ReceiptDigest { message: String },
    #[error("receipt proof failed for {receipt_id}: {findings}")]
    ReceiptProofInvalid {
        receipt_id: String,
        findings: String,
    },
    #[error("harness fixture mode {mode} at {field_path} is not yet supported by the Rust harness")]
    UnsupportedFixtureMode { mode: String, field_path: String },
    #[error("invalid harness replay metadata at {field}: {message}")]
    InvalidReplayMetadata { field: String, message: String },
    #[error(
        "native cli-tool harness replay is unavailable because runx-runtime was built without the cli-tool feature"
    )]
    CliToolFeatureDisabled,
}

pub fn run_harness_fixture(
    fixture_path: impl AsRef<Path>,
) -> Result<HarnessReplayOutput, HarnessReplayError> {
    #[cfg(feature = "cli-tool")]
    {
        run_harness_fixture_with_adapter(
            fixture_path,
            crate::execution::skill_front::SkillRunGraphAdapter::default(),
            fixture_runtime_options()?,
        )
    }
    #[cfg(not(feature = "cli-tool"))]
    {
        let _ = fixture_path;
        Err(HarnessReplayError::CliToolFeatureDisabled)
    }
}

#[cfg(feature = "cli-tool")]
pub fn run_harness_fixture_cli_tool(
    fixture_path: impl AsRef<Path>,
) -> Result<HarnessReplayOutput, HarnessReplayError> {
    run_harness_fixture_with_adapter(
        fixture_path,
        crate::execution::skill_front::SkillRunGraphAdapter::default(),
        fixture_runtime_options()?,
    )
}

#[cfg(feature = "cli-tool")]
fn fixture_runtime_options() -> Result<RuntimeOptions, HarnessReplayError> {
    Ok(RuntimeOptions {
        created_at: crate::time::DEFAULT_CREATED_AT.to_owned(),
        ..RuntimeOptions::from_process_env()?
    })
}

pub fn run_harness_fixture_with_adapter<A>(
    fixture_path: impl AsRef<Path>,
    adapter: A,
    options: RuntimeOptions,
) -> Result<HarnessReplayOutput, HarnessReplayError>
where
    A: SkillAdapter,
{
    let fixture_path = fixture_path.as_ref();
    let fixture = load_harness_fixture(fixture_path)?;
    let target_path = resolve_target_path(fixture_path, &fixture.target)?;
    let receipt_signature = options.receipt_signature.clone();
    let output = match fixture.kind {
        HarnessFixtureKind::Skill | HarnessFixtureKind::A2a | HarnessFixtureKind::Agent => {
            run_skill_fixture(&fixture, target_path, adapter, options)?
        }
        HarnessFixtureKind::AgentStep => run_agent_task_fixture(&fixture, options)?,
        HarnessFixtureKind::Graph if is_fixture_replay_graph(&fixture) => {
            run_graph_replay_fixture(&fixture, options)?
        }
        HarnessFixtureKind::Graph => run_graph_fixture(&fixture, &target_path, adapter, options)?,
        HarnessFixtureKind::Mcp => {
            return Err(HarnessReplayError::UnsupportedFixtureMode {
                mode: fixture_kind_name(&fixture.kind).to_owned(),
                field_path: "kind".to_owned(),
            });
        }
    };
    assert_expectations(&output, receipt_signature.signature_policy())?;
    Ok(output)
}

fn run_agent_task_fixture(
    fixture: &HarnessFixture,
    options: RuntimeOptions,
) -> Result<HarnessReplayOutput, HarnessReplayError> {
    let replay_name = fixture.runner.as_deref().unwrap_or(&fixture.name);
    let request_id = format!("agent_task.{replay_name}.output");
    let output = agent_task_output(fixture, &request_id)?;
    let disposition = fixture
        .expect
        .status
        .as_ref()
        .map(disposition_from_expected_status)
        .unwrap_or_else(|| {
            if output.succeeded() {
                ClosureDisposition::Closed
            } else {
                ClosureDisposition::Failed
            }
        });
    let receipt = step_receipt_with_disposition_and_policy(
        StepReceiptWithDisposition {
            graph_name: &fixture.name,
            step_id: &fixture.name,
            attempt: 1,
            output: &output,
            created_at: &options.created_at,
            disposition: disposition.clone(),
            reason_code: process_reason_code(&disposition),
            summary: format!("agent-task {} completed", fixture.name),
        },
        options.signature_policy(),
    )?;
    Ok(HarnessReplayOutput {
        fixture: fixture.clone(),
        status: status_from_disposition(&receipt.seal.disposition),
        receipt,
        step_receipts: Vec::new(),
        steps: Vec::new(),
        skill_output: Some(output),
    })
}

#[derive(Clone, Debug)]
struct GraphReplayStep {
    step_id: String,
    task: String,
    request_id: String,
}

fn is_fixture_replay_graph(fixture: &HarnessFixture) -> bool {
    string_metadata(fixture, "graph_shape") == Some("fixture_replay")
}

// rust-style-allow: long-function because graph replay receipt assembly keeps
// step runs, closure disposition, and parent receipt sealing in one invariant.
fn run_graph_replay_fixture(
    fixture: &HarnessFixture,
    options: RuntimeOptions,
) -> Result<HarnessReplayOutput, HarnessReplayError> {
    let mut runs = Vec::new();
    for replay_step in graph_replay_steps(fixture)? {
        let output = agent_task_output(fixture, &replay_step.request_id)?;
        let disposition = if output.succeeded() {
            ClosureDisposition::Closed
        } else {
            ClosureDisposition::Deferred
        };
        let receipt = step_receipt_with_disposition_and_policy(
            StepReceiptWithDisposition {
                graph_name: &fixture.name,
                step_id: &replay_step.step_id,
                attempt: 1,
                output: &output,
                created_at: &options.created_at,
                disposition: disposition.clone(),
                reason_code: process_reason_code(&disposition),
                summary: if output.succeeded() {
                    format!("agent-task {} replayed", replay_step.task)
                } else {
                    output.stderr.clone()
                },
            },
            options.signature_policy(),
        )?;
        let outputs = skill_output_object(&output);
        let succeeded = output.succeeded();
        let admission_witness =
            StepAdmissionWitness::local_runtime(&replay_step.step_id, receipt.id.as_str());
        runs.push(StepRun {
            step_id: replay_step.step_id,
            attempt: 1,
            skill: replay_step.task.clone(),
            runner: Some(replay_step.task),
            fanout_group: None,
            output,
            outputs,
            receipt,
            admission_witness,
        });
        if !succeeded {
            break;
        }
    }
    if runs.is_empty() {
        return Err(HarnessReplayError::InvalidReplayMetadata {
            field: "metadata.graph_replay_steps".to_owned(),
            message: "at least one replay step is required".to_owned(),
        });
    }
    let disposition = fixture
        .expect
        .status
        .as_ref()
        .map(disposition_from_expected_status)
        .unwrap_or_else(|| {
            if runs.iter().all(|run| run.output.succeeded()) {
                ClosureDisposition::Closed
            } else {
                ClosureDisposition::Deferred
            }
        });
    let receipt = graph_receipt_with_disposition_and_policy(
        &fixture.name,
        &mut runs,
        Vec::new(),
        &options.created_at,
        GraphClosure {
            disposition: disposition.clone(),
            reason_code: named_reason_code(&fixture.name, &disposition),
            summary: format!("graph {} replayed through fixture harness", fixture.name),
        },
        RuntimeEffectRegistry::default(),
        options.signature_policy(),
    )?;
    let step_receipts = runs
        .iter()
        .map(|run| run.receipt.clone())
        .collect::<Vec<_>>();
    let skill_output = runs
        .iter()
        .rev()
        .find(|run| run.output.succeeded())
        .or_else(|| runs.last())
        .map(|run| run.output.clone());
    Ok(HarnessReplayOutput {
        fixture: fixture.clone(),
        status: status_from_disposition(&receipt.seal.disposition),
        receipt,
        step_receipts,
        steps: runs,
        skill_output,
    })
}

fn graph_replay_steps(
    fixture: &HarnessFixture,
) -> Result<Vec<GraphReplayStep>, HarnessReplayError> {
    let Some(JsonValue::Array(raw_steps)) = fixture.metadata.get("graph_replay_steps") else {
        return Err(HarnessReplayError::InvalidReplayMetadata {
            field: "metadata.graph_replay_steps".to_owned(),
            message: "array is required for fixture replay graphs".to_owned(),
        });
    };
    raw_steps
        .iter()
        .enumerate()
        .map(|(index, raw_step)| {
            let JsonValue::Object(step) = raw_step else {
                return Err(HarnessReplayError::InvalidReplayMetadata {
                    field: format!("metadata.graph_replay_steps.{index}"),
                    message: "object is required".to_owned(),
                });
            };
            let step_id = required_string_metadata(
                step,
                &format!("metadata.graph_replay_steps.{index}.step_id"),
                "step_id",
            )?;
            let task = required_string_metadata(
                step,
                &format!("metadata.graph_replay_steps.{index}.task"),
                "task",
            )?;
            Ok(GraphReplayStep {
                request_id: format!("agent_task.{task}.output"),
                step_id,
                task,
            })
        })
        .collect()
}

fn run_skill_fixture<A>(
    fixture: &HarnessFixture,
    skill_dir: PathBuf,
    adapter: A,
    options: RuntimeOptions,
) -> Result<HarnessReplayOutput, HarnessReplayError>
where
    A: SkillAdapter,
{
    let (skill_name, invocation) = skill_fixture_invocation(fixture, skill_dir, &options)?;
    if invocation.source.source_type == runx_parser::SourceKind::Graph {
        if is_fixture_replay_graph(fixture) {
            return run_graph_replay_fixture(fixture, options);
        }
        return run_graph_skill_fixture(fixture, skill_name, invocation, adapter, options);
    }
    let (skill_output, disposition, reason_code, summary) =
        run_skill_invocation(fixture, invocation, adapter)?;
    let receipt = step_receipt_with_disposition_and_policy(
        StepReceiptWithDisposition {
            graph_name: &fixture.name,
            step_id: &skill_name,
            attempt: 1,
            output: &skill_output,
            created_at: &options.created_at,
            disposition: disposition.clone(),
            reason_code,
            summary,
        },
        options.signature_policy(),
    )?;
    Ok(HarnessReplayOutput {
        fixture: fixture.clone(),
        status: status_from_disposition(&receipt.seal.disposition),
        receipt,
        step_receipts: Vec::new(),
        steps: Vec::new(),
        skill_output: Some(skill_output),
    })
}

fn run_graph_skill_fixture<A>(
    fixture: &HarnessFixture,
    skill_name: String,
    invocation: SkillInvocation,
    adapter: A,
    mut options: RuntimeOptions,
) -> Result<HarnessReplayOutput, HarnessReplayError>
where
    A: SkillAdapter,
{
    let graph = invocation
        .source
        .graph
        .clone()
        .ok_or_else(|| RuntimeError::UnsupportedSource {
            source_kind: "graph runner without source.graph".to_owned(),
        })?;
    let graph = materialize_graph_inputs(graph, &invocation.inputs);
    overlay_harness_env(&mut options, &invocation.env);
    options
        .env
        .entry(crate::execution::runner::RUNX_RUN_ID_ENV.to_owned())
        .or_insert_with(|| format!("harness-{}", fixture.name));
    let runtime = Runtime::new(adapter, options);
    let mut host = FixtureHost::new(fixture);
    let graph_run = runtime.run_graph_with_host(&invocation.skill_directory, graph, &mut host)?;
    let mut output = replay_output_from_graph(fixture, graph_run);
    if output.skill_output.is_none() {
        output.skill_output = output
            .steps
            .iter()
            .rev()
            .find(|run| run.output.succeeded())
            .or_else(|| output.steps.last())
            .map(|run| run.output.clone());
    }
    if output.steps.is_empty() {
        return Err(RuntimeError::UnsupportedSource {
            source_kind: format!("graph runner {skill_name} produced no steps"),
        }
        .into());
    }
    Ok(output)
}

fn skill_fixture_invocation(
    fixture: &HarnessFixture,
    skill_dir: PathBuf,
    options: &RuntimeOptions,
) -> Result<(String, SkillInvocation), HarnessReplayError> {
    let skill = load_skill(&skill_dir)?;
    let runner = load_harness_runner(&skill_dir, fixture.runner.as_deref())?;
    let mut env = options.env.clone();
    env.extend(fixture.env.clone());
    let skill_name = if fixture.runner.is_some() {
        runner
            .as_ref()
            .map_or_else(|| skill.name.clone(), |runner| runner.name.clone())
    } else {
        skill.name.clone()
    };
    let source = runner
        .as_ref()
        .map_or_else(|| skill.source.clone(), |runner| runner.source.clone());
    let invocation = SkillInvocation {
        skill_name: skill_name.clone(),
        source,
        inputs: fixture.inputs.clone(),
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: skill_dir,
        env,
        credential_delivery: crate::credentials::CredentialDelivery::none(),
    };
    Ok((skill_name, invocation))
}

fn run_skill_invocation<A>(
    fixture: &HarnessFixture,
    invocation: SkillInvocation,
    adapter: A,
) -> Result<(SkillOutput, ClosureDisposition, String, String), HarnessReplayError>
where
    A: SkillAdapter,
{
    let skill_name = invocation.skill_name.clone();
    let (skill_output, disposition, reason_code, summary) =
        match invocation.source.source_type.as_str() {
            "agent" | "agent-task" => replay_agent_skill_fixture(fixture, &invocation)?,
            _ => {
                let output = adapter.invoke(invocation)?;
                let disposition = if output.succeeded() {
                    ClosureDisposition::Closed
                } else {
                    ClosureDisposition::Failed
                };
                let reason_code = process_reason_code(&disposition);
                let summary = format!("step {skill_name} completed");
                (output, disposition, reason_code, summary)
            }
        };
    Ok((skill_output, disposition, reason_code, summary))
}

fn load_harness_runner(
    skill_dir: &Path,
    requested_runner: Option<&str>,
) -> Result<Option<SkillRunnerDefinition>, HarnessReplayError> {
    let manifest_path = skill_dir.join("X.yaml");
    if !manifest_path.exists() {
        if let Some(runner) = requested_runner {
            return Err(RuntimeError::UnsupportedRunnerSelection {
                runner: runner.to_owned(),
            }
            .into());
        }
        return Ok(None);
    }
    let source = fs::read_to_string(&manifest_path).map_err(|source| {
        RuntimeError::io(format!("reading {}", manifest_path.display()), source)
    })?;
    let parsed = parse_runner_manifest_yaml(&source).map_err(RuntimeError::from)?;
    let manifest = validate_runner_manifest(parsed).map_err(RuntimeError::from)?;
    select_harness_runner(&manifest, requested_runner)
        .cloned()
        .map(Some)
}

fn select_harness_runner<'a>(
    manifest: &'a SkillRunnerManifest,
    requested_runner: Option<&str>,
) -> Result<&'a SkillRunnerDefinition, HarnessReplayError> {
    if let Some(runner) = requested_runner {
        return manifest.runners.get(runner).ok_or_else(|| {
            RuntimeError::UnsupportedRunnerSelection {
                runner: runner.to_owned(),
            }
            .into()
        });
    }
    let defaults = manifest
        .runners
        .values()
        .filter(|runner| runner.default)
        .collect::<Vec<_>>();
    match defaults.as_slice() {
        [runner] => Ok(*runner),
        [] if manifest.runners.len() == 1 => manifest.runners.values().next().ok_or_else(|| {
            RuntimeError::UnsupportedRunnerSelection {
                runner: "default".to_owned(),
            }
            .into()
        }),
        [] => Err(RuntimeError::UnsupportedRunnerSelection {
            runner: "default".to_owned(),
        }
        .into()),
        _ => Err(RuntimeError::UnsupportedRunnerSelection {
            runner: "default".to_owned(),
        }
        .into()),
    }
}

fn replay_agent_skill_fixture(
    fixture: &HarnessFixture,
    invocation: &SkillInvocation,
) -> Result<(SkillOutput, ClosureDisposition, String, String), HarnessReplayError> {
    let source_type =
        AgentActInvocationSourceType::from_contract_value(invocation.source.source_type.as_str())
            .ok_or_else(|| RuntimeError::UnsupportedAdapter {
            adapter_type: invocation.source.source_type.as_str().to_owned(),
        })?;
    let request_id = agent_act_invocation_id(invocation, source_type);
    let mut metadata = JsonObject::new();
    metadata.insert(
        "agent_request_id".to_owned(),
        JsonValue::String(request_id.clone()),
    );
    let Some(answer) = fixture_answer(fixture, "answers", &request_id, &request_id) else {
        return Ok((
            SkillOutput {
                status: InvocationStatus::Failure,
                stdout: String::new(),
                stderr: format!("missing replay answer for {request_id}"),
                exit_code: None,
                duration_ms: 0,
                metadata,
            },
            ClosureDisposition::Deferred,
            "agent_act_deferred".to_owned(),
            format!("agent act {request_id} is awaiting replay answer"),
        ));
    };
    let stdout = serde_json::to_string(answer).map_err(|source| RuntimeError::Json {
        context: format!("serializing replay answer {request_id}"),
        source,
    })?;
    let disposition = agent_answer_disposition(answer);
    let succeeded = disposition == ClosureDisposition::Closed;
    Ok((
        SkillOutput {
            status: if succeeded {
                InvocationStatus::Success
            } else {
                InvocationStatus::Failure
            },
            stdout,
            stderr: if succeeded {
                String::new()
            } else {
                format!("agent act closed with {}", disposition_suffix(&disposition))
            },
            exit_code: succeeded.then_some(0),
            duration_ms: 0,
            metadata,
        },
        disposition.clone(),
        format!("agent_act_{}", disposition_suffix(&disposition)),
        format!("agent act closed with {}", disposition_suffix(&disposition)),
    ))
}

fn run_graph_fixture<A>(
    fixture: &HarnessFixture,
    graph_path: &Path,
    adapter: A,
    mut options: RuntimeOptions,
) -> Result<HarnessReplayOutput, HarnessReplayError>
where
    A: SkillAdapter,
{
    overlay_harness_env(&mut options, &fixture.env);
    // Harness graph replays need a deterministic run_id so per-run governance
    // can resolve one, mirroring the production graph runner. Derived from the
    // graph so receipts stay reproducible; an explicit fixture env value still
    // wins.
    options
        .env
        .entry(crate::execution::runner::RUNX_RUN_ID_ENV.to_owned())
        .or_insert_with(|| {
            let stem = graph_path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("graph");
            format!("harness-{stem}")
        });
    let runtime = Runtime::new(adapter, options);
    let mut host = FixtureHost::new(fixture);
    let graph_run = runtime.run_graph_file_for_harness(graph_path, &mut host)?;
    let output = replay_output_from_graph(fixture, graph_run);
    Ok(output)
}

struct FixtureHost<'a> {
    fixture: &'a HarnessFixture,
}

impl<'a> FixtureHost<'a> {
    fn new(fixture: &'a HarnessFixture) -> Self {
        Self { fixture }
    }
}

impl Host for FixtureHost<'_> {
    fn report(&mut self, _event: ExecutionEvent) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn resolve(
        &mut self,
        request: ResolutionRequest,
    ) -> Result<Option<ResolutionResponse>, RuntimeError> {
        match request {
            ResolutionRequest::Approval { id, gate } => {
                fixture_approval_response(self.fixture, &id, &gate.id)
            }
            ResolutionRequest::AgentAct { id, .. } => {
                fixture_agent_act_response(self.fixture, id.as_str())
            }
            ResolutionRequest::Input { .. } => Ok(None),
        }
    }
}

fn fixture_agent_act_response(
    fixture: &HarnessFixture,
    request_id: &str,
) -> Result<Option<ResolutionResponse>, RuntimeError> {
    let Some(answer) = fixture_answer(fixture, "answers", request_id, request_id) else {
        return Ok(None);
    };
    Ok(Some(ResolutionResponse {
        actor: ResolutionResponseActor::Agent,
        payload: answer.clone(),
    }))
}

fn fixture_approval_response(
    fixture: &HarnessFixture,
    request_id: &str,
    gate_id: &str,
) -> Result<Option<ResolutionResponse>, RuntimeError> {
    let Some(answer) = fixture_answer(fixture, "approvals", gate_id, request_id)
        .or_else(|| fixture_answer(fixture, "answers", request_id, gate_id))
    else {
        return Ok(None);
    };
    let approved = fixture_bool_answer(answer, request_id, gate_id)?;
    Ok(Some(ResolutionResponse {
        actor: fixture_answer_actor(answer, request_id, gate_id)?,
        payload: JsonValue::Bool(approved),
    }))
}

fn fixture_answer<'a>(
    fixture: &'a HarnessFixture,
    group: &str,
    primary_key: &str,
    secondary_key: &str,
) -> Option<&'a JsonValue> {
    fixture
        .caller
        .get(group)
        .and_then(JsonValue::as_object)
        .and_then(|answers| {
            answers
                .get(primary_key)
                .or_else(|| answers.get(secondary_key))
        })
}

fn fixture_bool_answer(
    answer: &JsonValue,
    request_id: &str,
    gate_id: &str,
) -> Result<bool, RuntimeError> {
    match answer {
        JsonValue::Bool(value) => Ok(*value),
        JsonValue::Object(object) => match object.get("approved").or_else(|| object.get("payload"))
        {
            Some(JsonValue::Bool(value)) => Ok(*value),
            Some(_) | None => Err(invalid_fixture_answer(request_id, gate_id)),
        },
        JsonValue::Null | JsonValue::Number(_) | JsonValue::String(_) | JsonValue::Array(_) => {
            Err(invalid_fixture_answer(request_id, gate_id))
        }
    }
}

fn fixture_answer_actor(
    answer: &JsonValue,
    request_id: &str,
    gate_id: &str,
) -> Result<ResolutionResponseActor, RuntimeError> {
    let Some(actor) = answer.as_object().and_then(|object| object.get("actor")) else {
        return Ok(ResolutionResponseActor::Human);
    };
    match actor {
        JsonValue::String(value) if value == "human" => Ok(ResolutionResponseActor::Human),
        JsonValue::String(value) if value == "agent" => Ok(ResolutionResponseActor::Agent),
        _ => Err(RuntimeError::ReceiptInvalid {
            message: format!(
                "harness fixture approval answer for request {request_id} gate {gate_id} has invalid actor"
            ),
        }),
    }
}

fn invalid_fixture_answer(request_id: &str, gate_id: &str) -> RuntimeError {
    RuntimeError::ReceiptInvalid {
        message: format!(
            "harness fixture approval answer for request {request_id} gate {gate_id} must be a boolean or object with a boolean approved field"
        ),
    }
}

fn replay_output_from_graph(fixture: &HarnessFixture, graph_run: GraphRun) -> HarnessReplayOutput {
    let step_receipts = graph_run
        .steps
        .iter()
        .map(|step| step.receipt.clone())
        .collect::<Vec<_>>();
    HarnessReplayOutput {
        fixture: fixture.clone(),
        status: status_from_disposition(&graph_run.receipt.seal.disposition),
        receipt: graph_run.receipt,
        step_receipts,
        steps: graph_run.steps,
        skill_output: None,
    }
}

fn resolve_target_path(fixture_path: &Path, target: &str) -> Result<PathBuf, HarnessReplayError> {
    let Some(parent) = fixture_path.parent() else {
        return Err(HarnessReplayError::TargetWithoutParent {
            target: fixture_path.to_path_buf(),
        });
    };
    Ok(parent.join(target))
}

fn overlay_harness_env(options: &mut RuntimeOptions, env: &BTreeMap<String, String>) {
    options.env.extend(env.clone());
}

#[cfg(test)]
mod tests {
    use super::overlay_harness_env;
    use crate::credentials::CredentialDelivery;
    use crate::effects::RuntimeEffectRegistry;
    use crate::execution::runner::RuntimeOptions;
    use crate::receipts::RuntimeReceiptSignatureConfig;
    use std::collections::BTreeMap;

    #[test]
    fn overlay_harness_env_preserves_operator_env_and_allows_fixture_override() {
        let mut options = RuntimeOptions {
            created_at: "2026-05-18T00:00:00Z".to_owned(),
            env: BTreeMap::from([
                (
                    "RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY".to_owned(),
                    "local".to_owned(),
                ),
                ("FIXTURE_OVERRIDE".to_owned(), "operator".to_owned()),
            ]),
            receipt_signature: RuntimeReceiptSignatureConfig::local_development(),
            effects: RuntimeEffectRegistry::default(),
            credential_delivery: CredentialDelivery::none(),
        };
        let fixture_env = BTreeMap::from([
            ("FIXTURE_OVERRIDE".to_owned(), "fixture".to_owned()),
            ("FIXTURE_ONLY".to_owned(), "fixture".to_owned()),
        ]);

        overlay_harness_env(&mut options, &fixture_env);

        assert_eq!(
            options.env.get("RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY"),
            Some(&"local".to_owned())
        );
        assert_eq!(
            options.env.get("FIXTURE_OVERRIDE"),
            Some(&"fixture".to_owned())
        );
        assert_eq!(options.env.get("FIXTURE_ONLY"), Some(&"fixture".to_owned()));
    }
}

// rust-style-allow: large-file because graph step execution currently keeps
// authority admission, native step execution, approval handling, and effect
// state persistence in one runtime boundary until the runner module split.

mod output;

use std::path::Path;

use output::{ClaimContextExposure, build_step_output_projection, step_output_projection};

use runx_contracts::{
    ApprovalGate, ClosureDisposition, ExecutionEvent, JsonObject, JsonValue, Receipt,
    ResolutionRequest, ResolutionResponse, ResolutionResponseActor,
};
use runx_core::state_machine::{GraphStatus, StepAdmissionWitness};
use runx_parser::{GraphStep, SkillSource, SourceKind};

use super::super::graph::{
    LoadedStepSkill, StepSkillLoadOptions, load_step_skill, materialize_graph_inputs,
};
use super::super::skill_context::load_context_skills;
use super::authority::{
    EffectReceiptContext, StepAuthorityContext, enforce_step_authority_admission,
    finalize_effect_output_before_success, find_effect_replay, persist_effect_state_for_step,
    prepare_effect_output_before_gate, prepare_replay_output, recover_pending_effects,
    validate_replayed_effect,
};
use super::host_resolution::resolve_step_approval;
use super::inputs::{optional_input_string, required_input_string, string_value, string_value_ref};
use super::{GraphRun, Runtime, StepRun};
use crate::RuntimeError;
use crate::adapter::{InvocationStatus, SkillAdapter, SkillInvocation, SkillOutput};
#[cfg(feature = "catalog")]
use crate::adapters::catalog::CatalogAdapter;
use crate::agent_invocation::{
    AgentActInvocationSourceType, agent_act_invocation_id, agent_act_resolution_request,
};
use crate::approval::ApprovalResolution;
use crate::effects::EffectReplay;
use crate::execution::output_projection::{StepOutputProjection, project_step_output};
use crate::host::Host;
use crate::receipts::{StepSeal, StepSealClosure, seal_step};

const EXTERNAL_ADAPTER_HOST_RESOLUTION_REQUEST_METADATA: &str =
    "external_adapter_host_resolution_request";
const EXTERNAL_ADAPTER_HOST_RESOLUTION_RESPONSE_METADATA: &str =
    "external_adapter_host_resolution_response";

struct AgentSkillStepInvocation {
    skill_name: String,
    invocation: SkillInvocation,
    source_type: AgentActInvocationSourceType,
}

struct RegularSkillStepOutput {
    output: SkillOutput,
    projection: StepOutputProjection,
}

pub(super) struct StepRunRequest<'a, A> {
    pub(super) runtime: &'a Runtime<A>,
    pub(super) graph_dir: &'a Path,
    pub(super) graph_name: &'a str,
    pub(super) step: &'a GraphStep,
    pub(super) attempt: u32,
    pub(super) inputs: JsonObject,
    pub(super) host: &'a mut dyn Host,
}

struct StepHandlerCtx<'a, A> {
    runtime: &'a Runtime<A>,
    graph_dir: &'a Path,
    graph_name: &'a str,
    step: &'a GraphStep,
    attempt: u32,
    inputs: JsonObject,
    host: &'a mut dyn Host,
    authority: Option<StepAuthorityContext>,
    loaded_skill: Option<LoadedStepSkill>,
}

type StepHandlerFn<A> = fn(StepHandlerCtx<'_, A>) -> Result<StepRun, RuntimeError>;

struct StepTypeHandler<A> {
    step_type: &'static str,
    handler: StepHandlerFn<A>,
}

pub(super) struct StepTypeRegistry<A> {
    handlers: [StepTypeHandler<A>; 5],
}

impl<A> StepTypeRegistry<A>
where
    A: SkillAdapter,
{
    pub(super) fn builtins() -> Self {
        Self {
            handlers: [
                StepTypeHandler {
                    step_type: "approval",
                    handler: run_approval_step_handler::<A>,
                },
                StepTypeHandler {
                    step_type: "agent-task",
                    handler: run_agent_task_handler::<A>,
                },
                StepTypeHandler {
                    step_type: "cli-tool",
                    handler: run_cli_tool_step_handler::<A>,
                },
                StepTypeHandler {
                    step_type: "tool",
                    handler: run_tool_step_handler::<A>,
                },
                StepTypeHandler {
                    step_type: "subskill",
                    handler: run_subskill_step_handler::<A>,
                },
            ],
        }
    }

    fn handler(&self, step_type: &str) -> Option<StepHandlerFn<A>> {
        self.handlers
            .iter()
            .find(|registered| registered.step_type == step_type)
            .map(|registered| registered.handler)
    }
}

struct RegularSkillSeal<'a, A> {
    runtime: &'a Runtime<A>,
    graph_dir: &'a Path,
    graph_name: &'a str,
    step: &'a GraphStep,
    attempt: u32,
    skill_name: String,
    authority: Option<&'a StepAuthorityContext>,
}

pub(super) fn output_error(run: &StepRun) -> String {
    if run.output.stderr.is_empty() {
        "cli-tool failed without stderr".to_owned()
    } else {
        run.output.stderr.clone()
    }
}

// rust-style-allow: long-function - step execution is one linear admit/run/seal sequence; splitting
// it would scatter the ordering invariants between admission, invocation, and receipt sealing.
pub(super) fn run_step_with_inputs<A>(
    runtime: &Runtime<A>,
    graph_dir: &Path,
    graph_name: &str,
    step: &GraphStep,
    attempt: u32,
    inputs: JsonObject,
    host: &mut dyn Host,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    run_step_with_optional_loaded_skill(
        StepRunRequest {
            runtime,
            graph_dir,
            graph_name,
            step,
            attempt,
            inputs,
            host,
        },
        None,
    )
}

pub(super) fn run_step_with_loaded_skill_inputs<A>(
    request: StepRunRequest<'_, A>,
    loaded_skill: LoadedStepSkill,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    run_step_with_optional_loaded_skill(request, Some(loaded_skill))
}

// rust-style-allow: long-function - this is the single routing point that
// preserves replay, recovery, authority admission, native/tool dispatch, and
// loaded skill fallback order.
fn run_step_with_optional_loaded_skill<A>(
    request: StepRunRequest<'_, A>,
    loaded_skill: Option<LoadedStepSkill>,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let StepRunRequest {
        runtime,
        graph_dir,
        graph_name,
        step,
        attempt,
        inputs,
        host,
    } = request;
    if let Some(replay) = find_effect_replay(
        step,
        &inputs,
        &runtime.options.env,
        graph_dir,
        &runtime.options.effects,
    )? {
        return run_replayed_effect_step(
            runtime,
            graph_dir,
            graph_name,
            step,
            attempt,
            loaded_skill,
            replay,
        );
    }
    recover_pending_effects(
        step,
        &inputs,
        &runtime.options.env,
        graph_dir,
        &runtime.options.effects,
    )?;
    let authority = enforce_step_authority_admission(
        step,
        &inputs,
        &runtime.options.env,
        graph_dir,
        &runtime.options.effects,
    )?;
    let step_type = registered_step_type(step)?;
    run_registered_step(
        step_type,
        StepHandlerCtx {
            runtime,
            graph_dir,
            graph_name,
            step,
            attempt,
            inputs,
            host,
            authority,
            loaded_skill,
        },
    )
}

// rust-style-allow: long-function - loaded skill execution branches between
// agent-owned and local adapter paths while preserving one authority admission
// and receipt boundary.
fn run_loaded_skill_step<A>(
    skill: LoadedStepSkill,
    request: StepHandlerCtx<'_, A>,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let authority = request.authority.as_ref();
    let (skill_name, invocation) = loaded_skill_invocation(
        skill,
        request.graph_dir,
        request.step,
        request.inputs.clone(),
        &request.runtime.options.created_at,
        &request.runtime.options.env,
        &request.runtime.options.credential_delivery,
    )?;
    if let Some(source_type) = agent_skill_source_type(invocation.source.source_type) {
        return run_agent_skill_step(
            request.runtime,
            request.graph_name,
            request.step,
            request.attempt,
            AgentSkillStepInvocation {
                skill_name,
                invocation,
                source_type,
            },
            request.host,
        );
    }
    if !invocation.current_context.is_empty() {
        return Err(RuntimeError::InvalidRunStep {
            step_id: request.step.id.clone(),
            reason: "context_skills is only supported for agent and agent-task steps".to_owned(),
        });
    }
    if invocation.source.source_type == SourceKind::Graph {
        return run_nested_graph_skill_step(request, skill_name, invocation);
    }

    let regular = invoke_regular_skill_step(
        request.runtime,
        request.step,
        invocation,
        authority,
        request.host,
    )?;
    seal_regular_skill_step(
        RegularSkillSeal {
            runtime: request.runtime,
            graph_dir: request.graph_dir,
            graph_name: request.graph_name,
            step: request.step,
            attempt: request.attempt,
            skill_name,
            authority,
        },
        regular,
    )
}

fn run_nested_graph_skill_step<A>(
    request: StepHandlerCtx<'_, A>,
    skill_name: String,
    invocation: SkillInvocation,
) -> Result<StepRun, RuntimeError>
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
    let run =
        request
            .runtime
            .run_graph_with_host(&invocation.skill_directory, graph, request.host)?;
    let payload = nested_graph_payload(&run)?;
    let mut output = nested_graph_skill_output(&payload, &run)?;
    let projection = step_output_projection(request.step, &output)?;
    prepare_effect_output_before_gate(
        request.step,
        request.authority.as_ref(),
        &projection.claim,
        &mut output,
        &request.runtime.options.effects,
    )?;
    seal_regular_skill_step(
        RegularSkillSeal {
            runtime: request.runtime,
            graph_dir: request.graph_dir,
            graph_name: request.graph_name,
            step: request.step,
            attempt: request.attempt,
            skill_name,
            authority: request.authority.as_ref(),
        },
        RegularSkillStepOutput { output, projection },
    )
}

fn nested_graph_payload(run: &GraphRun) -> Result<JsonValue, RuntimeError> {
    let mut payload = JsonObject::new();
    payload.insert(
        "graph".to_owned(),
        JsonValue::String(run.graph.name.clone()),
    );
    payload.insert(
        "graph_status".to_owned(),
        JsonValue::String(format!("{:?}", run.state.status)),
    );
    payload.insert(
        "graph_receipt_id".to_owned(),
        JsonValue::String(run.receipt.id.to_string()),
    );
    let mut step_outputs = JsonObject::new();
    let mut step_summaries = Vec::new();
    for step in &run.steps {
        let mut summary = JsonObject::new();
        summary.insert(
            "step_id".to_owned(),
            JsonValue::String(step.step_id.clone()),
        );
        summary.insert("skill".to_owned(), JsonValue::String(step.skill.clone()));
        summary.insert(
            "status".to_owned(),
            JsonValue::String(if step.output.succeeded() {
                "success".to_owned()
            } else {
                "failure".to_owned()
            }),
        );
        summary.insert(
            "receipt_id".to_owned(),
            JsonValue::String(step.receipt.id.to_string()),
        );
        step_summaries.push(JsonValue::Object(summary));
        step_outputs.insert(
            step.step_id.clone(),
            JsonValue::Object(step.outputs.clone()),
        );
    }
    payload.insert("steps".to_owned(), JsonValue::Array(step_summaries));
    payload.insert("step_outputs".to_owned(), JsonValue::Object(step_outputs));
    serde_json::to_value(JsonValue::Object(payload))
        .and_then(serde_json::from_value)
        .map_err(|source| RuntimeError::json("serializing nested graph payload", source))
}

fn nested_graph_skill_output(
    payload: &JsonValue,
    run: &GraphRun,
) -> Result<SkillOutput, RuntimeError> {
    let stdout = serde_json::to_string(payload)
        .map_err(|source| RuntimeError::json("serializing nested graph payload", source))?;
    Ok(SkillOutput {
        status: if run.state.status == GraphStatus::Succeeded {
            InvocationStatus::Success
        } else {
            InvocationStatus::Failure
        },
        stdout,
        stderr: String::new(),
        exit_code: Some(0),
        duration_ms: 0,
        metadata: JsonObject::new(),
    })
}

fn loaded_skill_invocation(
    skill: LoadedStepSkill,
    graph_dir: &Path,
    step: &GraphStep,
    inputs: JsonObject,
    created_at: &str,
    env: &std::collections::BTreeMap<String, String>,
    credential_delivery: &crate::credentials::CredentialDelivery,
) -> Result<(String, SkillInvocation), RuntimeError> {
    let skill_name = skill.name.clone();
    let invocation = SkillInvocation {
        skill_name: skill.name,
        source: skill.source,
        inputs,
        resolved_inputs: JsonObject::new(),
        current_context: load_context_skills(
            &step.id,
            graph_dir,
            &step.context_skills,
            env,
            created_at,
        )?,
        skill_directory: skill.directory,
        env: env.clone(),
        credential_delivery: credential_delivery.clone(),
    };
    Ok((skill_name, invocation))
}

fn invoke_regular_skill_step<A>(
    runtime: &Runtime<A>,
    step: &GraphStep,
    invocation: SkillInvocation,
    authority: Option<&StepAuthorityContext>,
    host: &mut dyn Host,
) -> Result<RegularSkillStepOutput, RuntimeError>
where
    A: SkillAdapter,
{
    let mut output = runtime.adapter.invoke(invocation)?;
    route_external_adapter_host_resolution(step, host, &mut output)?;
    let projection = step_output_projection(step, &output)?;
    prepare_effect_output_before_gate(
        step,
        authority,
        &projection.claim,
        &mut output,
        &runtime.options.effects,
    )?;
    Ok(RegularSkillStepOutput { output, projection })
}

// rust-style-allow: long-function - sealing keeps claim projection, effect evidence, and receipt construction consistent.
fn seal_regular_skill_step<A>(
    context: RegularSkillSeal<'_, A>,
    regular: RegularSkillStepOutput,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let RegularSkillStepOutput {
        mut output,
        projection,
    } = regular;
    let authority_grant_refs = context
        .authority
        .map(|authority| authority.authority_grant_refs(&context.runtime.options.effects))
        .transpose()?
        .unwrap_or_default();
    let receipt = seal_step(
        StepSeal {
            graph_name: context.graph_name,
            step_id: &context.step.id,
            attempt: context.attempt,
            output: &output,
            projection: &projection,
            created_at: &context.runtime.options.created_at,
            authority_grant_refs,
            closure: None,
        },
        context.runtime.options.signature_policy(),
    )?;
    finalize_effect_output_before_success(EffectReceiptContext {
        step: context.step,
        graph_dir: context.graph_dir,
        authority: context.authority,
        claim: &projection.claim,
        output: &mut output,
        receipt: &receipt,
        env: &context.runtime.options.env,
        effects: &context.runtime.options.effects,
    })?;
    persist_effect_state_for_step(EffectReceiptContext {
        step: context.step,
        graph_dir: context.graph_dir,
        authority: context.authority,
        claim: &projection.claim,
        output: &mut output,
        receipt: &receipt,
        env: &context.runtime.options.env,
        effects: &context.runtime.options.effects,
    })?;
    // The authority witness is sealed centrally in run_registered_step; the seal
    // path records a neutral witness and uses `authority` only for effect output
    // finalization above.
    let admission_witness =
        StepAdmissionWitness::local_runtime(&context.step.id, receipt.id.as_str());
    Ok(regular_step_run(
        context.step,
        context.attempt,
        context.skill_name,
        output,
        projection.outputs,
        receipt,
        admission_witness,
    ))
}

fn regular_step_run(
    step: &GraphStep,
    attempt: u32,
    skill_name: String,
    output: SkillOutput,
    outputs: JsonObject,
    receipt: Receipt,
    admission_witness: StepAdmissionWitness,
) -> StepRun {
    StepRun {
        step_id: step.id.clone(),
        attempt,
        skill: skill_name,
        runner: step.runner.clone(),
        fanout_group: step.fanout_group.clone(),
        output,
        outputs,
        receipt,
        admission_witness,
    }
}

fn route_external_adapter_host_resolution(
    step: &GraphStep,
    host: &mut dyn Host,
    output: &mut SkillOutput,
) -> Result<(), RuntimeError> {
    let Some(JsonValue::Object(request_object)) = output
        .metadata
        .get(EXTERNAL_ADAPTER_HOST_RESOLUTION_REQUEST_METADATA)
        .cloned()
    else {
        return Ok(());
    };
    let request: ResolutionRequest =
        serde_json::to_value(JsonValue::Object(request_object.clone()))
            .and_then(serde_json::from_value)
            .map_err(|source| {
                RuntimeError::json("parsing external adapter host-resolution request", source)
            })?;
    host.report(ExecutionEvent::ResolutionRequested {
        message: format!(
            "external adapter step '{}' requested host resolution",
            step.id
        ),
        data: Some(JsonValue::Object(host_resolution_event_data(
            step,
            JsonValue::Object(request_object),
        ))),
    })?;
    let Some(response) = host.resolve(request)? else {
        return Ok(());
    };
    let response_value: JsonValue = serde_json::to_value(&response)
        .and_then(serde_json::from_value)
        .map_err(|source| {
            RuntimeError::json(
                "serializing external adapter host-resolution response",
                source,
            )
        })?;
    output.metadata.insert(
        EXTERNAL_ADAPTER_HOST_RESOLUTION_RESPONSE_METADATA.to_owned(),
        response_value.clone(),
    );
    host.report(ExecutionEvent::ResolutionResolved {
        message: format!(
            "external adapter step '{}' host resolution resolved",
            step.id
        ),
        data: Some(JsonValue::Object(host_resolution_event_data(
            step,
            response_value,
        ))),
    })
}

fn host_resolution_event_data(step: &GraphStep, payload: JsonValue) -> JsonObject {
    let mut data = JsonObject::new();
    data.insert("step_id".to_owned(), JsonValue::String(step.id.clone()));
    data.insert("payload".to_owned(), payload);
    data
}

// rust-style-allow: long-function - replay execution keeps effect recovery, receipt validation, and final output in one audited path.
fn run_replayed_effect_step(
    runtime: &Runtime<impl SkillAdapter>,
    graph_dir: &Path,
    graph_name: &str,
    step: &GraphStep,
    attempt: u32,
    loaded_skill: Option<LoadedStepSkill>,
    replay: EffectReplay,
) -> Result<StepRun, RuntimeError> {
    let skill = loaded_skill_or_load(loaded_skill, &runtime.options.env, graph_dir, step)?;
    let skill_name = skill.name.clone();
    let mut output = replay_skill_output(step, replay.outputs())?;
    if !output.succeeded() {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: "sealed effect replay requires a successful stored output".to_owned(),
        });
    }
    prepare_replay_output(step, &replay, &mut output, &runtime.options.effects)?;
    let projection = step_output_projection(step, &output)?;
    let authority_grant_refs = runtime
        .options
        .effects
        .replay_authority_grant_refs(&replay)
        .map_err(|source| RuntimeError::ReceiptInvalid {
            message: source.to_string(),
        })?;
    let receipt = seal_step(
        StepSeal {
            graph_name,
            step_id: &step.id,
            attempt,
            output: &output,
            projection: &projection,
            created_at: replay.receipt_created_at(),
            authority_grant_refs,
            closure: None,
        },
        runtime.options.signature_policy(),
    )?;
    validate_replayed_receipt_identity(step, &receipt, &replay)?;
    validate_replayed_effect(
        step,
        &replay,
        &receipt,
        &output,
        &projection.claim,
        &runtime.options.effects,
    )?;
    let admission_witness = StepAdmissionWitness::local_runtime(&step.id, replay.receipt_ref());
    Ok(StepRun {
        step_id: step.id.clone(),
        attempt,
        skill: skill_name,
        runner: step.runner.clone(),
        fanout_group: step.fanout_group.clone(),
        output,
        outputs: projection.outputs,
        receipt,
        admission_witness,
    })
}

fn validate_replayed_receipt_identity(
    step: &GraphStep,
    receipt: &runx_contracts::Receipt,
    replay: &EffectReplay,
) -> Result<(), RuntimeError> {
    if receipt.id != replay.receipt_ref() {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: format!(
                "sealed effect replay rebuilt receipt {}, expected {}",
                receipt.id,
                replay.receipt_ref()
            ),
        });
    }
    if receipt.digest != replay.receipt_digest() {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: format!(
                "sealed effect replay rebuilt receipt digest {}, expected {}",
                receipt.digest,
                replay.receipt_digest()
            ),
        });
    }
    Ok(())
}

fn loaded_skill_or_load(
    loaded_skill: Option<LoadedStepSkill>,
    runtime_env: &std::collections::BTreeMap<String, String>,
    graph_dir: &Path,
    step: &GraphStep,
) -> Result<LoadedStepSkill, RuntimeError> {
    loaded_skill.map_or_else(
        || load_step_skill(graph_dir, step, StepSkillLoadOptions { env: runtime_env }),
        Ok,
    )
}

fn replay_skill_output(
    step: &GraphStep,
    outputs: &JsonObject,
) -> Result<SkillOutput, RuntimeError> {
    let status = match outputs.get("status") {
        Some(JsonValue::String(value)) if value == "success" => InvocationStatus::Success,
        Some(JsonValue::String(value)) if value == "failure" => InvocationStatus::Failure,
        Some(JsonValue::String(value)) => {
            return Err(RuntimeError::InvalidRunStep {
                step_id: step.id.clone(),
                reason: format!("effect replay output status {value:?} is not supported"),
            });
        }
        Some(_) => {
            return Err(RuntimeError::InvalidRunStep {
                step_id: step.id.clone(),
                reason: "effect replay output status must be a string".to_owned(),
            });
        }
        None => InvocationStatus::Success,
    };
    let stdout = match outputs.get("stdout") {
        Some(JsonValue::String(value)) => value.clone(),
        Some(_) => {
            return Err(RuntimeError::InvalidRunStep {
                step_id: step.id.clone(),
                reason: "effect replay output stdout must be a string".to_owned(),
            });
        }
        None => serde_json::to_string(&JsonValue::Object(replay_stdout_payload(outputs)))
            .map_err(|source| RuntimeError::json("serializing effect replay stdout", source))?,
    };
    let stderr = match outputs.get("stderr") {
        Some(JsonValue::String(value)) => value.clone(),
        Some(_) => {
            return Err(RuntimeError::InvalidRunStep {
                step_id: step.id.clone(),
                reason: "effect replay output stderr must be a string".to_owned(),
            });
        }
        None => String::new(),
    };
    Ok(SkillOutput {
        exit_code: Some(if status == InvocationStatus::Success {
            0
        } else {
            1
        }),
        status,
        stdout,
        stderr,
        duration_ms: 0,
        metadata: JsonObject::new(),
    })
}

fn replay_stdout_payload(outputs: &JsonObject) -> JsonObject {
    let mut payload = outputs.clone();
    payload.remove("stdout");
    payload.remove("stderr");
    payload.remove("status");
    payload
}

fn run_registered_step<A>(
    step_type: &str,
    request: StepHandlerCtx<'_, A>,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let handler = request
        .runtime
        .step_types
        .handler(step_type)
        .ok_or_else(|| RuntimeError::UnsupportedRunStep {
            step_id: request.step.id.clone(),
            run_type: step_type.to_owned(),
        })?;
    // Every registered step is admitted centrally (enforce_step_authority_admission,
    // upstream) and sealed centrally here: this is the single place a step's
    // admission witness records which authority admitted the act, or falls back to a
    // local-runtime witness when none was admitted. Handlers produce the output and
    // receipt; they never set the authority witness, so a new step type cannot
    // regress the uniform-governance invariant. See `docs/governance-invariant.md`
    // for the full admit -> credentials -> sandbox -> seal contract.
    let step_id = request.step.id.clone();
    let authority = request.authority.clone();
    let mut run = handler(request)?;
    run.admission_witness =
        step_admission_witness(&step_id, run.receipt.id.as_str(), authority.as_ref());
    Ok(run)
}

fn registered_step_type(step: &GraphStep) -> Result<&str, RuntimeError> {
    if step.run.is_some() {
        return run_type_ref(step);
    }
    if step.tool.is_some() {
        return Ok("tool");
    }
    Ok("subskill")
}

fn run_approval_step_handler<A>(request: StepHandlerCtx<'_, A>) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    run_approval_step(
        request.runtime,
        request.graph_name,
        request.step,
        request.attempt,
        request.inputs,
        request.host,
    )
}

fn run_agent_task_handler<A>(request: StepHandlerCtx<'_, A>) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    run_agent_task(
        request.runtime,
        request.graph_dir,
        request.graph_name,
        request.step,
        request.attempt,
        request.inputs,
        request.host,
    )
}

fn run_cli_tool_step_handler<A>(request: StepHandlerCtx<'_, A>) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    run_cli_tool_step(request)
}

fn run_tool_step_handler<A>(request: StepHandlerCtx<'_, A>) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    run_tool_step(request)
}

fn run_subskill_step_handler<A>(mut request: StepHandlerCtx<'_, A>) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let skill = loaded_skill_or_load(
        request.loaded_skill.take(),
        &request.runtime.options.env,
        request.graph_dir,
        request.step,
    )?;
    run_loaded_skill_step(skill, request)
}

// An inline `run: { type: cli-tool, command, args }` step runs a local process
// (e.g. `node ./script.mjs` relative to the graph directory) through the same
// adapter + projection + sealing path as a subskill cli-tool step.
fn run_cli_tool_step<A>(request: StepHandlerCtx<'_, A>) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let StepHandlerCtx {
        runtime,
        graph_dir,
        graph_name,
        step,
        attempt,
        inputs,
        host,
        authority,
        loaded_skill: _,
    } = request;
    let source = cli_tool_source(step)?;
    let invocation = SkillInvocation {
        skill_name: step.id.clone(),
        source,
        inputs,
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: graph_dir.to_path_buf(),
        env: runtime.options.env.clone(),
        credential_delivery: runtime.options.credential_delivery.clone(),
    };
    let regular = invoke_regular_skill_step(runtime, step, invocation, authority.as_ref(), host)?;
    seal_regular_skill_step(
        RegularSkillSeal {
            runtime,
            graph_dir,
            graph_name,
            step,
            attempt,
            skill_name: step.id.clone(),
            authority: authority.as_ref(),
        },
        regular,
    )
}

fn cli_tool_source(step: &GraphStep) -> Result<SkillSource, RuntimeError> {
    let Some(run) = &step.run else {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: "missing run configuration".to_owned(),
        });
    };
    let command = optional_string(run, "command").ok_or_else(|| RuntimeError::InvalidRunStep {
        step_id: step.id.clone(),
        reason: "run.command is required for a cli-tool step".to_owned(),
    })?;
    let args = run
        .get("args")
        .and_then(JsonValue::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(SkillSource {
        act: None,
        source_type: SourceKind::CliTool,
        command: Some(command),
        args,
        cwd: optional_string(run, "cwd"),
        timeout_seconds: None,
        input_mode: None,
        sandbox: None,
        server: None,
        catalog_ref: None,
        tool: None,
        arguments: None,
        agent_card_url: None,
        agent_identity: None,
        agent: None,
        task: None,
        hook: None,
        outputs: optional_object(run, "outputs"),
        graph: None,
        http: None,
        raw: run.clone(),
    })
}

// The shared close for an agent act: a resolved host response becomes the
// step's output, projection, and sealed receipt. Both the inline `agent-task`
// step and a referenced agent skill end here, so the agent-act seal lives in
// one place.
fn seal_agent_act_step<A>(
    runtime: &Runtime<A>,
    graph_name: &str,
    step: &GraphStep,
    attempt: u32,
    skill_name: String,
    response: ResolutionResponse,
) -> Result<StepRun, RuntimeError> {
    let disposition = agent_answer_disposition_value(&response.payload);
    let output = agent_task_output(response)?;
    let projection =
        build_step_output_projection(step, &output, ClaimContextExposure::DeclaredOnly)?;
    let disposition_label = closure_disposition_label(&disposition);
    let receipt = seal_step(
        StepSeal {
            graph_name,
            step_id: &step.id,
            attempt,
            output: &output,
            projection: &projection,
            created_at: &runtime.options.created_at,
            authority_grant_refs: Vec::new(),
            closure: Some(StepSealClosure {
                disposition,
                reason_code: format!("agent_act_{disposition_label}"),
                summary: format!("agent act closed with {disposition_label}"),
            }),
        },
        runtime.options.signature_policy(),
    )?;
    let admission_witness = StepAdmissionWitness::local_runtime(&step.id, receipt.id.as_str());
    Ok(StepRun {
        step_id: step.id.clone(),
        attempt,
        skill: skill_name,
        runner: step.runner.clone(),
        fanout_group: step.fanout_group.clone(),
        output,
        outputs: projection.outputs,
        receipt,
        admission_witness,
    })
}

// rust-style-allow: long-function because agent-task execution is one
// request/resolve/seal trust-boundary path.
fn run_agent_task<A>(
    runtime: &Runtime<A>,
    graph_dir: &Path,
    graph_name: &str,
    step: &GraphStep,
    attempt: u32,
    inputs: JsonObject,
    host: &mut dyn Host,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let source = agent_task_source(step)?;
    let invocation = SkillInvocation {
        skill_name: step.id.clone(),
        source,
        inputs,
        resolved_inputs: JsonObject::new(),
        current_context: load_context_skills(
            &step.id,
            graph_dir,
            &step.context_skills,
            &runtime.options.env,
            &runtime.options.created_at,
        )?,
        skill_directory: graph_dir.to_path_buf(),
        env: runtime.options.env.clone(),
        credential_delivery: runtime.options.credential_delivery.clone(),
    };
    let source_type = AgentActInvocationSourceType::AgentStep;
    let request_id = agent_act_invocation_id(&invocation, source_type);
    let request = agent_act_resolution_request(&invocation, source_type)?;
    host.report(ExecutionEvent::ResolutionRequested {
        message: format!("agent step '{}' requested resolution", step.id),
        data: Some(resolution_event_data(step, &request)?),
    })?;
    let Some(response) = host.resolve(request)? else {
        return Err(RuntimeError::GraphBlocked {
            step_id: step.id.clone(),
            reason: format!("agent act {request_id} requires resolution"),
        });
    };
    seal_agent_act_step(
        runtime,
        graph_name,
        step,
        attempt,
        "run:agent-task".to_owned(),
        response,
    )
}

fn run_agent_skill_step<A>(
    runtime: &Runtime<A>,
    graph_name: &str,
    step: &GraphStep,
    attempt: u32,
    agent_task: AgentSkillStepInvocation,
    host: &mut dyn Host,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let AgentSkillStepInvocation {
        skill_name,
        invocation,
        source_type,
    } = agent_task;
    let request_id = agent_act_invocation_id(&invocation, source_type);
    let request = agent_act_resolution_request(&invocation, source_type)?;
    let response = resolve_agent_act(
        step,
        host,
        request_id,
        request,
        format!(
            "agent skill step '{}' requested resolution for {}",
            step.id, skill_name
        ),
    )?;
    seal_agent_act_step(runtime, graph_name, step, attempt, skill_name, response)
}

fn resolve_agent_act(
    step: &GraphStep,
    host: &mut dyn Host,
    request_id: String,
    request: ResolutionRequest,
    message: String,
) -> Result<ResolutionResponse, RuntimeError> {
    host.report(ExecutionEvent::ResolutionRequested {
        message,
        data: Some(resolution_event_data(step, &request)?),
    })?;
    host.resolve(request)?
        .ok_or_else(|| RuntimeError::GraphBlocked {
            step_id: step.id.clone(),
            reason: format!("agent act {request_id} requires resolution"),
        })
}

fn agent_skill_source_type(source_type: SourceKind) -> Option<AgentActInvocationSourceType> {
    match source_type {
        SourceKind::Agent => Some(AgentActInvocationSourceType::Agent),
        SourceKind::AgentStep => Some(AgentActInvocationSourceType::AgentStep),
        _ => None,
    }
}

fn agent_task_source(step: &GraphStep) -> Result<SkillSource, RuntimeError> {
    let Some(run) = &step.run else {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: "missing run configuration".to_owned(),
        });
    };
    let mut raw = run.clone();
    if let Some(instructions) = &step.instructions {
        raw.insert(
            "instructions".to_owned(),
            JsonValue::String(instructions.clone()),
        );
    }
    if let Some(allowed_tools) = &step.allowed_tools {
        raw.insert(
            "allowed_tools".to_owned(),
            JsonValue::Array(
                allowed_tools
                    .iter()
                    .cloned()
                    .map(JsonValue::String)
                    .collect(),
            ),
        );
    }
    Ok(SkillSource {
        act: None,
        source_type: SourceKind::AgentStep,
        command: None,
        args: Vec::new(),
        cwd: None,
        timeout_seconds: None,
        input_mode: None,
        sandbox: None,
        server: None,
        catalog_ref: None,
        tool: None,
        arguments: None,
        agent_card_url: None,
        agent_identity: None,
        agent: optional_string(run, "agent"),
        task: optional_string(run, "task"),
        hook: None,
        outputs: optional_object(run, "outputs"),
        graph: None,
        http: None,
        raw,
    })
}

// rust-style-allow: long-function because tool execution keeps lookup,
// invocation, and receipt sealing in one audited boundary.
fn run_tool_step<A>(request: StepHandlerCtx<'_, A>) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let StepHandlerCtx {
        runtime,
        graph_dir,
        graph_name,
        step,
        attempt,
        inputs,
        host: _,
        authority,
        loaded_skill: _,
    } = request;
    #[cfg(not(feature = "catalog"))]
    {
        let _ = (
            runtime, graph_dir, graph_name, step, attempt, inputs, authority,
        );
        Err(RuntimeError::UnsupportedAdapter {
            adapter_type: "catalog".to_owned(),
        })
    }

    #[cfg(feature = "catalog")]
    {
        let tool_ref = step
            .tool
            .as_deref()
            .ok_or_else(|| RuntimeError::InvalidRunStep {
                step_id: step.id.clone(),
                reason: "tool step missing tool reference".to_owned(),
            })?;
        let invocation = SkillInvocation {
            skill_name: tool_ref.to_owned(),
            source: catalog_source(tool_ref),
            inputs,
            resolved_inputs: JsonObject::new(),
            current_context: Vec::new(),
            skill_directory: graph_dir.to_path_buf(),
            env: runtime.options.env.clone(),
            credential_delivery: runtime.options.credential_delivery.clone(),
        };
        let output = CatalogAdapter::default().invoke(invocation)?;
        let projection = step_output_projection(step, &output)?;
        let authority_grant_refs = authority
            .as_ref()
            .map(|authority| authority.authority_grant_refs(&runtime.options.effects))
            .transpose()?
            .unwrap_or_default();
        let receipt = seal_step(
            StepSeal {
                graph_name,
                step_id: &step.id,
                attempt,
                output: &output,
                projection: &projection,
                created_at: &runtime.options.created_at,
                authority_grant_refs,
                closure: None,
            },
            runtime.options.signature_policy(),
        )?;
        let admission_witness = StepAdmissionWitness::local_runtime(&step.id, receipt.id.as_str());
        Ok(StepRun {
            step_id: step.id.clone(),
            attempt,
            skill: format!("tool:{tool_ref}"),
            runner: step.runner.clone(),
            fanout_group: step.fanout_group.clone(),
            output,
            outputs: projection.outputs,
            receipt,
            admission_witness,
        })
    }
}

#[cfg(feature = "catalog")]
fn catalog_source(tool_ref: &str) -> SkillSource {
    let mut raw = JsonObject::new();
    raw.insert("type".to_owned(), JsonValue::String("catalog".to_owned()));
    raw.insert(
        "catalog_ref".to_owned(),
        JsonValue::String(tool_ref.to_owned()),
    );
    SkillSource {
        act: None,
        source_type: SourceKind::Catalog,
        command: None,
        args: Vec::new(),
        cwd: None,
        timeout_seconds: None,
        input_mode: None,
        sandbox: None,
        server: None,
        catalog_ref: Some(tool_ref.to_owned()),
        tool: None,
        arguments: None,
        agent_card_url: None,
        agent_identity: None,
        agent: None,
        task: None,
        hook: None,
        outputs: None,
        graph: None,
        http: None,
        raw,
    }
}

fn agent_task_output(response: ResolutionResponse) -> Result<SkillOutput, RuntimeError> {
    let disposition = agent_answer_disposition_value(&response.payload);
    let succeeded = disposition == ClosureDisposition::Closed;
    let stdout = serde_json::to_string(&response.payload)
        .map_err(|source| RuntimeError::json("serializing agent-task response", source))?;
    Ok(SkillOutput {
        status: if succeeded {
            InvocationStatus::Success
        } else {
            InvocationStatus::Failure
        },
        stdout,
        stderr: if succeeded {
            String::new()
        } else {
            format!(
                "agent act closed with {}",
                closure_disposition_label(&disposition)
            )
        },
        exit_code: succeeded.then_some(0),
        duration_ms: 0,
        metadata: JsonObject::new(),
    })
}

fn resolution_event_data(
    step: &GraphStep,
    request: &ResolutionRequest,
) -> Result<JsonValue, RuntimeError> {
    let request_value = serde_json::to_value(request)
        .and_then(serde_json::from_value)
        .map_err(|source| RuntimeError::json("serializing agent-task request", source))?;
    let mut data = JsonObject::new();
    data.insert("step_id".to_owned(), JsonValue::String(step.id.clone()));
    data.insert("request".to_owned(), request_value);
    Ok(JsonValue::Object(data))
}

fn optional_string(object: &JsonObject, field: &str) -> Option<String> {
    object
        .get(field)
        .and_then(JsonValue::as_str)
        .map(str::to_owned)
}

fn optional_object(object: &JsonObject, field: &str) -> Option<JsonObject> {
    match object.get(field) {
        Some(JsonValue::Object(value)) => Some(value.clone()),
        _ => None,
    }
}

fn agent_answer_disposition_value(answer: &JsonValue) -> ClosureDisposition {
    match answer
        .as_object()
        .and_then(|object| object.get("closure"))
        .and_then(JsonValue::as_object)
        .and_then(|closure| closure.get("disposition"))
        .and_then(JsonValue::as_str)
    {
        Some("deferred") => ClosureDisposition::Deferred,
        Some("superseded") => ClosureDisposition::Superseded,
        Some("declined") => ClosureDisposition::Declined,
        Some("blocked") => ClosureDisposition::Blocked,
        Some("failed") => ClosureDisposition::Failed,
        Some("killed") => ClosureDisposition::Killed,
        Some("timed_out") => ClosureDisposition::TimedOut,
        _ => ClosureDisposition::Closed,
    }
}

fn closure_disposition_label(disposition: &ClosureDisposition) -> &'static str {
    match disposition {
        ClosureDisposition::Closed => "closed",
        ClosureDisposition::Deferred => "deferred",
        ClosureDisposition::Superseded => "superseded",
        ClosureDisposition::Declined => "declined",
        ClosureDisposition::Blocked => "blocked",
        ClosureDisposition::Failed => "failed",
        ClosureDisposition::Killed => "killed",
        ClosureDisposition::TimedOut => "timed_out",
    }
}

pub(super) fn run_approval_step<A>(
    runtime: &Runtime<A>,
    graph_name: &str,
    step: &GraphStep,
    attempt: u32,
    inputs: JsonObject,
    host: &mut dyn Host,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let gate = approval_gate(step, &inputs)?;
    // Route resolution by the declared gate_id (the gate's identity), not the
    // step id. A caller's seeded approval is keyed by gate_id, and the standalone
    // fixture host already resolves approvals by gate_id; keying the request id
    // the same way lets a seeded graph run drive an approval gate to a decision.
    let request_id = gate.id.to_string();
    let resolution = resolve_step_approval(step, host, request_id, gate.clone())?;
    let outputs = approval_outputs(step, &gate, &resolution)?;
    let stdout = serde_json::to_string(&outputs)
        .map_err(|source| RuntimeError::json("serializing approval run output", source))?;
    let output = SkillOutput {
        status: InvocationStatus::Success,
        stdout,
        stderr: String::new(),
        exit_code: Some(0),
        duration_ms: 0,
        metadata: JsonObject::new(),
    };
    let projection = project_step_output(&output);
    let receipt = seal_step(
        StepSeal {
            graph_name,
            step_id: &step.id,
            attempt,
            output: &output,
            projection: &projection,
            created_at: &runtime.options.created_at,
            authority_grant_refs: Vec::new(),
            closure: None,
        },
        runtime.options.signature_policy(),
    )?;
    let admission_witness = StepAdmissionWitness::local_runtime(&step.id, receipt.id.as_str());
    Ok(StepRun {
        step_id: step.id.clone(),
        attempt,
        skill: "run:approval".to_owned(),
        runner: step.runner.clone(),
        fanout_group: step.fanout_group.clone(),
        output,
        outputs,
        receipt,
        admission_witness,
    })
}

fn run_type_ref(step: &GraphStep) -> Result<&str, RuntimeError> {
    let Some(run) = &step.run else {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: "missing run configuration".to_owned(),
        });
    };
    let Some(value) = run.get("type") else {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: "run.type is required".to_owned(),
        });
    };
    string_value_ref(step, "run.type", value)
}

pub(super) fn approval_gate(
    step: &GraphStep,
    inputs: &JsonObject,
) -> Result<ApprovalGate, RuntimeError> {
    let gate_id = required_input_string(step, inputs, "gate_id")?;
    let reason = required_input_string(step, inputs, "reason")?;
    let gate_type = optional_input_string(step, inputs, "gate_type")?;
    let summary = approval_summary(inputs);
    Ok(ApprovalGate {
        id: gate_id.into(),
        reason: reason.into(),
        gate_type,
        summary,
    })
}

pub(super) fn approval_summary(inputs: &JsonObject) -> Option<JsonObject> {
    let mut summary = JsonObject::new();
    for (key, value) in inputs {
        if matches!(key.as_str(), "gate_id" | "reason" | "gate_type") {
            continue;
        }
        summary.insert(key.clone(), value.clone());
    }
    (!summary.is_empty()).then_some(summary)
}

pub(super) fn approval_outputs(
    step: &GraphStep,
    gate: &ApprovalGate,
    resolution: &ApprovalResolution,
) -> Result<JsonObject, RuntimeError> {
    let mut data = JsonObject::new();
    data.insert("approved".to_owned(), approved_value(resolution));
    data.insert(
        "gate_id".to_owned(),
        JsonValue::String(gate.id.as_str().to_owned()),
    );
    data.insert(
        "idempotency_key".to_owned(),
        JsonValue::String(resolution.idempotency_key().to_owned()),
    );
    data.insert(
        "status".to_owned(),
        JsonValue::String(approval_status(resolution).to_owned()),
    );
    if let Some(actor) = resolution.actor() {
        data.insert("actor".to_owned(), JsonValue::String(actor_name(actor)));
    }

    let mut packet = JsonObject::new();
    if let Some(packet_id) = artifact_packet(step)? {
        packet.insert("packet".to_owned(), JsonValue::String(packet_id));
    }
    packet.insert("data".to_owned(), JsonValue::Object(data));

    let mut outputs = JsonObject::new();
    outputs.insert(
        artifact_wrap_as(step)?.to_owned(),
        JsonValue::Object(packet),
    );
    Ok(outputs)
}

pub(super) fn approved_value(resolution: &ApprovalResolution) -> JsonValue {
    resolution
        .approved()
        .map_or(JsonValue::Null, JsonValue::Bool)
}

pub(super) fn approval_status(resolution: &ApprovalResolution) -> &'static str {
    match resolution {
        ApprovalResolution::Approved { .. } => "approved",
        ApprovalResolution::Denied { .. } => "denied",
        ApprovalResolution::Pending { .. } => "pending",
    }
}

pub(super) fn actor_name(actor: &ResolutionResponseActor) -> String {
    match actor {
        ResolutionResponseActor::Human => "human".to_owned(),
        ResolutionResponseActor::Agent => "agent".to_owned(),
    }
}

pub(super) fn artifact_wrap_as(step: &GraphStep) -> Result<&str, RuntimeError> {
    let Some(artifacts) = &step.artifacts else {
        return Ok("approval");
    };
    let Some(value) = artifacts.get("wrap_as") else {
        return Ok("approval");
    };
    string_value_ref(step, "artifacts.wrap_as", value)
}

pub(super) fn artifact_packet(step: &GraphStep) -> Result<Option<String>, RuntimeError> {
    let Some(artifacts) = &step.artifacts else {
        return Ok(None);
    };
    let Some(value) = artifacts.get("packet") else {
        return Ok(None);
    };
    Ok(Some(string_value(step, "artifacts.packet", value)?))
}

pub(super) fn runtime_error_step_run<A>(
    runtime: &Runtime<A>,
    graph_name: &str,
    step: &GraphStep,
    attempt: u32,
    error: RuntimeError,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let output = SkillOutput {
        status: InvocationStatus::Failure,
        stdout: String::new(),
        stderr: error.to_string(),
        exit_code: None,
        duration_ms: 0,
        metadata: JsonObject::new(),
    };
    let projection = project_step_output(&output);
    let receipt = seal_step(
        StepSeal {
            graph_name,
            step_id: &step.id,
            attempt,
            output: &output,
            projection: &projection,
            created_at: &runtime.options.created_at,
            authority_grant_refs: Vec::new(),
            closure: None,
        },
        runtime.options.signature_policy(),
    )?;
    let admission_witness = StepAdmissionWitness::local_runtime(&step.id, receipt.id.as_str());
    Ok(StepRun {
        step_id: step.id.clone(),
        attempt,
        skill: step.skill.as_deref().unwrap_or(step.id.as_str()).to_owned(),
        runner: step.runner.clone(),
        fanout_group: step.fanout_group.clone(),
        output,
        outputs: projection.outputs,
        receipt,
        admission_witness,
    })
}

fn step_admission_witness(
    step_id: &str,
    receipt_id: &str,
    authority: Option<&super::authority::StepAuthorityContext>,
) -> StepAdmissionWitness {
    authority.map_or_else(
        || StepAdmissionWitness::local_runtime(step_id, receipt_id),
        |authority| {
            StepAdmissionWitness::with_authority(
                step_id,
                receipt_id,
                authority.admission_witness().clone(),
            )
        },
    )
}

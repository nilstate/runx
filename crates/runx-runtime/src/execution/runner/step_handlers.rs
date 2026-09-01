// Step handlers implement the concrete approval, agent, nested-graph, tool,
// and sub-skill acts behind the typed dispatch boundary.

mod host_resolution;
mod inputs;
mod output;

#[cfg(feature = "catalog")]
use std::borrow::Cow;
use std::path::Path;
#[cfg(feature = "catalog")]
use std::time::Instant;

use output::{build_ephemeral_step_output, build_step_output_projection, contract_output_claim};

use runx_contracts::{
    ApprovalGate, ClosureDisposition, ExecutionEvent, JsonObject, JsonValue, ProvenanceEntry,
    Receipt, Reference, ResolutionRequest, ResolutionResponse, ResolutionResponseActor,
};
use runx_core::state_machine::StepAdmissionWitness;
use runx_parser::{GraphRunTarget, GraphStep, SkillArtifactContract, SkillSource, SourceKind};

use self::host_resolution::resolve_step_approval;
use self::inputs::{optional_input_string, required_input_string};
use super::super::graph::{
    LoadedStepSkill, StepSkillLoadOptions, load_step_skill, materialize_graph_parameter_inputs,
};
use super::super::skill_context::load_context_skills;
use super::admission::{
    EffectReceiptContext, StepAuthorityContext, enforce_step_authority_admission,
    finalize_effect_output_before_success, find_effect_replay, persist_effect_state_for_step,
    prepare_effect_execution, prepare_effect_output_before_gate, prepare_replay_output,
    recover_pending_effects, validate_replayed_effect,
};
use super::{
    GraphRun, Runtime, StepRun, graph_run_ephemeral_result, graph_run_result,
    graph_run_skill_output,
};
use crate::RuntimeError;
use crate::adapter::{
    BorrowedSkillAdapter, EphemeralValue, InvocationOutput, SkillAdapter, SkillInvocation,
};
use crate::agent_contract::verified_agent_metadata_with_artifacts;
use crate::agent_invocation::{
    AgentActInvocationSourceType, agent_act_invocation_id, agent_act_resolution_request,
};
use crate::approval::ApprovalResolution;
use crate::effects::EffectStepRequest;
use crate::effects::{EffectReplay, ResolvedEffectTarget};
use crate::execution::disposition::agent_answer_disposition_or_closed;
use crate::execution::output_projection::{StepOutputProjection, project_step_claim};
use crate::host::Host;
use crate::output_contract::{attach_verified_metadata, verified_runner_metadata_with_artifacts};
use crate::receipts::{RuntimeReceiptSignaturePolicy, StepSeal, StepSealClosure, seal_step};
use crate::services::merge_inferred_tool_roots;

const EXTERNAL_ADAPTER_HOST_RESOLUTION_REQUEST_METADATA: &str =
    "external_adapter_host_resolution_request";
const EXTERNAL_ADAPTER_HOST_RESOLUTION_RESPONSE_METADATA: &str =
    "external_adapter_host_resolution_response";

struct AgentSkillStepInvocation {
    skill_name: String,
    invocation: SkillInvocation,
    source_type: AgentActInvocationSourceType,
    artifacts: Option<SkillArtifactContract>,
}

struct RegularSkillStepOutput {
    output: InvocationOutput,
    projection: StepOutputProjection,
    ephemeral_contract: JsonObject,
    receipt_lineage: StepReceiptLineage,
}

#[derive(Default)]
struct StepReceiptLineage {
    direct_children: Vec<Receipt>,
    descendants: Vec<Receipt>,
}

impl StepReceiptLineage {
    fn from_graph(run: GraphRun) -> Self {
        let GraphRun { steps, receipt, .. } = run;
        let mut descendants = Vec::new();
        for mut step in steps {
            descendants.append(&mut step.nested_receipts);
            descendants.push(step.receipt);
        }
        Self {
            direct_children: vec![receipt],
            descendants,
        }
    }

    fn into_nested_receipts(mut self) -> Vec<Receipt> {
        self.descendants.append(&mut self.direct_children);
        self.descendants
    }
}

pub(super) struct StepRunRequest<'a, A> {
    pub(super) runtime: &'a Runtime<A>,
    pub(super) graph_dir: &'a Path,
    pub(super) graph_name: &'a str,
    pub(super) step: &'a GraphStep,
    pub(super) attempt: u32,
    pub(super) inputs: JsonObject,
    pub(super) provenance: Vec<ProvenanceEntry>,
    pub(super) policy_approval_refs: Vec<Reference>,
    pub(super) host: &'a mut dyn Host,
}

struct StepHandlerCtx<'a, A> {
    runtime: &'a Runtime<A>,
    graph_dir: &'a Path,
    graph_name: &'a str,
    step: &'a GraphStep,
    attempt: u32,
    inputs: JsonObject,
    provenance: Vec<ProvenanceEntry>,
    policy_approval_refs: Vec<Reference>,
    host: &'a mut dyn Host,
    authority: Option<StepAuthorityContext>,
    loaded_skill: Option<LoadedStepSkill>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StepExecutionKind {
    Approval,
    AgentTask,
    InlineSource,
    Tool,
    Subskill,
}

struct RegularSkillSeal<'a, A> {
    runtime: &'a Runtime<A>,
    graph_dir: &'a Path,
    graph_name: &'a str,
    step: &'a GraphStep,
    attempt: u32,
    skill_name: String,
    authority: Option<&'a StepAuthorityContext>,
    policy_approval_refs: Vec<Reference>,
}

pub(super) fn output_error(run: &StepRun) -> String {
    run.outcome
        .failure_message()
        .unwrap_or_else(|| "step failed without diagnostics".to_owned())
}

// Function rationale: step execution is one linear admit/run/seal sequence; splitting
// it would scatter the ordering invariants between admission, invocation, and receipt sealing.
pub(super) fn run_step_with_inputs<A>(
    request: StepRunRequest<'_, A>,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    run_step_with_optional_loaded_skill(request, None)
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

// Function rationale: this is the single routing point that
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
        provenance,
        policy_approval_refs,
        host,
    } = request;
    let effect_target = ResolvedEffectTarget {
        skill_name: loaded_skill.as_ref().map(|skill| skill.skill_name.as_str()),
        tool_ref: step.tool.as_deref(),
    };
    if let Some(replay) = find_effect_replay(
        step,
        effect_target,
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
        effect_target,
        &inputs,
        &runtime.options.env,
        graph_dir,
        &runtime.options.effects,
    )?;
    let authority = enforce_step_authority_admission(
        step,
        effect_target,
        &inputs,
        &runtime.options.env,
        graph_dir,
        &runtime.options.effects,
    )?;
    let authority = prepare_effect_execution(
        EffectStepRequest {
            step,
            target: effect_target,
            inputs: &inputs,
            env: &runtime.options.env,
            graph_dir,
        },
        authority,
        host,
        &runtime.options.effects,
    )?;
    run_registered_step(StepHandlerCtx {
        runtime,
        graph_dir,
        graph_name,
        step,
        attempt,
        inputs,
        provenance,
        policy_approval_refs,
        host,
        authority,
        loaded_skill,
    })
}

// Function rationale: loaded skill execution branches between
// agent-owned and local adapter paths while preserving one authority admission
// and receipt boundary.
fn run_loaded_skill_step<A>(
    skill: LoadedStepSkill,
    request: StepHandlerCtx<'_, A>,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let inputs = crate::input_contract::materialize_nested_runner_inputs(
        &skill.runner.inputs,
        &request.inputs,
    )
    .map_err(crate::input_contract::InputContractError::into_runtime_error)?;
    let request = StepHandlerCtx { inputs, ..request };
    let authority = request.authority.as_ref();
    // The invoked runner's artifact contract travels with the loaded skill so the
    // OUTER step exposes the sub-skill packet (e.g. `research_packet`) at
    // `<step>.<packet>.data`, never the sub-skill's internal step ids.
    let runner_artifacts = skill.runner.artifacts.clone();
    let (skill_name, invocation) = loaded_skill_invocation(skill, &request)?;
    crate::execution_environment::resolve_declared_environment(
        &invocation.requirements,
        &invocation.env,
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
                artifacts: runner_artifacts,
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
        runner_artifacts.as_ref(),
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
            policy_approval_refs: request.policy_approval_refs,
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
    let skill_directory = invocation.skill_directory.clone();
    let invocation_env = invocation.env.clone();
    let policy_approval_refs = request.policy_approval_refs.clone();
    let run = execute_nested_graph(request.runtime, request.host, &invocation)?;
    let result = graph_run_result(&run)?;
    let ephemeral_result = graph_run_ephemeral_result(&run);
    let mut output = graph_run_skill_output(&result, &run)?;
    let mut projection = build_step_output_projection(request.step, &output, None, None)?;
    adopt_nested_graph_result(&result, &mut projection.outputs);
    let mut ephemeral_contract = JsonObject::new();
    adopt_nested_graph_result(&ephemeral_result, &mut ephemeral_contract);
    let effect_claim = contract_output_claim(&projection);
    prepare_effect_output_before_gate(
        request.step,
        request.authority.as_ref(),
        effect_claim,
        &mut output,
        &request.runtime.options.effects,
    )?;
    if output.succeeded() {
        let metadata = verified_runner_metadata_with_artifacts(
            &skill_name,
            &output.value,
            None,
            request.step.artifacts.as_ref(),
            &skill_directory,
            &invocation_env,
        )?;
        attach_verified_metadata(&mut output, metadata)?;
    }
    let receipt_lineage = StepReceiptLineage::from_graph(run);
    seal_regular_skill_step(
        RegularSkillSeal {
            runtime: request.runtime,
            graph_dir: request.graph_dir,
            graph_name: request.graph_name,
            step: request.step,
            attempt: request.attempt,
            skill_name,
            authority: request.authority.as_ref(),
            policy_approval_refs,
        },
        RegularSkillStepOutput {
            output,
            projection,
            ephemeral_contract,
            receipt_lineage,
        },
    )
}

fn execute_nested_graph<A>(
    runtime: &Runtime<A>,
    host: &mut dyn Host,
    invocation: &SkillInvocation,
) -> Result<GraphRun, RuntimeError>
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
    let graph = materialize_graph_parameter_inputs(graph, &invocation.inputs);
    let mut child_options = runtime.options.as_ref().clone();
    child_options.env = invocation.env.clone();
    child_options.credential_delivery = invocation.credential_delivery.clone();
    let child_adapter: Box<dyn SkillAdapter + '_> =
        Box::new(BorrowedSkillAdapter::new(&runtime.configured_adapter));
    let child_runtime = Runtime::with_native_services(
        child_adapter,
        child_options,
        runtime.javascript.clone(),
        runtime.local_artifacts.clone(),
    );
    child_runtime.run_graph_with_host(&invocation.skill_directory, graph, host)
}

/// A nested graph exposes the same canonical public result that a top-level
/// graph returns. This keeps composition and direct invocation on one output
/// contract without re-reading the nested graph's diagnostic step state.
fn adopt_nested_graph_result(result: &JsonValue, outputs: &mut JsonObject) {
    let JsonValue::Object(result) = result else {
        return;
    };
    for (name, value) in result {
        outputs.insert(name.clone(), value.clone());
    }
}

fn loaded_skill_invocation(
    skill: LoadedStepSkill,
    request: &StepHandlerCtx<'_, impl SkillAdapter>,
) -> Result<(String, SkillInvocation), RuntimeError> {
    let skill_name = skill.runner.name.clone();
    let env = &request.runtime.options.env;
    let mut invocation_env = env.clone();
    merge_inferred_tool_roots(&mut invocation_env, &skill.directory);
    let credential_delivery = project_credential_delivery(
        &skill.runner.source.source_type,
        &request.runtime.options.credential_delivery,
    );
    let invocation = SkillInvocation {
        skill_name: skill.runner.name,
        step_id: Some(request.step.id.clone()),
        source: skill.runner.source,
        requirements: skill.requirements,
        artifacts: skill.runner.artifacts,
        allowed_tools: skill.runner.allowed_tools,
        inputs: request.inputs.clone(),
        resolved_inputs: JsonObject::new(),
        current_context: load_context_skills(
            &request.step.id,
            request.graph_dir,
            &request.step.context_skills,
            env,
            &request.runtime.options.created_at,
        )?,
        provenance: request.provenance.clone(),
        skill_directory: skill.directory,
        env: invocation_env,
        credential_delivery,
    };
    Ok((skill_name, invocation))
}

fn project_credential_delivery(
    source_kind: &SourceKind,
    delivery: &crate::credentials::CredentialDelivery,
) -> crate::credentials::CredentialDelivery {
    if *source_kind == SourceKind::JavaScript {
        crate::credentials::CredentialDelivery::none()
    } else {
        delivery.clone()
    }
}

fn invoke_regular_skill_step<A>(
    runtime: &Runtime<A>,
    step: &GraphStep,
    invocation: SkillInvocation,
    extra_artifacts: Option<&SkillArtifactContract>,
    authority: Option<&StepAuthorityContext>,
    host: &mut dyn Host,
) -> Result<RegularSkillStepOutput, RuntimeError>
where
    A: SkillAdapter,
{
    let skill_name = invocation.skill_name.clone();
    let raw_output = invocation.source.outputs.clone();
    let skill_directory = invocation.skill_directory.clone();
    let invocation_env = invocation.env.clone();
    let mut output = if invocation.source.source_type == SourceKind::JavaScript {
        // JavaScript sources are forbidden from receiving credentials, but a
        // graph legitimately mixes them with native credential-bearing tools
        // (a JS prepare/finalize around a native HTTP step). Project the
        // credential away here, the universal JS chokepoint every step path
        // funnels through, rather than fail the whole run.
        let mut invocation = invocation;
        invocation.credential_delivery =
            project_credential_delivery(&SourceKind::JavaScript, &invocation.credential_delivery);
        runtime
            .javascript
            .invoke_with_artifacts(invocation, &runtime.local_artifacts)?
    } else {
        runtime.configured_adapter.invoke(invocation)?
    };
    route_external_adapter_host_resolution(step, host, &mut output)?;
    let provisional_projection =
        build_step_output_projection(step, &output, raw_output.as_ref(), extra_artifacts)?;
    let effect_claim = contract_output_claim(&provisional_projection);
    prepare_effect_output_before_gate(
        step,
        authority,
        effect_claim,
        &mut output,
        &runtime.options.effects,
    )?;
    // An effect may remove transient provider material before sealing. Rebuild
    // the projection so receipts, durable replay state, and downstream context
    // all observe the same public output.
    let projection =
        build_step_output_projection(step, &output, raw_output.as_ref(), extra_artifacts)?;
    let ephemeral_contract =
        build_ephemeral_step_output(step, &output, raw_output.as_ref(), extra_artifacts);
    if output.succeeded() {
        let metadata = verified_runner_metadata_with_artifacts(
            &skill_name,
            &output.value,
            raw_output.as_ref(),
            step.artifacts.as_ref().or(extra_artifacts),
            &skill_directory,
            &invocation_env,
        )?;
        attach_verified_metadata(&mut output, metadata)?;
    }
    Ok(RegularSkillStepOutput {
        output,
        projection,
        ephemeral_contract,
        receipt_lineage: StepReceiptLineage::default(),
    })
}

// Function rationale: sealing keeps the declared contract, effect evidence, and
// receipt construction consistent.
fn seal_regular_skill_step<A>(
    context: RegularSkillSeal<'_, A>,
    regular: RegularSkillStepOutput,
) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let RegularSkillStepOutput {
        mut output,
        mut projection,
        ephemeral_contract,
        receipt_lineage,
    } = regular;
    let projection_refs = std::mem::take(&mut projection.refs);
    let effect_claim = contract_output_claim(&projection);
    let authority_grant_refs = context
        .authority
        .map(|authority| authority.authority_grant_refs(&context.runtime.options.effects))
        .transpose()?
        .unwrap_or_default();
    let authority_scope_refs = context
        .authority
        .map(|authority| authority.authority_scope_refs(&context.runtime.options.effects))
        .transpose()?
        .unwrap_or_default();
    let receipt = seal_executed_step(
        StepSeal {
            graph_name: context.graph_name,
            step_id: &context.step.id,
            attempt: context.attempt,
            output: &output,
            claim: &projection.outputs,
            projection_refs,
            created_at: &context.runtime.options.created_at,
            authority_grant_refs,
            authority_scope_refs,
            operator_refs: tool_operator_references(
                &context.runtime.options.env,
                context.policy_approval_refs,
            ),
            child_receipts: &receipt_lineage.direct_children,
            descendant_receipts: &receipt_lineage.descendants,
            closure: None,
            receipt_metadata: None,
        },
        context.runtime.options.signature_policy(),
    )?;
    finalize_effect_output_before_success(EffectReceiptContext {
        step: context.step,
        graph_dir: context.graph_dir,
        authority: context.authority,
        claim: effect_claim,
        output: &mut output,
        receipt: &receipt,
        env: &context.runtime.options.env,
        signature_policy: context.runtime.options.signature_policy(),
        effects: &context.runtime.options.effects,
    })
    .map_err(|source| RuntimeError::engine("finalizing a sealed provider effect", source))?;
    persist_effect_state_for_step(EffectReceiptContext {
        step: context.step,
        graph_dir: context.graph_dir,
        authority: context.authority,
        claim: effect_claim,
        output: &mut output,
        receipt: &receipt,
        env: &context.runtime.options.env,
        signature_policy: context.runtime.options.signature_policy(),
        effects: &context.runtime.options.effects,
    })
    .map_err(|source| RuntimeError::engine("persisting a sealed provider effect", source))?;
    // The authority witness is sealed centrally in run_registered_step; the seal
    // path records a neutral witness and uses `authority` only for effect output
    // finalization above.
    let admission_witness =
        StepAdmissionWitness::local_runtime(&context.step.id, receipt.id.as_str());
    Ok(StepRun {
        step_id: context.step.id.clone(),
        attempt: context.attempt,
        skill: context.skill_name,
        runner: context.step.runner.clone(),
        fanout_group: context.step.fanout_group.clone(),
        contract: projection.outputs,
        ephemeral_contract: EphemeralValue::from_value(JsonValue::Object(ephemeral_contract)),
        outcome: output.into(),
        receipt,
        nested_receipts: receipt_lineage.into_nested_receipts(),
        admission_witness,
    })
}

fn route_external_adapter_host_resolution(
    step: &GraphStep,
    host: &mut dyn Host,
    output: &mut InvocationOutput,
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

// Function rationale: replay execution keeps effect recovery, receipt validation, and final output in one audited path.
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
    let skill_name = skill.runner.name.clone();
    let mut output = replay_skill_output(step, replay.outputs())?;
    if !output.succeeded() {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: "sealed effect replay requires a successful stored output".to_owned(),
        });
    }
    prepare_replay_output(step, &replay, &mut output, &runtime.options.effects)?;
    // Project the replayed output through the SAME contract as the fresh path: a
    // sub-skill's declared runner artifacts must be exposed on replay too, or a
    // downstream edge that resolves on a fresh run would fail only on replay.
    let mut projection = build_step_output_projection(
        step,
        &output,
        skill.runner.source.outputs.as_ref(),
        skill.runner.artifacts.as_ref(),
    )?;
    let authority_grant_refs = runtime
        .options
        .effects
        .replay_authority_grant_refs(&replay)
        .map_err(|source| RuntimeError::ReceiptInvalid {
            message: source.to_string(),
        })?;
    let receipt = seal_executed_step(
        StepSeal {
            graph_name,
            step_id: &step.id,
            attempt,
            output: &output,
            claim: &projection.outputs,
            projection_refs: std::mem::take(&mut projection.refs),
            created_at: replay.receipt_created_at(),
            authority_grant_refs,
            authority_scope_refs: Vec::new(),
            operator_refs: crate::execution::prepared_skill::prepared_receipt_references(
                &runtime.options.env,
            ),
            child_receipts: &[],
            descendant_receipts: &[],
            closure: None,
            receipt_metadata: None,
        },
        runtime.options.signature_policy(),
    )?;
    validate_replayed_receipt_identity(step, &receipt, &replay)?;
    let effect_claim = contract_output_claim(&projection);
    validate_replayed_effect(
        step,
        &replay,
        &receipt,
        &output,
        effect_claim,
        &runtime.options.effects,
    )?;
    let admission_witness = StepAdmissionWitness::local_runtime(&step.id, replay.receipt_ref());
    Ok(StepRun {
        step_id: step.id.clone(),
        attempt,
        skill: skill_name,
        runner: step.runner.clone(),
        fanout_group: step.fanout_group.clone(),
        contract: projection.outputs,
        ephemeral_contract: EphemeralValue::default(),
        outcome: output.into(),
        receipt,
        nested_receipts: Vec::new(),
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
    _step: &GraphStep,
    outputs: &JsonObject,
) -> Result<InvocationOutput, RuntimeError> {
    Ok(InvocationOutput::runtime_success(
        JsonValue::Object(outputs.clone()),
        0,
        JsonObject::new(),
    ))
}

fn run_registered_step<A>(request: StepHandlerCtx<'_, A>) -> Result<StepRun, RuntimeError>
where
    A: SkillAdapter,
{
    let kind = step_execution_kind(request.step)?;
    // Every registered step is admitted centrally (enforce_step_authority_admission,
    // upstream) and sealed centrally here: this is the single place a step's
    // admission witness records which authority admitted the act, or falls back to a
    // local-runtime witness when none was admitted. Handlers produce the output and
    // receipt; they never set the authority witness, so a new step type cannot
    // regress the uniform-governance invariant. See `docs/governance-invariant.md`
    // for the full admit -> credentials -> execution -> seal contract.
    let step_id = request.step.id.clone();
    let authority = request.authority.clone();
    let mut run = match kind {
        StepExecutionKind::Approval => run_approval_step(
            request.runtime,
            request.graph_name,
            request.step,
            request.attempt,
            request.inputs,
            request.host,
        )?,
        StepExecutionKind::AgentTask => run_agent_task(request)?,
        StepExecutionKind::InlineSource => run_inline_source_step(request)?,
        StepExecutionKind::Tool => run_tool_step(request)?,
        StepExecutionKind::Subskill => run_subskill_step(request)?,
    };
    run.admission_witness =
        step_admission_witness(&step_id, run.receipt.id.as_str(), authority.as_ref());
    Ok(run)
}

fn step_execution_kind(step: &GraphStep) -> Result<StepExecutionKind, RuntimeError> {
    if let Some(run) = &step.run {
        return match run {
            GraphRunTarget::Approval => Ok(StepExecutionKind::Approval),
            GraphRunTarget::Source(source) => match source.source_type {
                SourceKind::AgentStep => Ok(StepExecutionKind::AgentTask),
                SourceKind::CliTool | SourceKind::JavaScript => Ok(StepExecutionKind::InlineSource),
                other => Err(RuntimeError::UnsupportedRunStep {
                    step_id: step.id.clone(),
                    run_type: other.as_str().to_owned(),
                }),
            },
        };
    }
    if step.tool.is_some() {
        return Ok(StepExecutionKind::Tool);
    }
    Ok(StepExecutionKind::Subskill)
}

fn run_subskill_step<A>(mut request: StepHandlerCtx<'_, A>) -> Result<StepRun, RuntimeError>
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

// An inline source runs through the same projection and sealing path as a
// referenced skill. The parser has already restricted this lane to cli-tool or
// deterministic JavaScript sources.
fn run_inline_source_step<A>(request: StepHandlerCtx<'_, A>) -> Result<StepRun, RuntimeError>
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
        provenance,
        host,
        authority,
        loaded_skill: _,
        policy_approval_refs,
    } = request;
    let source = inline_source(step)?;
    let requirements = inline_step_requirements(step, &source);
    let invocation = SkillInvocation {
        skill_name: step.id.clone(),
        step_id: Some(step.id.clone()),
        source,
        requirements,
        artifacts: step.artifacts.clone(),
        allowed_tools: step.allowed_tools.clone(),
        inputs,
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        provenance,
        skill_directory: graph_dir.to_path_buf(),
        env: runtime.options.env.clone(),
        credential_delivery: runtime.options.credential_delivery.clone(),
    };
    // Inline cli-tool step: its contract is the step's own `run.outputs` /
    // `artifacts`, so no extra runner contract is threaded.
    let regular =
        invoke_regular_skill_step(runtime, step, invocation, None, authority.as_ref(), host)?;
    seal_regular_skill_step(
        RegularSkillSeal {
            runtime,
            graph_dir,
            graph_name,
            step,
            attempt,
            skill_name: step.id.clone(),
            authority: authority.as_ref(),
            policy_approval_refs,
        },
        regular,
    )
}

fn inline_source(step: &GraphStep) -> Result<SkillSource, RuntimeError> {
    let Some(run) = &step.run else {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: "missing run configuration".to_owned(),
        });
    };
    run.source()
        .cloned()
        .ok_or_else(|| RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: "approval control cannot execute as an inline source".to_owned(),
        })
}

// The shared close for an agent act: a resolved host response becomes the
// step's output, projection, and sealed receipt. Both the inline `agent-task`
// step and a referenced agent skill end here, so the agent-act seal lives in
// one place.
struct AgentActStepSeal<'a> {
    graph_name: &'a str,
    step: &'a GraphStep,
    attempt: u32,
    skill_name: String,
    response: ResolutionResponse,
    extra_outputs: Option<&'a JsonObject>,
    extra_artifacts: Option<&'a SkillArtifactContract>,
    verification_metadata: JsonObject,
}

fn seal_agent_act_step<A>(
    runtime: &Runtime<A>,
    request: AgentActStepSeal<'_>,
) -> Result<StepRun, RuntimeError> {
    let AgentActStepSeal {
        graph_name,
        step,
        attempt,
        skill_name,
        response,
        extra_outputs,
        extra_artifacts,
        verification_metadata,
    } = request;
    let disposition = agent_answer_disposition_value(step, &response.payload)?;
    let mut output = agent_task_output(response, &disposition)?;
    output.metadata.extend(verification_metadata);
    let mut projection =
        build_step_output_projection(step, &output, extra_outputs, extra_artifacts)?;
    let disposition_label = disposition.label();
    let receipt = seal_executed_step(
        StepSeal {
            graph_name,
            step_id: &step.id,
            attempt,
            output: &output,
            claim: &projection.outputs,
            projection_refs: std::mem::take(&mut projection.refs),
            created_at: &runtime.options.created_at,
            authority_grant_refs: Vec::new(),
            authority_scope_refs: Vec::new(),
            operator_refs: crate::execution::prepared_skill::prepared_receipt_references(
                &runtime.options.env,
            ),
            child_receipts: &[],
            descendant_receipts: &[],
            closure: Some(StepSealClosure {
                disposition,
                reason_code: format!("agent_act_{disposition_label}"),
                summary: format!("agent act closed with {disposition_label}"),
            }),
            receipt_metadata: None,
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
        contract: projection.outputs,
        ephemeral_contract: EphemeralValue::default(),
        outcome: output.into(),
        receipt,
        nested_receipts: Vec::new(),
        admission_witness,
    })
}

// Function rationale: agent-task execution is one
// request/resolve/seal trust-boundary path.
fn run_agent_task<A>(request: StepHandlerCtx<'_, A>) -> Result<StepRun, RuntimeError>
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
        provenance,
        host,
        authority: _,
        loaded_skill: _,
        policy_approval_refs: _,
    } = request;
    let source = agent_task_source(step)?;
    let requirements = inline_step_requirements(step, &source);
    let invocation = SkillInvocation {
        skill_name: step.id.clone(),
        step_id: Some(step.id.clone()),
        source,
        requirements,
        artifacts: step.artifacts.clone(),
        allowed_tools: step.allowed_tools.clone(),
        inputs,
        resolved_inputs: JsonObject::new(),
        current_context: load_context_skills(
            &step.id,
            graph_dir,
            &step.context_skills,
            &runtime.options.env,
            &runtime.options.created_at,
        )?,
        provenance,
        skill_directory: graph_dir.to_path_buf(),
        env: runtime.options.env.clone(),
        credential_delivery: runtime.options.credential_delivery.clone(),
    };
    let source_type = AgentActInvocationSourceType::AgentStep;
    let request_id = agent_act_invocation_id(&invocation, source_type);
    let request = agent_act_resolution_request(&invocation, source_type)?;
    let verification_request = request.clone();
    host.report(ExecutionEvent::ResolutionRequested {
        message: format!("agent step '{}' requested resolution", step.id),
        data: Some(resolution_event_data(step, &request)?),
    })?;
    let Some(response) = host.resolve(request)? else {
        return Err(RuntimeError::ResolutionPending {
            step_id: step.id.clone(),
            reason: format!("agent act {request_id} requires resolution"),
        });
    };
    let verification_metadata = verified_agent_metadata_with_artifacts(
        &verification_request,
        &response.payload,
        step.artifacts.as_ref(),
        graph_dir,
        &runtime.options.env,
    )?;
    // Inline agent-task step: contract is the step's own `run.outputs` / `artifacts`.
    seal_agent_act_step(
        runtime,
        AgentActStepSeal {
            graph_name,
            step,
            attempt,
            skill_name: "run:agent-task".to_owned(),
            response,
            extra_outputs: None,
            extra_artifacts: None,
            verification_metadata,
        },
    )
}

fn inline_step_requirements(
    step: &GraphStep,
    source: &SkillSource,
) -> runx_contracts::ExecutionRequirements {
    runx_contracts::ExecutionRequirements {
        scopes: step.scopes.clone(),
        environment: source.environment.clone(),
        ..runx_contracts::ExecutionRequirements::default()
    }
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
        artifacts,
    } = agent_task;
    let skill_directory = invocation.skill_directory.clone();
    let invocation_env = invocation.env.clone();
    let request_id = agent_act_invocation_id(&invocation, source_type);
    let outputs = invocation.source.outputs.clone();
    let request = agent_act_resolution_request(&invocation, source_type)?;
    let verification_request = request.clone();
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
    let verification_metadata = verified_agent_metadata_with_artifacts(
        &verification_request,
        &response.payload,
        artifacts.as_ref(),
        &skill_directory,
        &invocation_env,
    )?;
    // Referenced agent-task sub-skill: expose the invoked runner's artifact
    // contract at the outer step.
    seal_agent_act_step(
        runtime,
        AgentActStepSeal {
            graph_name,
            step,
            attempt,
            skill_name,
            response,
            extra_outputs: outputs.as_ref(),
            extra_artifacts: artifacts.as_ref(),
            verification_metadata,
        },
    )
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
        .ok_or_else(|| RuntimeError::ResolutionPending {
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
    let Some(source) = run.source() else {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: "approval control cannot execute as an agent task".to_owned(),
        });
    };
    if source.source_type != SourceKind::AgentStep {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: format!("expected agent-task source, got {}", source.source_type),
        });
    }
    Ok(source.clone())
}

// Function rationale: tool execution keeps lookup,
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
        provenance: _,
        policy_approval_refs,
        host: _,
        authority,
        loaded_skill: _,
    } = request;
    #[cfg(not(feature = "catalog"))]
    {
        let _ = (
            runtime,
            graph_dir,
            graph_name,
            step,
            attempt,
            inputs,
            policy_approval_refs,
            authority,
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
        let tool_request = crate::tool_catalogs::dispatch::ToolDispatchRequest {
            tool_ref: Cow::Borrowed(tool_ref),
            inputs: Cow::Owned(inputs),
            resolved_inputs: Cow::Owned(JsonObject::new()),
            scopes: &step.scopes,
            env: &runtime.options.env,
            skill_directory: graph_dir,
            credential_delivery: &runtime.options.credential_delivery,
            local_artifacts: &runtime.local_artifacts,
            javascript: &runtime.javascript,
            skill_name: tool_ref,
            allow_explicit_manifest_path: true,
            effect_admission: authority.as_ref().map(StepAuthorityContext::admission),
        };
        // Source the tool manifest's artifact contract so the wrapped packet the
        // dispatcher folds into the claim (e.g. `data_operation_result`) is
        // exposed at the OUTER step as `<step>.<packet>.data`.
        let tool_artifacts = crate::tool_catalogs::dispatch::resolve_tool_artifacts(
            &tool_request,
            &runtime.options.effects,
        )?;
        let mut output = crate::tool_catalogs::dispatch::dispatch_tool(
            tool_request,
            &runtime.options.effects,
            &runtime.options.created_at,
            Instant::now(),
        )?;
        let provisional_projection =
            build_step_output_projection(step, &output, None, tool_artifacts.as_ref())?;
        let provisional_claim = contract_output_claim(&provisional_projection);
        prepare_effect_output_before_gate(
            step,
            authority.as_ref(),
            provisional_claim,
            &mut output,
            &runtime.options.effects,
        )?;
        let mut projection =
            build_step_output_projection(step, &output, None, tool_artifacts.as_ref())?;
        let ephemeral_contract =
            build_ephemeral_step_output(step, &output, None, tool_artifacts.as_ref());
        let projection_refs = std::mem::take(&mut projection.refs);
        let effect_claim = contract_output_claim(&projection);
        let authority_grant_refs = authority
            .as_ref()
            .map(|authority| authority.authority_grant_refs(&runtime.options.effects))
            .transpose()?
            .unwrap_or_default();
        let authority_scope_refs = authority
            .as_ref()
            .map(|authority| authority.authority_scope_refs(&runtime.options.effects))
            .transpose()?
            .unwrap_or_default();
        let receipt = seal_executed_step(
            StepSeal {
                graph_name,
                step_id: &step.id,
                attempt,
                output: &output,
                claim: effect_claim,
                projection_refs,
                created_at: &runtime.options.created_at,
                authority_grant_refs,
                authority_scope_refs,
                operator_refs: tool_operator_references(&runtime.options.env, policy_approval_refs),
                child_receipts: &[],
                descendant_receipts: &[],
                closure: None,
                receipt_metadata: None,
            },
            runtime.options.signature_policy(),
        )?;
        finalize_effect_output_before_success(EffectReceiptContext {
            step,
            graph_dir,
            authority: authority.as_ref(),
            claim: effect_claim,
            output: &mut output,
            receipt: &receipt,
            env: &runtime.options.env,
            signature_policy: runtime.options.signature_policy(),
            effects: &runtime.options.effects,
        })
        .map_err(|source| RuntimeError::engine("finalizing a sealed provider effect", source))?;
        persist_effect_state_for_step(EffectReceiptContext {
            step,
            graph_dir,
            authority: authority.as_ref(),
            claim: effect_claim,
            output: &mut output,
            receipt: &receipt,
            env: &runtime.options.env,
            signature_policy: runtime.options.signature_policy(),
            effects: &runtime.options.effects,
        })
        .map_err(|source| RuntimeError::engine("persisting a sealed provider effect", source))?;
        let admission_witness = StepAdmissionWitness::local_runtime(&step.id, receipt.id.as_str());
        Ok(StepRun {
            step_id: step.id.clone(),
            attempt,
            skill: format!("tool:{tool_ref}"),
            runner: step.runner.clone(),
            fanout_group: step.fanout_group.clone(),
            contract: projection.outputs,
            ephemeral_contract: EphemeralValue::from_value(JsonValue::Object(ephemeral_contract)),
            outcome: output.into(),
            receipt,
            nested_receipts: Vec::new(),
            admission_witness,
        })
    }
}

fn tool_operator_references(
    env: &std::collections::BTreeMap<String, String>,
    policy_approval_refs: Vec<Reference>,
) -> Vec<Reference> {
    let mut references = crate::execution::prepared_skill::prepared_receipt_references(env);
    references.extend(policy_approval_refs);
    references
}

fn agent_task_output(
    response: ResolutionResponse,
    disposition: &ClosureDisposition,
) -> Result<InvocationOutput, RuntimeError> {
    let succeeded = *disposition == ClosureDisposition::Closed;
    Ok(if succeeded {
        InvocationOutput::runtime_success(response.payload, 0, JsonObject::new())
    } else {
        InvocationOutput::runtime_failure(
            response.payload,
            format!("agent act closed with {}", disposition.label()),
            0,
            JsonObject::new(),
        )
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

fn agent_answer_disposition_value(
    step: &GraphStep,
    answer: &JsonValue,
) -> Result<ClosureDisposition, RuntimeError> {
    agent_answer_disposition_or_closed(answer).map_err(|error| RuntimeError::InvalidRunStep {
        step_id: step.id.clone(),
        reason: format!("{error}"),
    })
}

// Function rationale: an approval step resolves, projects,
// and seals one trust-boundary decision without exposing a partially built receipt.
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
    let resolution = completed_approval_resolution(
        step,
        &gate,
        resolve_step_approval(step, host, request_id, gate.clone())?,
    )?;
    let outputs = approval_outputs(step, &gate, &resolution)?;
    let output =
        InvocationOutput::runtime_success(JsonValue::Object(outputs.clone()), 0, JsonObject::new());
    let mut projection = project_step_claim(outputs);
    let receipt = seal_executed_step(
        StepSeal {
            graph_name,
            step_id: &step.id,
            attempt,
            output: &output,
            claim: &projection.outputs,
            projection_refs: std::mem::take(&mut projection.refs),
            created_at: &runtime.options.created_at,
            authority_grant_refs: Vec::new(),
            authority_scope_refs: Vec::new(),
            operator_refs: crate::execution::prepared_skill::prepared_receipt_references(
                &runtime.options.env,
            ),
            child_receipts: &[],
            descendant_receipts: &[],
            closure: None,
            receipt_metadata: None,
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
        contract: projection.outputs,
        ephemeral_contract: EphemeralValue::default(),
        outcome: output.into(),
        receipt,
        nested_receipts: Vec::new(),
        admission_witness,
    })
}

fn completed_approval_resolution(
    step: &GraphStep,
    gate: &ApprovalGate,
    resolution: ApprovalResolution,
) -> Result<ApprovalResolution, RuntimeError> {
    if matches!(resolution, ApprovalResolution::Pending { .. }) {
        return Err(RuntimeError::ResolutionPending {
            step_id: step.id.clone(),
            reason: format!("approval gate '{}' is pending", gate.id),
        });
    }
    Ok(resolution)
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
    if let Some(gate_type) = &gate.gate_type {
        data.insert("gate_type".to_owned(), JsonValue::String(gate_type.clone()));
    }
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
    if let Some(reason) = resolution.reason() {
        data.insert("reason".to_owned(), JsonValue::String(reason.to_owned()));
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
    Ok(artifacts.wrap_as.as_deref().unwrap_or("approval"))
}

pub(super) fn artifact_packet(step: &GraphStep) -> Result<Option<String>, RuntimeError> {
    Ok(step
        .artifacts
        .as_ref()
        .and_then(|artifacts| artifacts.packet.clone()))
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
    let (metadata, receipt_metadata) = match &error {
        #[cfg(feature = "agent")]
        RuntimeError::ManagedAgentResolution { source, .. } => {
            let metadata = source.receipt_metadata();
            (metadata.clone(), Some(metadata))
        }
        _ => (JsonObject::new(), None),
    };
    let output = InvocationOutput::runtime_failure(
        JsonValue::Object(error.public_failure_projection()),
        error.to_string(),
        0,
        metadata,
    );
    let mut projection = project_step_claim(JsonObject::new());
    let receipt = seal_step(
        StepSeal {
            graph_name,
            step_id: &step.id,
            attempt,
            output: &output,
            claim: &projection.outputs,
            projection_refs: std::mem::take(&mut projection.refs),
            created_at: &runtime.options.created_at,
            authority_grant_refs: Vec::new(),
            authority_scope_refs: Vec::new(),
            operator_refs: crate::execution::prepared_skill::prepared_receipt_references(
                &runtime.options.env,
            ),
            child_receipts: &[],
            descendant_receipts: &[],
            closure: None,
            receipt_metadata,
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
        contract: projection.outputs,
        ephemeral_contract: EphemeralValue::default(),
        outcome: output.into(),
        receipt,
        nested_receipts: Vec::new(),
        admission_witness,
    })
}

fn seal_executed_step(
    request: StepSeal<'_>,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    seal_step(request, signature_policy)
        .map_err(|source| RuntimeError::engine("sealing a graph step receipt", source))
}

fn step_admission_witness(
    step_id: &str,
    receipt_id: &str,
    authority: Option<&super::admission::StepAuthorityContext>,
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

#[cfg(test)]
mod credential_projection {
    use runx_parser::SourceKind;

    #[test]
    fn credential_projection_strips_javascript_and_preserves_owned_targets()
    -> Result<(), Box<dyn std::error::Error>> {
        let delivery = crate::credentials::CredentialDelivery::from_local_descriptor(
            "example-provider",
            "api_key",
            "EXAMPLE_TOKEN",
            "local:example-provider",
            vec!["provider.read".to_owned()],
            "credential-projection-sentinel",
        )?;

        let javascript = super::project_credential_delivery(&SourceKind::JavaScript, &delivery);
        let native = super::project_credential_delivery(&SourceKind::CliTool, &delivery);

        assert!(javascript.secret_env().is_empty());
        assert!(javascript.public_observation().is_none());
        assert_eq!(
            native.secret_env().get("EXAMPLE_TOKEN"),
            Some("credential-projection-sentinel")
        );
        assert!(native.public_observation().is_some());
        Ok(())
    }
}

#[cfg(test)]
mod inline_requirements {
    use runx_parser::{parse_graph_yaml, validate_graph};

    #[test]
    fn inline_step_projects_scopes_and_environment_without_interpretation()
    -> Result<(), Box<dyn std::error::Error>> {
        let graph = validate_graph(parse_graph_yaml(
            r#"
name: inline-requirements
steps:
  - id: compute
    scopes:
      - "vendor.operation:v3"
      - "opaque capability with spaces"
      - "vendor.operation:v3"
    run:
      type: javascript
      module: compute.mjs
      environment:
        required: [REGION]
        optional: [TRACE_LABEL]
"#,
        )?)?;
        let step = graph.steps.first().ok_or("missing step")?;
        let source = step
            .run
            .as_ref()
            .and_then(|run| run.source())
            .ok_or("missing inline source")?;

        let requirements = super::inline_step_requirements(step, source);

        assert_eq!(
            requirements.scopes,
            [
                "vendor.operation:v3",
                "opaque capability with spaces",
                "vendor.operation:v3"
            ]
        );
        assert_eq!(requirements.environment.required, ["REGION"]);
        assert_eq!(requirements.environment.optional, ["TRACE_LABEL"]);
        Ok(())
    }
}

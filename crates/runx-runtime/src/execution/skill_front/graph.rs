// rust-style-allow: large-file - graph skill-front execution keeps nested skill
// resolution, graph state projection, and receipt handoff together until the
// graph runner/front boundary is split.
use super::{
    GRAPH_SKILL_STATE_SCHEMA, SkillRunError, SkillRunOverrides, build_domain_act_frame,
    contract_json_value, identifier_segment, invalid, needs_agent_output, sealed_output,
};

use std::collections::BTreeMap;
use std::path::PathBuf;

use runx_contracts::{
    ClosureDisposition, JsonObject, JsonValue, ResolutionRequest, ResolutionResponse,
    ResolutionResponseActor, sha256_hex,
};
use runx_core::state_machine::GraphStatus;
use runx_parser::{ExecutionGraph, SkillRunnerDefinition, SkillRunnerManifest};
use serde::{Deserialize, Serialize};

use crate::RuntimeError;
#[cfg(any(
    feature = "catalog",
    feature = "cli-tool",
    feature = "external-adapter",
    feature = "http",
    feature = "thread-outbox-provider"
))]
use crate::adapter::SkillAdapter;
use crate::adapter::{SkillInvocation, SkillOutput};
#[cfg(feature = "cli-tool")]
use crate::adapters::cli_tool::CliToolAdapter;
use crate::credentials::CredentialDelivery;
use crate::effects::RuntimeEffectRegistry;
use crate::execution::graph::materialize_graph_inputs;
use crate::execution::orchestrator::SkillRunRequest;
use crate::execution::runner::{
    GraphCheckpoint, GraphRun, RUNX_RUN_ID_ENV, Runtime, RuntimeOptions, graph_run_payload,
    graph_run_skill_output,
};
use crate::host::Host;
use crate::journal::{PausedRunCheckpoint, append_paused_run_checkpoint};
use crate::receipts::{DomainActReceiptRequest, RuntimeReceiptSignatureConfig, domain_act_receipt};
use crate::services::{ReceiptServices, WorkspaceEnv};

use super::graph_state::{read_answers, read_graph_state, write_graph_state};
use super::runner_manifest::{
    credential_delivery_from_invocation, resolve_skill_dir, write_skill_receipt,
};

// rust-style-allow: long-function because graph-backed skill execution keeps
// checkpoint hydration, host resolution, and final receipt sealing in one path.
pub(super) fn execute_graph_skill_run(
    request: &SkillRunRequest,
    overrides: &SkillRunOverrides,
    effects: &RuntimeEffectRegistry,
    workspace: &WorkspaceEnv,
    receipts: &ReceiptServices,
    manifest: &SkillRunnerManifest,
    runner: &SkillRunnerDefinition,
) -> Result<JsonValue, SkillRunError> {
    let graph = runner
        .source
        .graph
        .clone()
        .ok_or_else(|| invalid("graph runner is missing source.graph"))?;
    let request_graph_inputs = request
        .inputs
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<JsonObject>();
    let run_id = graph_run_id(request, runner)?;
    let skill_dir = resolve_skill_dir(&request.skill_path)?;
    let mut env = workspace.skill_env_for_skill(&skill_dir);
    env.insert(RUNX_RUN_ID_ENV.to_owned(), run_id.clone());
    let credential_delivery =
        credential_delivery_from_invocation(workspace.env(), request.local_credential.as_ref())?;
    let inline_resolver = InlineResolver {
        skill_directory: skill_dir.clone(),
        env: env.clone(),
        credential_delivery: credential_delivery.clone(),
    };
    let created_at = crate::time::now_iso8601();
    let runtime = Runtime::new(
        SkillRunGraphAdapter::default(),
        RuntimeOptions {
            created_at: created_at.clone(),
            env,
            receipt_signature: receipts.signature_config().clone(),
            effects: effects.clone(),
            credential_delivery,
        },
    );
    // Seeded answers run a single fresh pass with the answers pre-loaded into the
    // host (they drive the graph to completion, or block -> needs_agent when a
    // step has no seeded answer). The file-based `answers_path` remains the
    // resume-from-checkpoint channel.
    let seeded = overrides.seeded_answers.clone();
    let resume = request.answers_path.is_some() && seeded.is_none();
    let answers = match &seeded {
        Some(seeded) => seeded.clone(),
        None => match &request.answers_path {
            Some(path) => read_answers(path)?,
            None => JsonObject::new(),
        },
    };
    let mut resumed_state = if resume {
        Some(read_graph_state(
            request,
            workspace,
            receipts,
            &run_id,
            &runner.name,
        )?)
    } else {
        None
    };
    let graph_inputs = resumed_state
        .as_ref()
        .map(|state| {
            if state.graph_inputs.is_empty() {
                request_graph_inputs.clone()
            } else {
                state.graph_inputs.clone()
            }
        })
        .unwrap_or_else(|| request_graph_inputs.clone());
    if let Some(missing_request) = missing_required_graph_input_request(runner, &graph_inputs) {
        return Ok(JsonValue::Object(needs_agent_output(
            &run_id,
            "graph.required-inputs",
            missing_request,
        )));
    }
    let graph = materialize_graph_inputs(graph, &graph_inputs);
    let mut host = SkillRunGraphHost::with_inline(answers, inline_resolver);
    let mut checkpoint = if let Some(state) = resumed_state.take() {
        state.checkpoint
    } else {
        runtime.run_graph_until_steps_with_host(&skill_dir, &graph, 0, &mut host)?
    };

    loop {
        let previous_checkpoint = checkpoint.clone();
        match runtime
            .resume_graph_until_steps_with_host(&skill_dir, &graph, checkpoint, 1, &mut host)
        {
            Ok(next_checkpoint) => {
                if next_checkpoint.state.status == GraphStatus::Succeeded {
                    let mut final_host = SkillRunGraphHost::new(JsonObject::new());
                    let run = runtime.seal_completed_graph_checkpoint_with_host(
                        graph.clone(),
                        next_checkpoint,
                        &mut final_host,
                    )?;
                    write_graph_receipts(request, workspace, receipts, &run)?;
                    let payload = graph_run_payload(&run, false);
                    // A graph that declares an `act:` block seals a clean domain-act
                    // receipt as its primary receipt; the step receipts above remain
                    // as its execution trace.
                    let domain = graph_domain_act_receipt(
                        runner,
                        &graph_inputs,
                        &run,
                        &run_id,
                        &created_at,
                        receipts.signature_config(),
                    )?;
                    if let Some(domain_receipt) = &domain {
                        write_skill_receipt(request, workspace, receipts, domain_receipt)?;
                    }
                    let receipt = domain.as_ref().unwrap_or(&run.receipt);
                    let output = graph_run_skill_output(&payload, &run)?;
                    return Ok(JsonValue::Object(sealed_output(
                        manifest,
                        &run_id,
                        &output,
                        &payload,
                        receipt,
                        contract_json_value(receipt)?,
                    )));
                }
                write_graph_state(
                    request,
                    workspace,
                    receipts,
                    &run_id,
                    &GraphSkillRunState {
                        schema: GRAPH_SKILL_STATE_SCHEMA.to_owned(),
                        run_id: run_id.clone(),
                        runner_name: runner.name.clone(),
                        graph_inputs: graph_inputs.clone(),
                        checkpoint: next_checkpoint.clone(),
                    },
                )?;
                checkpoint = next_checkpoint;
            }
            Err(RuntimeError::GraphBlocked { .. }) if host.pending_request().is_some() => {
                write_graph_state(
                    request,
                    workspace,
                    receipts,
                    &run_id,
                    &GraphSkillRunState {
                        schema: GRAPH_SKILL_STATE_SCHEMA.to_owned(),
                        run_id: run_id.clone(),
                        runner_name: runner.name.clone(),
                        graph_inputs: graph_inputs.clone(),
                        checkpoint: previous_checkpoint,
                    },
                )?;
                let (request_id, request_value) = host
                    .pending_request()
                    .ok_or_else(|| invalid("graph blocked without pending request"))?;
                write_paused_graph_checkpoint(PausedGraphCheckpoint {
                    request,
                    workspace,
                    receipts,
                    manifest,
                    runner,
                    graph: &graph,
                    run_id: &run_id,
                    request_id,
                })?;
                return Ok(JsonValue::Object(needs_agent_output(
                    &run_id,
                    request_id,
                    request_value.clone(),
                )));
            }
            Err(RuntimeError::GraphBlocked { step_id, reason }) => {
                return seal_blocked_graph_skill_run(BlockedGraphSkillRun {
                    request,
                    workspace,
                    receipts,
                    manifest,
                    graph: graph.clone(),
                    checkpoint: previous_checkpoint,
                    run_id: &run_id,
                    runtime: &runtime,
                    step_id: &step_id,
                    reason_code: "graph_blocked",
                    summary: format!("graph {} blocked at {step_id}: {reason}", graph.name),
                });
            }
            Err(RuntimeError::AuthorityDenied {
                verb,
                step_id,
                reason,
            }) => {
                return seal_blocked_graph_skill_run(BlockedGraphSkillRun {
                    request,
                    workspace,
                    receipts,
                    manifest,
                    graph: graph.clone(),
                    checkpoint: previous_checkpoint,
                    run_id: &run_id,
                    runtime: &runtime,
                    step_id: &step_id,
                    reason_code: "authority_denied",
                    summary: format!(
                        "graph {} denied {verb:?} at {step_id}: {reason}",
                        graph.name
                    ),
                });
            }
            Err(error) => return Err(error.into()),
        }
    }
}

struct PausedGraphCheckpoint<'a> {
    request: &'a SkillRunRequest,
    workspace: &'a WorkspaceEnv,
    receipts: &'a ReceiptServices,
    manifest: &'a SkillRunnerManifest,
    runner: &'a SkillRunnerDefinition,
    graph: &'a ExecutionGraph,
    run_id: &'a str,
    request_id: &'a str,
}

fn write_paused_graph_checkpoint(input: PausedGraphCheckpoint<'_>) -> Result<(), SkillRunError> {
    let receipt_path =
        input
            .receipts
            .resolve_path(input.workspace, input.request.receipt_dir.as_deref(), None);
    let checkpoint = PausedRunCheckpoint {
        id: input.run_id.to_owned(),
        name: input
            .manifest
            .skill
            .clone()
            .unwrap_or_else(|| input.graph.name.clone()),
        kind: "graph".to_owned(),
        started_at: Some(crate::time::now_iso8601()),
        resume_skill_ref: Some(input.request.skill_path.to_string_lossy().into_owned()),
        selected_runner: Some(input.runner.name.clone()),
        step_ids: vec![input.request_id.to_owned()],
        step_labels: vec![input.request_id.to_owned()],
    };
    append_paused_run_checkpoint(&receipt_path.path, &checkpoint).map_err(|source| {
        RuntimeError::io(
            format!(
                "writing paused run checkpoint for {} in {}",
                checkpoint.id,
                receipt_path.path.display()
            ),
            source,
        )
    })?;
    Ok(())
}

fn missing_required_graph_input_request(
    runner: &SkillRunnerDefinition,
    graph_inputs: &JsonObject,
) -> Option<JsonValue> {
    let missing = runner
        .inputs
        .iter()
        .filter(|(_, input)| input.required)
        .filter(|(name, _)| match graph_inputs.get(name.as_str()) {
            Some(JsonValue::Null) => true,
            Some(_) => false,
            None => true,
        })
        .map(|(name, input)| {
            let mut entry = JsonObject::new();
            entry.insert("name".to_owned(), JsonValue::String(name.clone()));
            entry.insert(
                "type".to_owned(),
                JsonValue::String(input.input_type.clone()),
            );
            if let Some(description) = &input.description {
                entry.insert(
                    "description".to_owned(),
                    JsonValue::String(description.clone()),
                );
            }
            JsonValue::Object(entry)
        })
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return None;
    }

    let mut request = JsonObject::new();
    request.insert(
        "kind".to_owned(),
        JsonValue::String("graph.required_inputs".to_owned()),
    );
    request.insert("runner".to_owned(), JsonValue::String(runner.name.clone()));
    request.insert("missing_inputs".to_owned(), JsonValue::Array(missing));
    Some(JsonValue::Object(request))
}

struct BlockedGraphSkillRun<'a> {
    request: &'a SkillRunRequest,
    workspace: &'a WorkspaceEnv,
    receipts: &'a ReceiptServices,
    manifest: &'a SkillRunnerManifest,
    graph: ExecutionGraph,
    checkpoint: GraphCheckpoint,
    run_id: &'a str,
    runtime: &'a Runtime<SkillRunGraphAdapter>,
    step_id: &'a str,
    reason_code: &'a str,
    summary: String,
}

fn seal_blocked_graph_skill_run(
    context: BlockedGraphSkillRun<'_>,
) -> Result<JsonValue, SkillRunError> {
    let mut final_host = SkillRunGraphHost::new(JsonObject::new());
    let run = context.runtime.seal_blocked_graph_checkpoint_with_host(
        context.graph,
        context.checkpoint,
        context.step_id,
        context.reason_code,
        context.summary,
        &mut final_host,
    )?;
    write_graph_receipts(context.request, context.workspace, context.receipts, &run)?;
    let payload = graph_run_payload(&run, false);
    let output = graph_run_skill_output(&payload, &run)?;
    Ok(JsonValue::Object(sealed_output(
        context.manifest,
        context.run_id,
        &output,
        &payload,
        &run.receipt,
        contract_json_value(&run.receipt)?,
    )))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct GraphSkillRunState {
    pub(super) schema: String,
    pub(super) run_id: String,
    pub(super) runner_name: String,
    #[serde(default)]
    pub(super) graph_inputs: JsonObject,
    pub(super) checkpoint: GraphCheckpoint,
}

type SourceHandlerFn = fn(SkillInvocation) -> Result<SkillOutput, RuntimeError>;

#[derive(Clone, Copy, Debug)]
struct SourceHandler {
    source_type: &'static str,
    handler: SourceHandlerFn,
}

#[derive(Clone, Debug)]
struct SourceAdapterRegistry {
    handlers: Vec<SourceHandler>,
}

impl SourceAdapterRegistry {
    fn builtins() -> Self {
        Self {
            handlers: builtin_source_handlers(),
        }
    }

    fn invoke(&self, request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
        let source_type = request.source.source_type.as_str();
        let Some(handler) = self
            .handlers
            .iter()
            .find(|registered| registered.source_type == source_type)
            .map(|registered| registered.handler)
        else {
            return Err(RuntimeError::UnsupportedSource {
                source_kind: source_type.to_owned(),
            });
        };
        handler(request)
    }
}

fn builtin_source_handlers() -> Vec<SourceHandler> {
    vec![
        #[cfg(feature = "cli-tool")]
        SourceHandler {
            source_type: "cli-tool",
            handler: invoke_graph_cli_tool,
        },
        #[cfg(feature = "catalog")]
        SourceHandler {
            source_type: "catalog",
            handler: invoke_graph_catalog_tool,
        },
        #[cfg(feature = "external-adapter")]
        SourceHandler {
            source_type: "external-adapter",
            handler: invoke_graph_external_adapter,
        },
        #[cfg(feature = "http")]
        SourceHandler {
            source_type: "http",
            handler: invoke_graph_http,
        },
        #[cfg(feature = "mcp")]
        SourceHandler {
            source_type: "mcp",
            handler: invoke_graph_mcp,
        },
        #[cfg(feature = "thread-outbox-provider")]
        SourceHandler {
            source_type: "thread-outbox-provider",
            handler: invoke_graph_thread_outbox_provider,
        },
    ]
}

#[derive(Clone, Debug)]
pub(crate) struct SkillRunGraphAdapter {
    sources: SourceAdapterRegistry,
}

impl Default for SkillRunGraphAdapter {
    fn default() -> Self {
        Self {
            sources: SourceAdapterRegistry::builtins(),
        }
    }
}

impl crate::adapter::SkillAdapter for SkillRunGraphAdapter {
    fn adapter_type(&self) -> &'static str {
        "skill-run-graph"
    }

    fn invoke(&self, request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
        self.sources.invoke(request)
    }
}

#[cfg(feature = "cli-tool")]
fn invoke_graph_cli_tool(mut request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
    let credential_observation = request.credential_delivery.public_observation().cloned();
    request.credential_delivery = CredentialDelivery::none();
    let mut output = CliToolAdapter.invoke(request)?;
    if let Some(observation) = &credential_observation {
        output.record_credential_observation(observation)?;
    }
    Ok(output)
}

#[cfg(feature = "catalog")]
fn invoke_graph_catalog_tool(request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
    crate::adapters::catalog::CatalogAdapter::default().invoke(request)
}

#[cfg(feature = "external-adapter")]
fn invoke_graph_external_adapter(request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
    crate::adapters::external_adapter::ExternalAdapterSkillAdapter::default().invoke(request)
}

#[cfg(feature = "http")]
fn invoke_graph_http(request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
    crate::adapters::http::HttpSkillAdapter.invoke(request)
}

#[cfg(feature = "mcp")]
fn invoke_graph_mcp(request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
    crate::adapter::SkillAdapter::invoke(&crate::adapters::mcp::McpAdapter::default(), request)
}

#[cfg(feature = "thread-outbox-provider")]
fn invoke_graph_thread_outbox_provider(
    request: SkillInvocation,
) -> Result<SkillOutput, RuntimeError> {
    crate::adapters::thread_outbox_provider::ThreadOutboxProviderSkillAdapter::default()
        .invoke(request)
}

#[derive(Default)]
/// In-process managed-agent resolver for graph agent steps. An agent step inside
/// a graph that has no seeded answer would otherwise host-drive (yield
/// `needs_agent`); when a provider is configured this resolves it inline, exactly
/// as the top-level agent path does, so the agent step authors its result and the
/// graph's later deterministic steps (e.g. a governed http action) still run as
/// one sealed turn. With no provider configured `try_resolve` returns `None`, so
/// graphs host-drive precisely as before; behavior changes only opt-in.
struct InlineResolver {
    // Both fields feed the agent resolver path in `try_resolve` under the `agent`
    // feature; without it `try_resolve` is a no-op, so they are written at
    // construction but never read.
    #[cfg_attr(not(feature = "agent"), allow(dead_code))]
    skill_directory: PathBuf,
    #[cfg_attr(not(feature = "agent"), allow(dead_code))]
    env: BTreeMap<String, String>,
    #[cfg_attr(not(feature = "agent"), allow(dead_code))]
    credential_delivery: CredentialDelivery,
}

impl InlineResolver {
    #[cfg(feature = "agent")]
    fn try_resolve(&self, request: &ResolutionRequest) -> Result<Option<JsonValue>, RuntimeError> {
        use crate::adapters::agent::AgentResolver;
        use crate::adapters::agent_resolver::AnthropicAgentResolver;
        use crate::http::ReqwestHttpTransport;

        let fail = |message: String| RuntimeError::SkillFailed {
            skill_name: "managed-agent".to_owned(),
            message,
        };
        let config =
            match crate::config::load_managed_agent_config(&self.env, &self.skill_directory)
                .map_err(|error| fail(format!("managed agent config error: {error}")))?
            {
                Some(config) if config.provider.as_str().eq_ignore_ascii_case("anthropic") => {
                    config
                }
                _ => return Ok(None),
            };
        let transport = ReqwestHttpTransport::for_managed_agent()
            .map_err(|error| fail(format!("managed agent transport error: {error}")))?;
        let resolver = AnthropicAgentResolver::new(
            transport,
            config.api_key,
            config.model,
            self.env.clone(),
            self.skill_directory.clone(),
            self.credential_delivery.clone(),
        );
        let resolution = resolver
            .resolve(request.clone())
            .map_err(|error| fail(error.sanitized_message().to_owned()))?;
        Ok(Some(resolution.response.payload))
    }

    #[cfg(not(feature = "agent"))]
    fn try_resolve(&self, _request: &ResolutionRequest) -> Result<Option<JsonValue>, RuntimeError> {
        Ok(None)
    }
}

struct SkillRunGraphHost {
    answers: JsonObject,
    pending: Vec<(String, JsonValue)>,
    inline: Option<InlineResolver>,
}

impl SkillRunGraphHost {
    fn new(answers: JsonObject) -> Self {
        Self {
            answers,
            pending: Vec::new(),
            inline: None,
        }
    }

    fn with_inline(answers: JsonObject, inline: InlineResolver) -> Self {
        Self {
            answers,
            pending: Vec::new(),
            inline: Some(inline),
        }
    }

    fn pending_request(&self) -> Option<(&str, &JsonValue)> {
        self.pending
            .first()
            .map(|(request_id, request)| (request_id.as_str(), request))
    }
}

impl Host for SkillRunGraphHost {
    fn report(&mut self, _event: runx_contracts::ExecutionEvent) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn resolve(
        &mut self,
        request: ResolutionRequest,
    ) -> Result<Option<ResolutionResponse>, RuntimeError> {
        let request_id = resolution_request_id(&request).to_owned();
        if let Some(answer) = self.answers.get(&request_id) {
            return Ok(Some(ResolutionResponse {
                actor: ResolutionResponseActor::Agent,
                payload: answer.clone(),
            }));
        }
        // An agent step with no seeded answer runs the configured provider inline
        // rather than host-driving, so a graph turn (agent step -> governed action
        // step) completes in one pass. No provider configured -> falls through to
        // the host as before.
        if matches!(request, ResolutionRequest::AgentAct { .. }) {
            if let Some(inline) = &self.inline {
                if let Some(payload) = inline.try_resolve(&request)? {
                    return Ok(Some(ResolutionResponse {
                        actor: ResolutionResponseActor::Agent,
                        payload,
                    }));
                }
            }
        }
        let request_value = serde_json::to_value(&request)
            .and_then(serde_json::from_value)
            .map_err(|source| RuntimeError::json("serializing graph resolution request", source))?;
        self.pending.push((request_id, request_value));
        Ok(None)
    }
}

fn resolution_request_id(request: &ResolutionRequest) -> &str {
    match request {
        ResolutionRequest::Input { id, .. }
        | ResolutionRequest::Approval { id, .. }
        | ResolutionRequest::AgentAct { id, .. } => id.as_str(),
    }
}

fn graph_run_id(
    request: &SkillRunRequest,
    runner: &SkillRunnerDefinition,
) -> Result<String, SkillRunError> {
    match (&request.run_id, &request.answers_path) {
        (Some(run_id), Some(_)) => Ok(run_id.clone()),
        (Some(_), None) => Err(invalid(
            "skill continuation requires both run_id and answers",
        )),
        (None, Some(_)) => Err(invalid(
            "skill continuation requires both run_id and answers",
        )),
        (None, None) => {
            let input_bytes = serde_json::to_vec(&request.inputs).unwrap_or_default();
            let digest = sha256_hex(&input_bytes);
            Ok(format!(
                "run_{}_{}",
                identifier_segment(&runner.name),
                digest.chars().take(12).collect::<String>()
            ))
        }
    }
}

fn write_graph_receipts(
    request: &SkillRunRequest,
    workspace: &WorkspaceEnv,
    receipts: &ReceiptServices,
    run: &GraphRun,
) -> Result<(), SkillRunError> {
    for step in &run.steps {
        write_skill_receipt(request, workspace, receipts, &step.receipt)?;
    }
    write_skill_receipt(request, workspace, receipts, &run.receipt)
}

/// When a graph runner declares an `act:` block, seal the turn's primary receipt
/// as its domain act: the reason comes from the agent voice step's output, the
/// effect from the deterministic action step's real `/v1` response, and the
/// structure/authority from the declared `act:` block plus the trusted graph
/// inputs. The graph's per-step receipts remain as the execution trace; this
/// standalone domain receipt is what the turn presents and what chains by
/// lineage. Transport (the http step, status, token) never enters it.
// rust-style-allow: long-function - assembling the domain-act receipt is one frame
// build/mint/seal sequence; splitting it would separate the authority mint from the
// frame it seals into.
pub(crate) fn graph_domain_act_receipt(
    runner: &SkillRunnerDefinition,
    graph_inputs: &JsonObject,
    run: &GraphRun,
    run_id: &str,
    created_at: &str,
    signature_config: &RuntimeReceiptSignatureConfig,
) -> Result<Option<runx_contracts::Receipt>, SkillRunError> {
    let Some(act) = runner.source.act.as_ref() else {
        return Ok(None);
    };
    let step_output = |step_id: Option<&str>| {
        step_id.and_then(|id| run.steps.iter().find(|step| step.step_id == id))
    };
    // Reason: the agent voice step's structured output (e.g. {line: "..."}).
    let reason_source = step_output(act.reason_step.as_deref())
        .map(|step| JsonValue::Object(step.outputs.clone()))
        .unwrap_or(JsonValue::Null);
    // Effect: the action step's real /v1 response body.
    let governed_effect = step_output(act.effect_step.as_deref())
        .filter(|step| step.output.succeeded())
        .and_then(|step| serde_json::from_str::<JsonValue>(step.output.stdout.trim()).ok());
    let authority_grant_refs = graph_credential_grant_refs(run);
    let Some(mut frame) = build_domain_act_frame(
        act,
        graph_inputs,
        &reason_source,
        governed_effect.as_ref(),
        authority_grant_refs,
    ) else {
        return Ok(None);
    };
    for reference in run
        .steps
        .iter()
        .flat_map(|step| step.receipt.acts.iter())
        .flat_map(|receipt_act| receipt_act.artifact_refs.iter())
        .filter(|reference| reference.uri.as_str().contains("operator_context"))
    {
        if !frame
            .artifact_refs
            .iter()
            .any(|existing| existing.uri == reference.uri)
        {
            frame.artifact_refs.push(reference.clone());
        }
    }
    // Compute path: when the act declares `mint_authority`, the runtime mints the
    // child term and proves the subset against the graph charter off the model
    // path, overriding the (empty, since the parser holds them mutually exclusive)
    // pre-built attenuation fields. Fail-loud: a request exceeding the charter
    // fails the turn rather than sealing a false or missing attenuation.
    if let Some((terms, attenuation)) = mint_charter_attenuation(
        act,
        runner
            .source
            .graph
            .as_ref()
            .and_then(|graph| graph.charter_from.as_deref()),
        graph_inputs,
        created_at,
    )? {
        frame.authority_terms = terms;
        frame.authority_attenuation = Some(attenuation);
    }
    let graph_name = identifier_segment(run_id);
    let verification_metadata = step_output(act.reason_step.as_deref())
        .map(|step| step.output.metadata.clone())
        .unwrap_or_default();
    let receipt = domain_act_receipt(DomainActReceiptRequest {
        graph_name: &graph_name,
        step_id: "turn",
        succeeded: run.state.status == GraphStatus::Succeeded,
        created_at,
        disposition: ClosureDisposition::Closed,
        reason_code: "agent_act_closed".to_owned(),
        seal_summary: "governed graph turn sealed".to_owned(),
        frame,
        verification_metadata,
        signature_policy: signature_config.signature_policy(),
    })?;
    Ok(Some(receipt))
}

/// Mint the charter -> member attenuation for a graph turn that declares
/// `mint_authority`. The parent charter is the AuthorityTerm carried by the graph
/// runner's `charter_from` input; the requested narrowing is the AttenuationRequest
/// carried by `requested_scope_from`. The child term and subset proof are computed
/// and verified by the core mint primitive, so the runtime never trusts a pre-built
/// proof here and a request exceeding the charter fails the turn loudly.
// rust-style-allow: long-function - minting is one linear resolve-charter,
// build-request, mint-and-prove sequence on the trust boundary; splitting it would
// separate the charter from the proof that bounds it.
pub(crate) fn mint_charter_attenuation(
    act: &runx_parser::ActDeclaration,
    charter_key: Option<&str>,
    graph_inputs: &JsonObject,
    created_at: &str,
) -> Result<
    Option<(
        Vec<runx_contracts::AuthorityTerm>,
        runx_contracts::AuthorityAttenuation,
    )>,
    SkillRunError,
> {
    use runx_core::policy::{AttenuationRequest, ScopeBoundsComparator, mint_attenuated};
    use runx_parser::MintScopeSource;

    let Some(directive) = act.mint_authority.as_ref() else {
        return Ok(None);
    };
    let charter_key = charter_key.ok_or_else(|| {
        invalid("mint_authority requires the graph runner to declare charter_from")
    })?;
    let charter: runx_contracts::AuthorityTerm = decode_graph_input(graph_inputs, charter_key)
        .ok_or_else(|| {
            invalid(format!(
                "mint_authority charter input '{charter_key}' did not resolve to an authority term"
            ))
        })?;
    let request: AttenuationRequest = match directive.source {
        MintScopeSource::RequestedScope => {
            let key = act.requested_scope_from.as_deref().ok_or_else(|| {
                invalid("mint_authority requested_scope requires requested_scope_from")
            })?;
            decode_graph_input(graph_inputs, key).ok_or_else(|| {
                invalid(format!(
                    "mint_authority requested_scope input '{key}' did not resolve to an attenuation request"
                ))
            })?
        }
        MintScopeSource::StaticScopes => {
            return Err(invalid(
                "mint_authority source static_scopes is not yet wired in the runtime; use requested_scope",
            ));
        }
    };
    let (child, proof) = mint_attenuated(
        &charter,
        &request,
        &ScopeBoundsComparator,
        created_at.into(),
    )
    .map_err(|error| {
        invalid(format!(
            "mint_authority requested child is not a subset of the charter ({error:?})"
        ))
    })?;
    let attenuation = runx_contracts::AuthorityAttenuation {
        parent_authority_ref: Some(proof.parent_authority_ref.clone()),
        subset_proof: Some(proof),
    };
    Ok(Some((vec![child], attenuation)))
}

/// Decode a trusted graph input value into a typed contract struct.
pub(crate) fn decode_graph_input<T: serde::de::DeserializeOwned>(
    inputs: &JsonObject,
    key: &str,
) -> Option<T> {
    inputs
        .get(key)
        .and_then(|value| serde_json::to_value(value).ok())
        .and_then(|value| serde_json::from_value(value).ok())
}

/// Gather the credential grant refs the turn actually held, read from the
/// `Credential` verification refs sealed on each step receipt. These become the
/// domain act's `authority.grant_refs`, so the receipt records the authority it
/// carried, not only the declared scope.
pub(crate) fn graph_credential_grant_refs(run: &GraphRun) -> Vec<runx_contracts::Reference> {
    let mut refs: Vec<runx_contracts::Reference> = Vec::new();
    for step in &run.steps {
        for act in &step.receipt.acts {
            for binding in &act.criterion_bindings {
                for reference in &binding.verification_refs {
                    if reference.reference_type == runx_contracts::ReferenceType::Credential
                        && !refs.contains(reference)
                    {
                        refs.push(reference.clone());
                    }
                }
            }
        }
    }
    refs
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use runx_parser::{SkillSource, SourceKind};

    use super::*;
    use crate::adapter::SkillAdapter;

    #[test]
    fn mint_authority_seals_a_subset_proven_child() -> Result<(), SkillRunError> {
        use runx_contracts::{
            AuthorityBounds, AuthorityResourceFamily, AuthorityTerm, AuthorityVerb, Reference,
            ReferenceType,
        };
        use runx_core::policy::{AttenuationRequest, ensure_subset_proof};

        // Deterministic fixture instant for the minted child's `granted_at`; the
        // test asserts on the subset proof, not the timestamp.
        let created_at = "2026-05-18T00:00:00Z";

        let principal = Reference::with_uri(ReferenceType::Principal, "runx:principal:agency");
        let member = Reference::with_uri(ReferenceType::Principal, "runx:principal:writer");
        let resource = Reference::with_uri(ReferenceType::Repository, "runx:repository:docs");
        let bounds = AuthorityBounds {
            filesystem_roots: vec!["/repo".into()],
            ..AuthorityBounds::default()
        };
        let charter = AuthorityTerm {
            term_id: "charter".into(),
            principal_ref: principal.clone(),
            resource_ref: resource.clone(),
            resource_family: AuthorityResourceFamily::Workspace,
            verbs: vec![AuthorityVerb::Read, AuthorityVerb::Write],
            bounds: bounds.clone(),
            conditions: Vec::new(),
            approvals: Vec::new(),
            capabilities: Vec::new(),
            expires_at: None,
            issued_by_ref: principal,
            credential_ref: None,
        };
        let make_request = |verbs: Vec<AuthorityVerb>| AttenuationRequest {
            principal_ref: member.clone(),
            resource_ref: resource.clone(),
            resource_family: AuthorityResourceFamily::Workspace,
            verbs,
            capabilities: Vec::new(),
            bounds: bounds.clone(),
            expires_at: None,
        };

        let act: runx_parser::ActDeclaration = serde_json::from_value(serde_json::json!({
            "mint_authority": {"source": "requested_scope"},
            "requested_scope_from": "requested"
        }))
        .map_err(|error| invalid(format!("act fixture: {error}")))?;

        // Valid narrowing: a read-only child of a read+write charter, same resource.
        let mut inputs = JsonObject::new();
        inputs.insert("charter".to_owned(), contract_json_value(&charter)?);
        inputs.insert(
            "requested".to_owned(),
            contract_json_value(&make_request(vec![AuthorityVerb::Read]))?,
        );
        let (terms, attenuation) =
            mint_charter_attenuation(&act, Some("charter"), &inputs, created_at)?
                .ok_or_else(|| invalid("expected minted attenuation"))?;
        assert_eq!(terms.len(), 1, "exactly one minted child term");
        let proof = attenuation
            .subset_proof
            .as_ref()
            .ok_or_else(|| invalid("minted attenuation must carry a subset proof"))?;
        // The receipt verifier accepts the computed proof.
        ensure_subset_proof(Some(proof), &terms[0], &charter)
            .map_err(|error| invalid(format!("verifier rejected minted proof: {error:?}")))?;

        // Fail-closed: widening verbs beyond the charter errors and seals nothing.
        let mut widen = JsonObject::new();
        widen.insert("charter".to_owned(), contract_json_value(&charter)?);
        widen.insert(
            "requested".to_owned(),
            contract_json_value(&make_request(vec![
                AuthorityVerb::Read,
                AuthorityVerb::Delete,
            ]))?,
        );
        assert!(
            mint_charter_attenuation(&act, Some("charter"), &widen, created_at,).is_err(),
            "a request that widens beyond the charter must fail closed"
        );

        // Fail-closed: an unresolved charter input errors rather than sealing a root.
        assert!(
            mint_charter_attenuation(&act, Some("absent"), &inputs, created_at,).is_err(),
            "an unresolved charter must fail closed"
        );

        Ok(())
    }

    #[test]
    fn graph_source_registry_fails_closed_on_unregistered_source() {
        let mut raw = JsonObject::new();
        raw.insert("type".to_owned(), JsonValue::String("a2a".to_owned()));
        let invocation = SkillInvocation {
            skill_name: "fixture-a2a".to_owned(),
            source: SkillSource {
                act: None,
                source_type: SourceKind::A2a,
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
                agent: None,
                task: None,
                hook: None,
                outputs: None,
                graph: None,
                http: None,
                raw,
            },
            inputs: JsonObject::new(),
            resolved_inputs: JsonObject::new(),
            current_context: Vec::new(),
            skill_directory: PathBuf::from("."),
            env: BTreeMap::new(),
            credential_delivery: crate::credentials::CredentialDelivery::none(),
        };

        let result = SkillRunGraphAdapter::default().invoke(invocation);
        assert!(
            matches!(
                &result,
                Err(RuntimeError::UnsupportedSource { source_kind }) if source_kind == "a2a"
            ),
            "unexpected unregistered graph source result: {result:?}"
        );
    }

    #[cfg(feature = "cli-tool")]
    #[test]
    fn graph_cli_tool_receipt_binds_credential_observation_without_secret_delivery()
    -> Result<(), Box<dyn std::error::Error>> {
        let secret = "credential-secret-must-not-cross-cli-boundary";
        let delivery = crate::credentials::CredentialDelivery::from_local_descriptor(
            "twitter",
            "oauth1_user",
            "TWITTER_TOKEN",
            "ref:twitter:primary",
            vec!["twitter:read".to_owned()],
            secret,
        )?;
        let invocation = SkillInvocation {
            skill_name: "credential-observation".to_owned(),
            source: SkillSource {
                act: None,
                source_type: SourceKind::CliTool,
                command: Some("/bin/sh".to_owned()),
                args: vec!["-c".to_owned(), "true".to_owned()],
                cwd: None,
                timeout_seconds: Some(5),
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
                outputs: None,
                graph: None,
                http: None,
                raw: JsonObject::new(),
            },
            inputs: JsonObject::new(),
            resolved_inputs: JsonObject::new(),
            current_context: Vec::new(),
            skill_directory: std::env::current_dir()?,
            env: std::env::vars().collect(),
            credential_delivery: delivery,
        };

        let output = invoke_graph_cli_tool(invocation)?;

        assert!(output.succeeded());
        let metadata = serde_json::to_string(&output.metadata)?;
        assert!(metadata.contains("credential_delivery_observations"));
        assert!(metadata.contains("runx:credential:local:"));
        assert!(!metadata.contains(secret));

        let receipt = crate::receipts::step_receipt(
            "credential_graph",
            "credential_cli",
            1,
            &output,
            "2026-07-15T00:00:00Z",
        )?;
        assert!(
            receipt.seal.criteria[0]
                .verification_refs
                .iter()
                .any(|reference| {
                    reference.reference_type == runx_contracts::ReferenceType::Credential
                })
        );
        Ok(())
    }

    #[cfg(feature = "external-adapter")]
    #[test]
    fn graph_source_registry_routes_external_adapter() {
        let mut raw = JsonObject::new();
        raw.insert(
            "type".to_owned(),
            JsonValue::String("external-adapter".to_owned()),
        );
        let invocation = SkillInvocation {
            skill_name: "fixture-external".to_owned(),
            source: SkillSource {
                act: None,
                source_type: SourceKind::ExternalAdapter,
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
                agent: None,
                task: None,
                hook: None,
                outputs: None,
                graph: None,
                http: None,
                raw,
            },
            inputs: JsonObject::new(),
            resolved_inputs: JsonObject::new(),
            current_context: Vec::new(),
            skill_directory: PathBuf::from("."),
            env: BTreeMap::new(),
            credential_delivery: crate::credentials::CredentialDelivery::none(),
        };

        let result = SkillRunGraphAdapter::default().invoke(invocation);
        assert!(
            matches!(&result, Err(RuntimeError::SkillFailed { .. })),
            "external-adapter source should route to the external adapter and fail on the \
             missing manifest, not fall through as UnsupportedSource; got: {result:?}"
        );
    }

    #[cfg(feature = "thread-outbox-provider")]
    #[test]
    fn graph_source_registry_routes_thread_outbox_provider() {
        let mut raw = JsonObject::new();
        raw.insert(
            "type".to_owned(),
            JsonValue::String("thread-outbox-provider".to_owned()),
        );
        let invocation = SkillInvocation {
            skill_name: "fixture-thread-outbox-provider".to_owned(),
            source: SkillSource {
                act: None,
                source_type: SourceKind::ThreadOutboxProvider,
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
                agent: None,
                task: None,
                hook: None,
                outputs: None,
                graph: None,
                http: None,
                raw,
            },
            inputs: JsonObject::new(),
            resolved_inputs: JsonObject::new(),
            current_context: Vec::new(),
            skill_directory: PathBuf::from("."),
            env: BTreeMap::new(),
            credential_delivery: crate::credentials::CredentialDelivery::none(),
        };

        let result = SkillRunGraphAdapter::default().invoke(invocation);
        assert!(
            matches!(&result, Err(RuntimeError::SkillFailed { .. })),
            "thread-outbox-provider source should route to the Rust provider front and fail on \
             missing config, not fall through as UnsupportedSource; got: {result:?}"
        );
    }
}

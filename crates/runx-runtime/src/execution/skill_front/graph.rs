use super::*;

use std::path::PathBuf;

use runx_contracts::{
    JsonObject, JsonValue, ResolutionRequest, ResolutionResponse, ResolutionResponseActor,
    sha256_hex,
};
use runx_core::state_machine::GraphStatus;
use runx_parser::{ExecutionGraph, SkillRunnerDefinition, SkillRunnerManifest};
use serde::{Deserialize, Serialize};

use crate::RuntimeError;
#[cfg(any(
    feature = "cli-tool",
    feature = "http",
    feature = "thread-outbox-provider"
))]
use crate::adapter::SkillAdapter;
use crate::adapter::{InvocationStatus, SkillInvocation, SkillOutput};
#[cfg(feature = "cli-tool")]
use crate::adapters::cli_tool::CliToolAdapter;
use crate::credentials::CredentialDelivery;
use crate::effects::RuntimeEffectRegistry;
use crate::execution::graph::materialize_graph_inputs;
use crate::execution::orchestrator::SkillRunRequest;
use crate::execution::runner::{
    GraphCheckpoint, GraphRun, RUNX_RUN_ID_ENV, Runtime, RuntimeOptions,
};
use crate::host::Host;
use crate::receipts::{RuntimeReceiptSignatureConfig, domain_act_receipt};
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
    let graph_inputs = request
        .inputs
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<JsonObject>();
    let graph = materialize_graph_inputs(graph, &graph_inputs);
    let run_id = graph_run_id(request, runner)?;
    let skill_dir = resolve_skill_dir(&request.skill_path)?;
    let mut env = workspace.graph_env_for_skill(&skill_dir);
    env.insert(RUNX_RUN_ID_ENV.to_owned(), run_id.clone());
    let credential_delivery =
        credential_delivery_from_invocation(workspace.env(), request.local_credential.as_ref())?;
    let inline_resolver = InlineResolver {
        skill_directory: skill_dir.clone(),
        credential_delivery: credential_delivery.clone(),
    };
    let runtime = Runtime::new(
        SkillRunGraphAdapter::default(),
        RuntimeOptions {
            created_at: crate::time::now_iso8601(),
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
    let mut host = SkillRunGraphHost::with_inline(answers, inline_resolver);
    let mut checkpoint = if resume {
        read_graph_state(request, workspace, receipts, &run_id, &runner.name)?.checkpoint
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
                    let payload = graph_payload(&run)?;
                    // A graph that declares an `act:` block seals a clean domain-act
                    // receipt as its primary receipt; the step receipts above remain
                    // as its execution trace.
                    let domain = graph_domain_act_receipt(
                        runner,
                        &graph_inputs,
                        &run,
                        &run_id,
                        receipts.signature_config(),
                    )?;
                    if let Some(domain_receipt) = &domain {
                        write_skill_receipt(request, workspace, receipts, domain_receipt)?;
                    }
                    let receipt = domain.as_ref().unwrap_or(&run.receipt);
                    let output = graph_skill_output(&payload, &run)?;
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
                        checkpoint: previous_checkpoint,
                    },
                )?;
                let (request_id, request_value) = host
                    .pending_request()
                    .ok_or_else(|| invalid("graph blocked without pending request"))?;
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
    let payload = graph_payload(&run)?;
    let output = graph_skill_output(&payload, &run)?;
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
fn invoke_graph_cli_tool(request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
    CliToolAdapter.invoke(request)
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
    skill_directory: PathBuf,
    credential_delivery: CredentialDelivery,
}

impl InlineResolver {
    #[cfg(feature = "agent")]
    fn try_resolve(&self, request: &ResolutionRequest) -> Result<Option<JsonValue>, RuntimeError> {
        use crate::adapters::agent::AgentResolver;
        use crate::adapters::agent_resolver::AnthropicAgentResolver;
        use crate::runtime_http::ReqwestHttpTransport;

        let fail = |message: String| RuntimeError::SkillFailed {
            skill_name: "managed-agent".to_owned(),
            message,
        };
        // The same process-env snapshot the rest of the runtime reads, so the
        // inline graph agent path resolves the provider exactly like the
        // top-level agent path rather than reaching for raw `std::env`.
        let env = crate::services::process_env_snapshot();
        let config = match crate::config::load_managed_agent_config(&env, &self.skill_directory)
            .map_err(|error| fail(format!("managed agent config error: {error}")))?
        {
            Some(config) if config.provider.as_str().eq_ignore_ascii_case("anthropic") => config,
            _ => return Ok(None),
        };
        let transport =
            ReqwestHttpTransport::new().map_err(|error| fail(format!("managed agent transport error: {error}")))?;
        let resolver = AnthropicAgentResolver::new(
            transport,
            config.api_key,
            config.model,
            env,
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
        (Some(_), None) => Err(invalid("runx skill --run-id requires --answers")),
        (None, Some(_)) => Err(invalid("runx skill --answers requires --run-id")),
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

fn graph_payload(run: &GraphRun) -> Result<JsonValue, SkillRunError> {
    let mut payload = JsonObject::new();
    payload.insert(
        "graph".to_owned(),
        JsonValue::String(run.graph.name.clone()),
    );
    payload.insert(
        "graph_status".to_owned(),
        JsonValue::String(format!("{:?}", run.state.status)),
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
    Ok(JsonValue::Object(payload))
}

fn graph_skill_output(payload: &JsonValue, run: &GraphRun) -> Result<SkillOutput, SkillRunError> {
    let stdout = serde_json::to_string(payload)
        .map_err(|source| RuntimeError::json("serializing graph payload", source))?;
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
fn graph_domain_act_receipt(
    runner: &SkillRunnerDefinition,
    graph_inputs: &JsonObject,
    run: &GraphRun,
    run_id: &str,
    signature_config: &RuntimeReceiptSignatureConfig,
) -> Result<Option<runx_contracts::Receipt>, SkillRunError> {
    let Some(act) = runner.source.act_declaration() else {
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
    let Some(frame) = build_domain_act_frame(
        &act,
        graph_inputs,
        &reason_source,
        governed_effect.as_ref(),
        authority_grant_refs,
    ) else {
        return Ok(None);
    };
    let receipt = domain_act_receipt(
        &identifier_segment(run_id),
        "turn",
        run.state.status == GraphStatus::Succeeded,
        &crate::time::now_iso8601(),
        ClosureDisposition::Closed,
        "agent_act_closed".to_owned(),
        "governed graph turn sealed".to_owned(),
        frame,
        signature_config.signature_policy(),
    )?;
    Ok(Some(receipt))
}

/// Gather the credential grant refs the turn actually held, read from the
/// `Credential` verification refs sealed on each step receipt. These become the
/// domain act's `authority.grant_refs`, so the receipt records the authority it
/// carried, not only the declared scope.
fn graph_credential_grant_refs(run: &GraphRun) -> Vec<runx_contracts::Reference> {
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
    fn graph_source_registry_fails_closed_on_unregistered_source() {
        let mut raw = JsonObject::new();
        raw.insert("type".to_owned(), JsonValue::String("a2a".to_owned()));
        let invocation = SkillInvocation {
            skill_name: "fixture-a2a".to_owned(),
            source: SkillSource {
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

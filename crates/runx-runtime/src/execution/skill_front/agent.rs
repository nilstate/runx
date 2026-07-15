use super::{
    SkillRunError, SkillRunOverrides, agent_invocation_source_type, agent_request,
    answer_disposition, contract_json_value, domain_act_frame, identifier_segment, invalid,
    needs_agent_output, read_answer, seal_skill_answer, sealed_output,
};

use runx_contracts::{ClosureDisposition, JsonObject, JsonValue};

use crate::RuntimeError;
use crate::adapter::{InvocationStatus, SkillInvocation, SkillOutput};
use crate::agent_contract::verified_agent_metadata_with_artifacts;
use crate::agent_invocation::agent_act_invocation_id;
use crate::execution::orchestrator::SkillRunRequest;
use crate::journal::{PausedRunCheckpoint, append_paused_run_checkpoint};
use crate::receipts::{DomainActReceiptRequest, domain_act_receipt};
use crate::services::{ReceiptServices, WorkspaceEnv};
use runx_parser::{SkillRunnerDefinition, SkillRunnerManifest};

use super::runner_manifest::write_skill_receipt;

// rust-style-allow: long-function - one agent-front transaction resolves the
// answer source, seals either a domain act or generic answer, and emits the
// public skill output envelope.
pub(super) fn execute_agent_skill_run(
    request: &SkillRunRequest,
    overrides: &SkillRunOverrides,
    workspace: &WorkspaceEnv,
    receipts: &ReceiptServices,
    manifest: &SkillRunnerManifest,
    runner: &SkillRunnerDefinition,
    invocation: SkillInvocation,
) -> Result<JsonValue, SkillRunError> {
    let source_type = agent_invocation_source_type(runner.source.source_type.as_str())?;
    let request_id = agent_act_invocation_id(&invocation, source_type);
    let run_id = agent_run_id(request, &request_id)?;
    let resolution_request = agent_request(&invocation, source_type)?;

    // Seeded answers (inline, single pass) take priority over the file-based
    // resume channel; absent both, the run yields to the public agent loop.
    let seeded_answer = overrides
        .seeded_answers
        .as_ref()
        .and_then(|answers| answers.get(&request_id).cloned());
    let (answer, governed_effect): (JsonValue, Option<JsonValue>) = match seeded_answer {
        Some(answer) => (answer, None),
        None => match &request.answers_path {
            Some(answers_path) => (read_answer(answers_path, &request_id)?, None),
            None => match try_inline_agent_resolution(&invocation)? {
                #[cfg(feature = "agent")]
                InlineAgentOutcome::Resolved { payload, effect } => (payload, effect),
                InlineAgentOutcome::HostDrives => {
                    write_paused_agent_checkpoint(
                        request,
                        workspace,
                        receipts,
                        manifest,
                        runner,
                        &run_id,
                        &request_id,
                    )?;
                    return Ok(JsonValue::Object(needs_agent_output(
                        &run_id,
                        &request_id,
                        contract_json_value(&resolution_request)?,
                    )));
                }
            },
        },
    };
    let verification_metadata = verified_agent_metadata_with_artifacts(
        &resolution_request,
        &answer,
        runner.artifacts.as_ref(),
        None,
        &invocation.skill_directory,
        workspace.env(),
    )?;
    let stdout = serde_json::to_string(&answer)
        .map_err(|error| SkillRunError::Invalid(format!("failed to serialize answer: {error}")))?;
    let disposition = answer_disposition(&answer)?;
    let receipt = match domain_act_frame(&invocation, &answer, governed_effect.as_ref()) {
        Some(mut frame) => {
            frame.artifact_refs.extend(
                crate::execution::prepared_skill::prepared_receipt_references(workspace.env()),
            );
            let label = disposition.label();
            let created_at = crate::time::now_iso8601();
            let graph_name = identifier_segment(&run_id);
            let step_id = identifier_segment(&runner.name);
            domain_act_receipt(DomainActReceiptRequest {
                graph_name: &graph_name,
                step_id: &step_id,
                succeeded: disposition == ClosureDisposition::Closed,
                created_at: &created_at,
                disposition,
                reason_code: format!("agent_act_{label}"),
                seal_summary: format!("agent act sealed ({label})"),
                frame,
                verification_metadata: verification_metadata.clone(),
                signature_policy: receipts.signature_config().signature_policy(),
            })?
        }
        None => seal_skill_answer(
            &run_id,
            runner,
            &stdout,
            disposition,
            receipts.signature_config(),
            workspace.env(),
            verification_metadata.clone(),
        )?,
    };
    write_skill_receipt(request, workspace, receipts, &receipt)?;

    Ok(JsonValue::Object(sealed_output(
        manifest,
        &run_id,
        &agent_skill_output(stdout, &receipt, verification_metadata),
        &answer,
        &receipt,
        contract_json_value(&receipt)?,
    )))
}

fn write_paused_agent_checkpoint(
    request: &SkillRunRequest,
    workspace: &WorkspaceEnv,
    receipts: &ReceiptServices,
    manifest: &SkillRunnerManifest,
    runner: &SkillRunnerDefinition,
    run_id: &str,
    request_id: &str,
) -> Result<(), SkillRunError> {
    let receipt_path = receipts.resolve_path(workspace, request.receipt_dir.as_deref(), None);
    let checkpoint = PausedRunCheckpoint {
        id: run_id.to_owned(),
        name: manifest
            .skill
            .clone()
            .unwrap_or_else(|| runner.name.clone()),
        kind: "agent".to_owned(),
        started_at: Some(crate::time::now_iso8601()),
        resume_skill_ref: Some(request.skill_path.to_string_lossy().into_owned()),
        selected_runner: Some(runner.name.clone()),
        step_ids: vec![request_id.to_owned()],
        step_labels: vec![runner.name.clone()],
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

/// Outcome of attempting the optional in-process managed-agent loop.
enum InlineAgentOutcome {
    /// The in-kernel loop ran and produced the agent answer payload, plus the last
    /// successful governed tool result (the real effect) for the domain receipt.
    #[cfg(feature = "agent")]
    Resolved {
        payload: JsonValue,
        effect: Option<JsonValue>,
    },
    /// No in-process provider is configured; yield to the host loop.
    HostDrives,
}

/// Optionally run the managed-agent loop in-process. This is opt-in: only when a
/// managed-agent provider (currently Anthropic) is configured does the runtime
/// drive the agent itself; otherwise it yields to the host (`needs_agent`), the
/// default shipped behavior. Per-call governance and receipt sealing are the same
/// either way; the loop only adds the bounded autonomous run.
#[cfg(feature = "agent")]
fn try_inline_agent_resolution(
    invocation: &SkillInvocation,
) -> Result<InlineAgentOutcome, SkillRunError> {
    use crate::adapters::agent::{
        AgentAdapterSourceType, AgentResolver, build_managed_agent_act_invocation,
    };
    use crate::adapters::agent_resolver::AnthropicAgentResolver;
    use crate::http::ReqwestHttpTransport;
    use runx_contracts::ResolutionRequest;

    let source_type = if invocation.source.source_type == runx_parser::SourceKind::Agent {
        AgentAdapterSourceType::Agent
    } else if invocation.source.source_type == runx_parser::SourceKind::AgentStep {
        AgentAdapterSourceType::AgentStep
    } else {
        return Ok(InlineAgentOutcome::HostDrives);
    };

    let config = match crate::config::load_managed_agent_config(
        &invocation.env,
        &invocation.skill_directory,
    )
    .map_err(|error| SkillRunError::Invalid(format!("managed agent config error: {error}")))?
    {
        Some(config) if config.provider.as_str().eq_ignore_ascii_case("anthropic") => config,
        _ => return Ok(InlineAgentOutcome::HostDrives),
    };

    let agent_act = build_managed_agent_act_invocation(invocation, source_type)?;
    let request = ResolutionRequest::AgentAct {
        id: agent_act.id.clone(),
        invocation: Box::new(agent_act),
    };
    let transport = ReqwestHttpTransport::for_managed_agent().map_err(|error| {
        SkillRunError::Invalid(format!("managed agent transport error: {error}"))
    })?;
    let resolver = AnthropicAgentResolver::new(
        transport,
        config.api_key,
        config.model,
        invocation.env.clone(),
        invocation.skill_directory.clone(),
        invocation.credential_delivery.clone(),
    );
    let resolution = resolver
        .resolve(request)
        .map_err(|error| SkillRunError::Invalid(error.sanitized_message().to_owned()))?;
    Ok(InlineAgentOutcome::Resolved {
        payload: resolution.response.payload,
        effect: resolution.governed_effect,
    })
}

#[cfg(not(feature = "agent"))]
fn try_inline_agent_resolution(
    _invocation: &SkillInvocation,
) -> Result<InlineAgentOutcome, SkillRunError> {
    Ok(InlineAgentOutcome::HostDrives)
}

fn agent_run_id(request: &SkillRunRequest, request_id: &str) -> Result<String, SkillRunError> {
    match (&request.run_id, &request.answers_path) {
        (Some(run_id), Some(_)) => Ok(run_id.clone()),
        (Some(_), None) => Err(invalid(
            "skill continuation requires both run_id and answers",
        )),
        (None, Some(_)) => Err(invalid(
            "skill continuation requires both run_id and answers",
        )),
        (None, None) => Ok(format!("run_{}", identifier_segment(request_id))),
    }
}

fn agent_skill_output(
    stdout: String,
    receipt: &runx_contracts::Receipt,
    verification_metadata: JsonObject,
) -> SkillOutput {
    let succeeded = receipt.seal.disposition == ClosureDisposition::Closed;
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
            format!("agent act closed with {}", receipt.seal.disposition.label())
        },
        exit_code: succeeded.then_some(0),
        duration_ms: 0,
        metadata: verification_metadata,
    }
}

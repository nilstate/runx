use super::*;

use runx_contracts::ClosureDisposition;

use crate::adapter::{InvocationStatus, SkillInvocation, SkillOutput};
use crate::agent_invocation::agent_act_invocation_id;
use crate::execution::orchestrator::SkillRunRequest;
use crate::receipts::domain_act_receipt;
use crate::services::{ReceiptServices, WorkspaceEnv};
use runx_parser::{SkillRunnerDefinition, SkillRunnerManifest};

use super::runner_manifest::write_skill_receipt;

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
                    return Ok(JsonValue::Object(needs_agent_output(
                        &run_id,
                        &request_id,
                        resolution_request,
                    )));
                }
            },
        },
    };
    let stdout = serde_json::to_string(&answer)
        .map_err(|error| SkillRunError::Invalid(format!("failed to serialize answer: {error}")))?;
    let disposition = answer_disposition(&answer);
    let receipt = match domain_act_frame(&invocation, &answer, governed_effect.as_ref()) {
        Some(frame) => {
            let label = closure_disposition_label(&disposition);
            domain_act_receipt(
                &identifier_segment(&run_id),
                &identifier_segment(&runner.name),
                disposition == ClosureDisposition::Closed,
                &crate::time::now_iso8601(),
                disposition,
                format!("agent_act_{label}"),
                format!("agent act sealed ({label})"),
                frame,
                receipts.signature_config().signature_policy(),
            )?
        }
        None => seal_skill_answer(&run_id, runner, &stdout, disposition, receipts.signature_config())?,
    };
    write_skill_receipt(request, workspace, receipts, &receipt)?;

    Ok(JsonValue::Object(sealed_output(
        manifest,
        &run_id,
        &agent_skill_output(stdout, &receipt),
        &answer,
        &receipt,
        contract_json_value(&receipt)?,
    )))
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
    use crate::runtime_http::ReqwestHttpTransport;
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
    let transport = ReqwestHttpTransport::new().map_err(|error| {
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
        (Some(_), None) => Err(invalid("runx skill --run-id requires --answers")),
        (None, Some(_)) => Err(invalid("runx skill --answers requires --run-id")),
        (None, None) => Ok(format!("run_{}", identifier_segment(request_id))),
    }
}

fn agent_skill_output(stdout: String, receipt: &runx_contracts::Receipt) -> SkillOutput {
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
            format!(
                "agent act closed with {}",
                closure_disposition_label(&receipt.seal.disposition)
            )
        },
        exit_code: succeeded.then_some(0),
        duration_ms: 0,
        metadata: JsonObject::new(),
    }
}

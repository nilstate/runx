use std::fs;
use std::path::Path;

use runx_contracts::{ClosureDisposition, JsonNumber, JsonObject, JsonValue};
use runx_parser::{SkillRunnerDefinition, SkillRunnerManifest};
use serde::Serialize;
use thiserror::Error;

use crate::RuntimeError;
use crate::adapter::{InvocationStatus, SkillInvocation, SkillOutput};
use crate::agent_invocation::{AgentActInvocationSourceType, agent_act_resolution_request};
use crate::effects::RuntimeEffectRegistry;
use crate::execution::orchestrator::SkillRunRequest;
use crate::receipts::signing::strip_receipt_signing_env;
use crate::receipts::store::ReceiptStoreError;
use crate::execution::output_projection::project_step_output;
use crate::receipts::{
    DomainActFrame, RuntimeReceiptSignatureConfig, StepSeal, StepSealClosure, seal_step,
};
use crate::services::{ReceiptServices, WorkspaceEnv};

mod agent;
mod graph;
mod graph_state;
mod inline_harness;
mod runner_manifest;

#[cfg(feature = "cli-tool")]
pub(crate) use self::graph::SkillRunGraphAdapter;
pub(crate) use self::inline_harness::run_inline_harness_with_effects;

use self::agent::execute_agent_skill_run;
use self::graph::execute_graph_skill_run;
use self::runner_manifest::{
    execute_cli_tool_skill_run, load_runner_manifest, resolve_skill_dir, runner_invocation,
    selected_runner,
};

const SKILL_RUN_SCHEMA: &str = "runx.skill_run.v1";
const GRAPH_SKILL_STATE_SCHEMA: &str = "runx.graph_skill_state.v1";

#[derive(Debug, Error)]
pub enum SkillRunError {
    #[error("skill run failed: {0}")]
    Invalid(String),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    #[error(transparent)]
    ReceiptStore(#[from] ReceiptStoreError),
}

/// Optional, non-default knobs for a single skill run.
///
/// `execute_skill_run` keeps today's behavior (default runner, file-based
/// answers). The inline harness needs two extra capabilities without touching
/// the 35+ `SkillRunRequest` construction sites: select a named runner, and
/// seed answers inline for a single fresh pass (distinct from the `answers_path`
/// resume channel). Both default to "off", so `execute_skill_run` and every CLI
/// path are unchanged.
#[derive(Clone, Debug, Default)]
pub(crate) struct SkillRunOverrides {
    /// Select a runner by name instead of the manifest default.
    pub(crate) runner: Option<String>,
    /// Answers seeded for a single fresh run, keyed by resolution request id.
    /// Drives agent/graph runs to completion in one pass; `None` keeps the
    /// `answers_path` (resume-from-checkpoint) behavior.
    pub(crate) seeded_answers: Option<JsonObject>,
}

pub(crate) fn execute_skill_run_with_effects(
    request: &SkillRunRequest,
    effects: &RuntimeEffectRegistry,
) -> Result<JsonValue, SkillRunError> {
    execute_skill_run_with_overrides(request, &SkillRunOverrides::default(), effects)
}

pub(crate) fn execute_skill_run_with_overrides(
    request: &SkillRunRequest,
    overrides: &SkillRunOverrides,
    effects: &RuntimeEffectRegistry,
) -> Result<JsonValue, SkillRunError> {
    let raw_workspace = WorkspaceEnv::new(request.env.clone(), request.cwd.clone());
    let receipts = ReceiptServices::from_env(raw_workspace.env())
        .map_err(|error| SkillRunError::Invalid(error.to_string()))?;
    let mut runtime_env = request.env.clone();
    strip_receipt_signing_env(&mut runtime_env);
    let workspace = WorkspaceEnv::new(runtime_env, request.cwd.clone());
    let skill_dir = resolve_skill_dir(&request.skill_path)?;
    let manifest = load_runner_manifest(&skill_dir)?;
    let runner = selected_runner(&manifest, overrides.runner.as_deref())?;
    if runner.source.source_type == runx_parser::SourceKind::CliTool
        && request.local_credential.is_some()
    {
        return Err(invalid(
            "local credential process-env delivery is not supported for cli-tool runners",
        ));
    }
    let invocation = runner_invocation(
        &skill_dir,
        runner,
        &request.inputs,
        workspace.env(),
        request.local_credential.as_ref(),
    )?;
    if runner.source.source_type == runx_parser::SourceKind::CliTool {
        return execute_cli_tool_skill_run(
            request, &workspace, &receipts, &manifest, runner, invocation,
        );
    }
    if runner.source.source_type == runx_parser::SourceKind::Graph {
        return execute_graph_skill_run(
            request, overrides, effects, &workspace, &receipts, &manifest, runner,
        );
    }

    execute_agent_skill_run(
        request, overrides, &workspace, &receipts, &manifest, runner, invocation,
    )
}

/// Aggregate result of running a skill's declared inline harness (the
/// `harness.cases` in its runner manifest). Mirrors the publish-harness summary
/// the registry publish flow records: a status, counts, the per-case assertion
/// failures, the case names, the receipts each case sealed, and how many cases
/// exercised a graph (the stable-maturity graph-integration signal).
#[derive(Clone, Debug, Serialize)]
pub struct InlineHarnessReport {
    pub status: &'static str,
    pub case_count: usize,
    pub assertion_error_count: usize,
    pub assertion_errors: Vec<String>,
    pub case_names: Vec<String>,
    pub receipt_ids: Vec<String>,
    pub graph_case_count: usize,
}

impl InlineHarnessReport {
    fn not_declared() -> Self {
        Self {
            status: "not_declared",
            case_count: 0,
            assertion_error_count: 0,
            assertion_errors: Vec::new(),
            case_names: Vec::new(),
            receipt_ids: Vec::new(),
            graph_case_count: 0,
        }
    }
}

fn agent_invocation_source_type(
    value: &str,
) -> Result<AgentActInvocationSourceType, SkillRunError> {
    AgentActInvocationSourceType::from_contract_value(value)
        .ok_or_else(|| invalid(format!("unsupported agent source type {value}")))
}

fn agent_request(
    invocation: &SkillInvocation,
    source_type: AgentActInvocationSourceType,
) -> Result<JsonValue, SkillRunError> {
    contract_json_value(&agent_act_resolution_request(invocation, source_type)?)
}

fn needs_agent_output(run_id: &str, request_id: &str, request: JsonValue) -> JsonObject {
    let mut output = JsonObject::new();
    output.insert(
        "schema".to_owned(),
        JsonValue::String(SKILL_RUN_SCHEMA.to_owned()),
    );
    output.insert(
        "status".to_owned(),
        JsonValue::String("needs_agent".to_owned()),
    );
    output.insert("run_id".to_owned(), JsonValue::String(run_id.to_owned()));
    output.insert(
        "requests".to_owned(),
        JsonValue::Array(vec![request_for_public_loop(request_id, request)]),
    );
    output
}

fn request_for_public_loop(request_id: &str, request: JsonValue) -> JsonValue {
    let mut object = match request {
        JsonValue::Object(object) => object,
        _ => JsonObject::new(),
    };
    object.insert("id".to_owned(), JsonValue::String(request_id.to_owned()));
    object
        .entry("kind".to_owned())
        .or_insert_with(|| JsonValue::String("agent_act".to_owned()));
    JsonValue::Object(object)
}

fn read_answer(path: &Path, request_id: &str) -> Result<JsonValue, SkillRunError> {
    let raw = fs::read_to_string(path)
        .map_err(|source| RuntimeError::io(format!("reading {}", path.display()), source))?;
    let value = serde_json::from_str::<JsonValue>(&raw).map_err(|source| {
        RuntimeError::json(format!("parsing answers file {}", path.display()), source)
    })?;
    let answers = match &value {
        JsonValue::Object(object) => match object.get("answers") {
            Some(JsonValue::Object(nested)) => nested,
            _ => object,
        },
        _ => return Err(invalid("answers file must be a JSON object")),
    };
    answers
        .get(request_id)
        .cloned()
        .ok_or_else(|| invalid(format!("answers file did not include {request_id}")))
}

fn seal_skill_answer(
    run_id: &str,
    runner: &SkillRunnerDefinition,
    stdout: &str,
    disposition: ClosureDisposition,
    signature_config: &RuntimeReceiptSignatureConfig,
) -> Result<runx_contracts::Receipt, SkillRunError> {
    let disposition_label = closure_disposition_label(&disposition);
    let succeeded = disposition == ClosureDisposition::Closed;
    let status = if succeeded {
        InvocationStatus::Success
    } else {
        InvocationStatus::Failure
    };
    let skill_output = SkillOutput {
        status,
        stdout: stdout.to_owned(),
        stderr: if succeeded {
            String::new()
        } else {
            format!("agent act closed with {disposition_label}")
        },
        exit_code: succeeded.then_some(0),
        duration_ms: 0,
        metadata: JsonObject::new(),
    };
    seal_skill_output(
        run_id,
        runner,
        &skill_output,
        disposition,
        format!("agent_act_{disposition_label}"),
        format!("agent act closed with {disposition_label}"),
        signature_config,
    )
}

/// Build the domain act frame for a governed turn when its runner declares an
/// `act:` block: the trusted mapping from the driver's pinned beat inputs and the
/// model's reason text to the receipt's act, decision, and authority. Returns
/// `None` for runners without an `act:` block (sealed generically, exactly as
/// before). The model supplies only the reason prose; every structural field is
/// read from the runner declaration and the trusted inputs, never the model.
fn domain_act_frame(
    invocation: &SkillInvocation,
    answer: &JsonValue,
    governed_effect: Option<&JsonValue>,
) -> Option<DomainActFrame> {
    let act = invocation.source.raw.get("act").and_then(JsonValue::as_object)?;
    build_domain_act_frame(act, &invocation.inputs, answer, governed_effect)
}

/// The core of [`domain_act_frame`], reusable by the graph path: build the domain
/// act frame from a declared `act:` block, the trusted run inputs, the model's
/// authored reason source, and the real governed effect.
fn build_domain_act_frame(
    act: &runx_contracts::JsonObject,
    inputs: &runx_contracts::JsonObject,
    reason_source: &JsonValue,
    governed_effect: Option<&JsonValue>,
) -> Option<DomainActFrame> {
    use runx_contracts::{ActForm, DecisionChoice, Reference, ReferenceType};

    let act_str = |key: &str| act.get(key).and_then(JsonValue::as_str);
    // A declared field may be a static literal (`form: review`) or driver-pinned
    // from an input (`form_from: act_form`). The driver-pinned value wins, so one
    // generic skill serves every beat.
    let resolved = |key: &str| -> Option<String> {
        act_str(&format!("{key}_from"))
            .and_then(|input_key| inputs.get(input_key))
            .and_then(JsonValue::as_str)
            .or_else(|| act_str(key))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };

    let form = match resolved("form").as_deref().unwrap_or("observation") {
        "revision" => ActForm::Revision,
        "reply" => ActForm::Reply,
        "review" => ActForm::Review,
        "verification" => ActForm::Verification,
        _ => ActForm::Observation,
    };
    let purpose = resolved("purpose")?;
    let legitimacy = resolved("legitimacy")
        .unwrap_or_else(|| "Held the declared authority for this act".to_owned());

    // The single model-authored field: the human reason text.
    let reason = act_str("reason_from")
        .and_then(|key| reason_source.as_object().and_then(|object| object.get(key)))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map_or_else(|| purpose.clone(), str::to_owned);

    // Resolve a trusted input value (a uri) named by the act mapping into a ref.
    let input_ref = |map_key: &str, reference_type: ReferenceType| -> Option<Reference> {
        let input_key = act_str(map_key)?;
        let uri = inputs
            .get(input_key)
            .and_then(JsonValue::as_str)?
            .trim();
        (!uri.is_empty()).then(|| Reference::with_uri(reference_type, uri.to_owned()))
    };

    let decision_choice = act_str("decision_from")
        .and_then(|key| inputs.get(key))
        .and_then(JsonValue::as_str)
        .and_then(map_decision_choice)
        .unwrap_or(DecisionChoice::Close);

    // The effect ref: a venue id read from the real governed tool result (never
    // the model's restatement), wrapped into a domain uri. e.g. the `/v1`
    // response's `id` becomes `frantic:judgment:<id>` for the venue to reconcile.
    let artifact_refs = governed_effect
        .and_then(|effect| {
            let field = resolved("effect_from")?;
            let id = effect
                .as_object()
                .and_then(|object| object.get(field.as_str()))
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let reference_type = match act_str("effect_type").unwrap_or("artifact") {
                "act" => ReferenceType::Act,
                "tracking_item" => ReferenceType::TrackingItem,
                "receipt" => ReferenceType::Receipt,
                _ => ReferenceType::Artifact,
            };
            let prefix = resolved("effect_prefix").unwrap_or_default();
            Some(Reference::with_uri(reference_type, format!("{prefix}{id}")))
        })
        .into_iter()
        .collect::<Vec<_>>();

    Some(DomainActFrame {
        form,
        purpose: purpose.into(),
        legitimacy: legitimacy.into(),
        summary: reason.clone().into(),
        target_refs: input_ref("target_from", ReferenceType::TrackingItem)
            .into_iter()
            .collect(),
        artifact_refs,
        decision_choice,
        decision_summary: reason.into(),
        actor_ref: input_ref("actor_from", ReferenceType::Principal)
            .unwrap_or_else(|| Reference::runx(ReferenceType::Principal, "local_runtime")),
        authority_grant_refs: Vec::new(),
        authority_scope_refs: input_ref("authority_from", ReferenceType::Grant)
            .into_iter()
            .collect(),
        previous: input_ref("previous_from", ReferenceType::Receipt),
    })
}

/// Map a driver-pinned decision word onto the receipt's `DecisionChoice`.
fn map_decision_choice(value: &str) -> Option<runx_contracts::DecisionChoice> {
    use runx_contracts::DecisionChoice;
    match value.trim().to_ascii_lowercase().as_str() {
        "decline" | "reject" | "rejected" | "deny" | "denied" => Some(DecisionChoice::Decline),
        "close" | "accept" | "accepted" | "approve" | "approved" | "paid" | "settle" | "settled" => {
            Some(DecisionChoice::Close)
        }
        "continue" | "claim" | "claimed" | "deliver" | "delivered" => Some(DecisionChoice::Continue),
        "defer" | "deferred" => Some(DecisionChoice::Defer),
        "escalate" | "escalated" => Some(DecisionChoice::Escalate),
        "monitor" | "monitored" => Some(DecisionChoice::Monitor),
        _ => None,
    }
}

fn seal_skill_output(
    run_id: &str,
    runner: &SkillRunnerDefinition,
    output: &SkillOutput,
    disposition: ClosureDisposition,
    reason_code: String,
    summary: String,
    signature_config: &RuntimeReceiptSignatureConfig,
) -> Result<runx_contracts::Receipt, SkillRunError> {
    let graph_name = identifier_segment(run_id);
    let step_id = identifier_segment(&runner.name);
    let projection = project_step_output(output);
    Ok(seal_step(
        StepSeal {
            graph_name: &graph_name,
            step_id: &step_id,
            attempt: 1,
            output,
            projection: &projection,
            created_at: &crate::time::now_iso8601(),
            authority_grant_refs: Vec::new(),
            closure: Some(StepSealClosure {
                disposition,
                reason_code,
                summary,
            }),
        },
        signature_config.signature_policy(),
    )?)
}

fn answer_disposition(answer: &JsonValue) -> ClosureDisposition {
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

fn sealed_output(
    manifest: &SkillRunnerManifest,
    run_id: &str,
    skill_output: &SkillOutput,
    payload: &JsonValue,
    receipt: &runx_contracts::Receipt,
    receipt_value: JsonValue,
) -> JsonObject {
    let mut execution = JsonObject::new();
    execution.insert(
        "stdout".to_owned(),
        JsonValue::String(skill_output.stdout.clone()),
    );
    execution.insert(
        "stderr".to_owned(),
        JsonValue::String(skill_output.stderr.clone()),
    );
    execution.insert(
        "exit_code".to_owned(),
        skill_output.exit_code.map_or(JsonValue::Null, |exit_code| {
            JsonValue::Number(JsonNumber::I64(i64::from(exit_code)))
        }),
    );
    execution.insert("structured_output".to_owned(), payload.clone());
    execution.insert("skill_claim".to_owned(), payload.clone());
    if let Some(observations) = skill_output
        .metadata
        .get(crate::adapter::CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA)
    {
        execution.insert(
            crate::adapter::CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA.to_owned(),
            observations.clone(),
        );
    }

    let mut output = JsonObject::new();
    output.insert(
        "schema".to_owned(),
        JsonValue::String(SKILL_RUN_SCHEMA.to_owned()),
    );
    output.insert("status".to_owned(), JsonValue::String("sealed".to_owned()));
    output.insert(
        "skill_name".to_owned(),
        JsonValue::String(manifest.skill.clone().unwrap_or_else(|| "skill".to_owned())),
    );
    output.insert("run_id".to_owned(), JsonValue::String(run_id.to_owned()));
    output.insert(
        "receipt_id".to_owned(),
        JsonValue::String(receipt.id.to_string()),
    );
    output.insert(
        "closure".to_owned(),
        JsonValue::Object(closure_output(&receipt.seal)),
    );
    output.insert("receipt".to_owned(), receipt_value);
    output.insert("execution".to_owned(), JsonValue::Object(execution));
    output.insert("payload".to_owned(), payload.clone());
    output
}

fn closure_output(seal: &runx_contracts::Seal) -> JsonObject {
    let mut closure = JsonObject::new();
    closure.insert(
        "disposition".to_owned(),
        JsonValue::String(closure_disposition_label(&seal.disposition).to_owned()),
    );
    closure.insert(
        "reason_code".to_owned(),
        JsonValue::String(seal.reason_code.to_string()),
    );
    closure.insert(
        "summary".to_owned(),
        JsonValue::String(seal.summary.to_string()),
    );
    closure.insert(
        "closed_at".to_owned(),
        JsonValue::String(seal.closed_at.to_string()),
    );
    closure
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

fn identifier_segment(value: &str) -> String {
    normalize_request_id(value)
        .trim_matches(['.', '_', '-'])
        .replace('.', "-")
}

fn contract_json_value(value: &impl serde::Serialize) -> Result<JsonValue, SkillRunError> {
    let value = serde_json::to_value(value)
        .map_err(|source| RuntimeError::json("serializing native skill contract value", source))?;
    serde_json::from_value(value).map_err(|source| {
        RuntimeError::json("normalizing native skill contract value", source).into()
    })
}

fn invalid(message: impl Into<String>) -> SkillRunError {
    SkillRunError::Invalid(message.into())
}

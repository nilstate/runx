use super::{SkillRunError, invalid};
#[cfg(feature = "cli-tool")]
use super::{contract_json_value, identifier_segment, seal_skill_output, sealed_output};

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::{JsonObject, JsonValue};
use runx_parser::{
    SkillRunnerDefinition, SkillRunnerManifest, parse_runner_manifest_yaml,
    validate_runner_manifest,
};
#[cfg(feature = "cli-tool")]
use sha2::{Digest, Sha256};

use crate::RuntimeError;
#[cfg(feature = "cli-tool")]
use crate::adapter::SkillAdapter;
use crate::adapter::SkillInvocation;
#[cfg(feature = "cli-tool")]
use crate::adapters::cli_tool::CliToolAdapter;
use crate::execution::orchestrator::SkillRunRequest;
#[cfg(feature = "cli-tool")]
use crate::receipts::StepSealClosure;
use crate::services::{ReceiptServices, WorkspaceEnv};
#[cfg(feature = "cli-tool")]
use runx_contracts::ClosureDisposition;

const RUNX_HOSTED_CREDENTIAL_HANDLES_JSON_ENV: &str = "RUNX_HOSTED_CREDENTIAL_HANDLES_JSON";

pub(crate) fn resolve_skill_dir(path: &Path) -> Result<PathBuf, SkillRunError> {
    if path.is_dir() {
        return Ok(path.to_path_buf());
    }
    if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
        return path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| invalid(format!("skill path has no parent: {}", path.display())));
    }
    Err(invalid(format!(
        "Skill references must point to a skill package directory or SKILL.md. Flat markdown files are not supported: {}",
        path.display()
    )))
}

pub(crate) fn load_runner_manifest(skill_dir: &Path) -> Result<SkillRunnerManifest, SkillRunError> {
    let manifest_path = skill_dir.join("X.yaml");
    let raw = fs::read_to_string(&manifest_path).map_err(|source| {
        RuntimeError::io(format!("reading {}", manifest_path.display()), source)
    })?;
    let parsed = parse_runner_manifest_yaml(&raw).map_err(RuntimeError::from)?;
    validate_runner_manifest(parsed)
        .map_err(RuntimeError::from)
        .map_err(Into::into)
}

pub(crate) fn selected_runner<'a>(
    manifest: &'a SkillRunnerManifest,
    requested: Option<&str>,
) -> Result<&'a SkillRunnerDefinition, SkillRunError> {
    if let Some(name) = requested {
        return manifest
            .runners
            .get(name)
            .ok_or_else(|| invalid(format!("runner {name} is not declared in the manifest")));
    }
    let defaults = manifest
        .runners
        .values()
        .filter(|runner| runner.default)
        .collect::<Vec<_>>();
    match defaults.as_slice() {
        [runner] => Ok(*runner),
        [] if manifest.runners.len() == 1 => manifest
            .runners
            .values()
            .next()
            .ok_or_else(|| invalid("runner manifest declares no runners")),
        [] => Err(invalid("runner manifest has no default runner")),
        _ => Err(invalid("runner manifest declares multiple default runners")),
    }
}

pub(super) fn runner_invocation(
    skill_dir: &Path,
    runner: &SkillRunnerDefinition,
    inputs: &BTreeMap<String, JsonValue>,
    env: &BTreeMap<String, String>,
    local_credential: Option<&crate::execution::orchestrator::LocalCredentialDescriptor>,
) -> Result<SkillInvocation, SkillRunError> {
    if !matches!(
        runner.source.source_type.as_str(),
        "agent" | "agent-task" | "cli-tool" | "graph"
    ) {
        return Err(invalid(format!(
            "runx skill native execution only supports agent, agent-task, graph, and cli-tool runners, got {}",
            runner.source.source_type
        )));
    }
    let credential_delivery = credential_delivery_from_invocation(env, local_credential)?;
    Ok(SkillInvocation {
        skill_name: runner.name.clone(),
        source: runner.source.clone(),
        inputs: inputs.clone().into_iter().collect(),
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: skill_dir.to_path_buf(),
        env: env.clone(),
        credential_delivery,
    })
}

pub(super) fn credential_delivery_from_invocation(
    env: &BTreeMap<String, String>,
    local_credential: Option<&crate::execution::orchestrator::LocalCredentialDescriptor>,
) -> Result<crate::credentials::CredentialDelivery, SkillRunError> {
    let hosted_handles = env
        .get(RUNX_HOSTED_CREDENTIAL_HANDLES_JSON_ENV)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty());
    if hosted_handles.is_some() && local_credential.is_some() {
        return Err(invalid(format!(
            "{RUNX_HOSTED_CREDENTIAL_HANDLES_JSON_ENV} cannot be combined with local credential provision"
        )));
    }
    if let Some(raw) = hosted_handles {
        return crate::credentials::CredentialDelivery::from_hosted_handles_json(raw).map_err(
            |error| {
                invalid(format!(
                    "hosted credential handle admission failed: {error}"
                ))
            },
        );
    }
    Ok(match local_credential {
        Some(descriptor) => crate::credentials::CredentialDelivery::from_local_descriptor(
            descriptor.provider.clone(),
            descriptor.auth_mode.clone(),
            descriptor.env_var.clone(),
            descriptor.material_ref.clone(),
            descriptor.scopes.clone(),
            descriptor.secret.clone(),
        )
        .map_err(|error| invalid(format!("local credential provision failed: {error}")))?,
        None => crate::credentials::CredentialDelivery::none(),
    })
}

#[cfg(feature = "cli-tool")]
pub(super) fn execute_cli_tool_skill_run(
    request: &SkillRunRequest,
    workspace: &WorkspaceEnv,
    receipts: &ReceiptServices,
    manifest: &SkillRunnerManifest,
    runner: &SkillRunnerDefinition,
    invocation: SkillInvocation,
) -> Result<JsonValue, SkillRunError> {
    if request.answers_path.is_some() {
        return Err(invalid(
            "cli-tool runners do not support continuation answers",
        ));
    }
    let run_id = request
        .run_id
        .clone()
        .unwrap_or_else(|| cli_tool_run_id(runner, &request.inputs));
    let credential_observation = invocation.credential_delivery.public_observation().cloned();
    let mut output = CliToolAdapter.invoke(invocation)?;
    if let Some(observation) = &credential_observation {
        output.record_credential_observation(observation)?;
    }
    let disposition = if output.succeeded() {
        ClosureDisposition::Closed
    } else {
        ClosureDisposition::Failed
    };
    let receipt = seal_skill_output(
        &run_id,
        runner,
        &output,
        StepSealClosure {
            reason_code: format!("process_{}", disposition.label()),
            summary: format!("cli-tool {} completed", runner.name),
            disposition,
        },
        receipts.signature_config(),
        workspace.env(),
    )?;
    write_skill_receipt(request, workspace, receipts, &receipt)?;
    Ok(JsonValue::Object(sealed_output(
        manifest,
        &run_id,
        &output,
        &parse_output_payload(&output.stdout),
        &receipt,
        contract_json_value(&receipt)?,
    )))
}

#[cfg(not(feature = "cli-tool"))]
pub(super) fn execute_cli_tool_skill_run(
    _request: &SkillRunRequest,
    _workspace: &WorkspaceEnv,
    _receipts: &ReceiptServices,
    _manifest: &SkillRunnerManifest,
    _runner: &SkillRunnerDefinition,
    _invocation: SkillInvocation,
) -> Result<JsonValue, SkillRunError> {
    Err(invalid(
        "runx skill cli-tool execution is unavailable because runx-runtime was built without the cli-tool feature",
    ))
}

pub(super) fn write_skill_receipt(
    request: &SkillRunRequest,
    workspace: &WorkspaceEnv,
    receipts: &ReceiptServices,
    receipt: &runx_contracts::Receipt,
) -> Result<(), SkillRunError> {
    let receipt_path = receipts.resolve_path(workspace, request.receipt_dir.as_deref(), None);
    receipts
        .write_local_receipt(receipt, &receipt_path)
        .map_err(Into::into)
}

#[cfg(feature = "cli-tool")]
fn cli_tool_run_id(runner: &SkillRunnerDefinition, inputs: &BTreeMap<String, JsonValue>) -> String {
    let input_bytes = serde_json::to_vec(inputs).unwrap_or_default();
    let digest = Sha256::digest(input_bytes);
    format!(
        "run_{}_{}",
        identifier_segment(&runner.name),
        hex_prefix(&digest, 12)
    )
}

#[cfg(feature = "cli-tool")]
fn hex_prefix(bytes: &[u8], chars: usize) -> String {
    let full = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    full.chars().take(chars).collect()
}

#[cfg(feature = "cli-tool")]
fn parse_output_payload(stdout: &str) -> JsonValue {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return JsonValue::String(String::new());
    }
    serde_json::from_str(trimmed).unwrap_or_else(|_| JsonValue::String(trimmed.to_owned()))
}

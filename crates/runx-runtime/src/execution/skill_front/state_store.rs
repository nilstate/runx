use super::graph::GraphSkillRunState;
use super::{GRAPH_SKILL_STATE_SCHEMA, SkillRunError, identifier_segment, invalid};

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::RuntimeError;
use crate::execution::orchestrator::SkillRunRequest;
use crate::services::{ReceiptServices, WorkspaceEnv};

fn graph_state_path(
    request: &SkillRunRequest,
    workspace: &WorkspaceEnv,
    receipts: &ReceiptServices,
    run_id: &str,
) -> PathBuf {
    let receipt_path = receipts.resolve_path(workspace, request.receipt_dir.as_deref(), None);
    receipt_path
        .path
        .join("runs")
        .join(format!("{}.graph-state.json", identifier_segment(run_id)))
}

pub(super) fn write_graph_state(
    request: &SkillRunRequest,
    workspace: &WorkspaceEnv,
    receipts: &ReceiptServices,
    run_id: &str,
    state: &GraphSkillRunState,
) -> Result<(), SkillRunError> {
    let path = graph_state_path(request, workspace, receipts, run_id);
    write_state(&path, state)
}

fn write_state(path: &Path, state: &impl serde::Serialize) -> Result<(), SkillRunError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|source| RuntimeError::io(format!("creating {}", parent.display()), source))?;
    }
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|source| RuntimeError::json("serializing skill continuation state", source))?;
    let temp_path = state_temp_path(path);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write = options
        .open(&temp_path)
        .and_then(|mut file| file.write_all(&bytes));
    if let Err(source) = write {
        let _ignored = fs::remove_file(&temp_path);
        return Err(RuntimeError::io(format!("writing {}", temp_path.display()), source).into());
    }
    fs::rename(&temp_path, path).map_err(|source| {
        let _ignored = fs::remove_file(&temp_path);
        RuntimeError::io(
            format!("replacing {} with {}", path.display(), temp_path.display()),
            source,
        )
    })?;
    Ok(())
}

pub(super) fn read_graph_state(
    request: &SkillRunRequest,
    workspace: &WorkspaceEnv,
    receipts: &ReceiptServices,
    run_id: &str,
    runner_name: &str,
    package_digest: &str,
    execution_closure_digest: &str,
) -> Result<GraphSkillRunState, SkillRunError> {
    let path = graph_state_path(request, workspace, receipts, run_id);
    let raw = fs::read_to_string(&path)
        .map_err(|source| RuntimeError::io(format!("reading {}", path.display()), source))?;
    let state: GraphSkillRunState = serde_json::from_str(&raw).map_err(|source| {
        invalid(format!(
            "graph state file {} is malformed; the run cannot resume safely without a valid checkpoint: {source}",
            path.display()
        ))
    })?;
    if state.schema != GRAPH_SKILL_STATE_SCHEMA {
        return Err(invalid(format!(
            "graph state schema mismatch for run {run_id}: expected {GRAPH_SKILL_STATE_SCHEMA}, got {}",
            state.schema
        )));
    }
    if state.run_id != run_id {
        return Err(invalid(format!(
            "graph state run_id mismatch: expected {run_id}, got {}",
            state.run_id
        )));
    }
    if state.runner_name != runner_name {
        return Err(invalid(format!(
            "graph state runner_name mismatch for run {run_id}: expected {runner_name}, got {}",
            state.runner_name
        )));
    }
    if state.package_digest != package_digest {
        return Err(invalid(format!(
            "graph state package_digest mismatch for run {run_id}: expected {package_digest}, got {}",
            state.package_digest
        )));
    }
    if state.execution_closure_digest != execution_closure_digest {
        return Err(invalid(format!(
            "graph state execution_closure_digest mismatch for run {run_id}: expected {execution_closure_digest}, got {}",
            state.execution_closure_digest
        )));
    }
    Ok(state)
}

fn state_temp_path(path: &Path) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill-state.json");
    path.with_file_name(format!(
        "{file_name}.{}.{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct AgentSkillState {
    run_id: String,
    runner: String,
    package_digest: String,
    execution_closure_digest: String,
    inputs: runx_contracts::JsonObject,
}

fn agent_state_path(
    request: &SkillRunRequest,
    workspace: &WorkspaceEnv,
    receipts: &ReceiptServices,
    run_id: &str,
) -> PathBuf {
    receipts
        .resolve_path(workspace, request.receipt_dir.as_deref(), None)
        .path
        .join("runs")
        .join(format!("{}.agent-state.json", identifier_segment(run_id)))
}

pub(super) fn write_agent_state(
    context: &super::SkillExecutionContext<'_>,
    run_id: &str,
) -> Result<(), SkillRunError> {
    let state = AgentSkillState {
        run_id: run_id.to_owned(),
        runner: context.runner.name.clone(),
        package_digest: context.package_digest.to_owned(),
        execution_closure_digest: context
            .execution_closure_digest
            .ok_or_else(|| invalid("agent continuation requires an execution-closure digest"))?
            .to_owned(),
        inputs: context.request.inputs.clone(),
    };
    write_state(
        &agent_state_path(context.request, context.workspace, context.receipts, run_id),
        &state,
    )
}

pub(super) fn restore_agent_inputs(
    request: &mut SkillRunRequest,
    workspace: &WorkspaceEnv,
    receipts: &ReceiptServices,
    runner: &str,
    package_digest: &str,
    execution_closure_digest: Option<&str>,
) -> Result<(), SkillRunError> {
    let run_id = request
        .run_id
        .as_deref()
        .ok_or_else(|| invalid("agent continuation requires run_id"))?;
    let path = agent_state_path(request, workspace, receipts, run_id);
    let raw = fs::read(&path)
        .map_err(|source| RuntimeError::io(format!("reading {}", path.display()), source))?;
    let state: AgentSkillState = serde_json::from_slice(&raw)
        .map_err(|source| RuntimeError::json("reading agent continuation state", source))?;
    if state.run_id != run_id
        || state.runner != runner
        || state.package_digest != package_digest
        || Some(state.execution_closure_digest.as_str()) != execution_closure_digest
    {
        return Err(invalid(
            "agent continuation does not match its immutable execution binding",
        ));
    }
    if !request.inputs.is_empty() && request.inputs != state.inputs {
        return Err(invalid(
            "agent continuation cannot replace the original inputs",
        ));
    }
    request.inputs = state.inputs;
    Ok(())
}

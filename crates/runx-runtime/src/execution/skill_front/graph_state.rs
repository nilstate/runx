use super::graph::GraphSkillRunState;
use super::*;

use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::{JsonObject, JsonValue};

use crate::RuntimeError;
use crate::execution::orchestrator::SkillRunRequest;
use crate::services::{ReceiptServices, WorkspaceEnv};

pub(super) fn read_answers(path: &Path) -> Result<JsonObject, SkillRunError> {
    let raw = fs::read_to_string(path)
        .map_err(|source| RuntimeError::io(format!("reading {}", path.display()), source))?;
    let value = serde_json::from_str::<JsonValue>(&raw).map_err(|source| {
        RuntimeError::json(format!("parsing answers file {}", path.display()), source)
    })?;
    let answers = match value {
        JsonValue::Object(mut object) => match object.remove("answers") {
            Some(JsonValue::Object(nested)) => nested,
            Some(_) => return Err(invalid("answers field must be a JSON object")),
            None => object,
        },
        _ => return Err(invalid("answers file must be a JSON object")),
    };
    Ok(answers)
}

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
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|source| RuntimeError::io(format!("creating {}", parent.display()), source))?;
    }
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|source| RuntimeError::json("serializing graph state", source))?;
    let temp_path = graph_state_temp_path(&path);
    fs::write(&temp_path, bytes)
        .map_err(|source| RuntimeError::io(format!("writing {}", temp_path.display()), source))?;
    fs::rename(&temp_path, &path).map_err(|source| {
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
    Ok(state)
}

fn graph_state_temp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("graph-state.json");
    path.with_file_name(format!("{file_name}.{}.tmp", std::process::id()))
}

use std::collections::BTreeMap;
use std::path::Path;

use runx_contracts::JsonObject;

use self::input::QueryRequest;
pub(crate) use self::input::ReceiptQueryInput;
use self::projection::render_query;
use crate::RuntimeError;
use crate::journal::{LocalHistoryProjection, list_local_history_with_policy};
use crate::receipts::RuntimeReceiptSignaturePolicy;
use crate::receipts::paths::{ReceiptPathInputs, RuntimeReceiptConfig, resolve_receipt_path};
use crate::receipts::store::LocalReceiptStore;
use crate::services::receipt_proof::prove_receipts;
use crate::services::receipts::production_receipt_verifier;

mod input;
mod projection;

const TOOL: &str = "receipt.query";
const MAX_PROOF_RECEIPTS: usize = 100;

pub(crate) fn query_receipts(
    inputs: &ReceiptQueryInput,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<JsonObject, RuntimeError> {
    let request = QueryRequest::parse(inputs)?;
    let verifier = production_receipt_verifier(env)?;
    let signature_mode = if verifier.is_some() {
        "production"
    } else {
        "local-development"
    };
    let policy = verifier.as_ref().map_or_else(
        RuntimeReceiptSignaturePolicy::local_development,
        |verifier| RuntimeReceiptSignaturePolicy::production(verifier),
    );
    let resolved = resolve_receipt_path(ReceiptPathInputs {
        explicit_dir: None,
        runtime_config: Some(&RuntimeReceiptConfig::default()),
        env,
        cwd,
    });
    let store = LocalReceiptStore::new(&resolved.path);
    let history = load_history(
        &request,
        &store,
        &resolved.workspace_base,
        &resolved.project_runx_dir,
        policy,
    )?;
    let history_ids = history
        .as_ref()
        .map(|history| {
            history
                .receipts
                .iter()
                .map(|row| row.id.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let proof_ids = request.exact_ids.as_ref().unwrap_or(&history_ids);
    let proof_count = proof_ids.len();
    let proof_limit_exceeded = request.verify_chain && proof_count > MAX_PROOF_RECEIPTS;
    let proof = load_proof(
        proof_ids,
        request.verify_chain || request.exact_ids.is_some(),
        proof_limit_exceeded,
        env,
        cwd,
    )?;
    render_query(
        request,
        history,
        proof,
        signature_mode,
        resolved.label.as_str(),
        proof_limit_exceeded,
        proof_count,
    )
}

fn load_history(
    request: &QueryRequest,
    store: &LocalReceiptStore,
    workspace_base: &Path,
    project_runx_dir: &Path,
    policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Option<LocalHistoryProjection>, RuntimeError> {
    if request.exact_ids.is_some() {
        return Ok(None);
    }
    list_local_history_with_policy(
        store,
        workspace_base,
        project_runx_dir,
        &request.filter,
        policy,
    )
    .map(Some)
    .map_err(|error| invalid(format!("native receipt history failed: {error}")))
}

fn load_proof(
    receipt_ids: &[String],
    requested: bool,
    limit_exceeded: bool,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<Option<JsonObject>, RuntimeError> {
    if !requested || receipt_ids.is_empty() || limit_exceeded {
        return Ok(None);
    }
    prove_receipts(receipt_ids, env, cwd).map(Some)
}

fn invalid(message: impl Into<String>) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: TOOL.to_owned(),
        message: message.into(),
    }
}

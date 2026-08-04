// Approval host resolution is a concrete step-handler concern.
use runx_contracts::ApprovalGate;
use runx_parser::GraphStep;

use crate::RuntimeError;
use crate::approval::{ApprovalResolution, LocalApprovalGateResolver};
use crate::host::Host;

pub(super) fn resolve_step_approval(
    step: &GraphStep,
    host: &mut dyn Host,
    request_id: impl Into<String>,
    gate: ApprovalGate,
) -> Result<ApprovalResolution, RuntimeError> {
    LocalApprovalGateResolver::new()
        .request_approval(host, request_id, gate)
        .map_err(|source| RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: source.to_string(),
        })
}

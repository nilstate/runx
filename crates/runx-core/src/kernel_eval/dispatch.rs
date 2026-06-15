use std::collections::BTreeSet;

use runx_contracts::JsonValue;

use super::KernelEvalError;
use super::input::{KernelDocument, KernelInput};
use crate::policy::{
    admit_graph_step_scopes, admit_local_skill, admit_retry_policy, admit_sandbox,
    build_authority_proof_metadata, build_local_scope_admission,
    evaluate_public_comment_opportunity, evaluate_public_pull_request_candidate,
    normalize_public_work_policy, normalize_sandbox_declaration, sandbox_requires_approval,
    validate_credential_binding,
};
use crate::state_machine::{
    create_sequential_graph_state, create_single_step_state, evaluate_fanout_sync,
    fanout_sync_decision_key, plan_sequential_graph_transition, transition_sequential_graph,
    transition_single_step,
};

pub(super) fn evaluate_kernel_input(input: KernelDocument) -> Result<JsonValue, KernelEvalError> {
    let input = KernelInput::from(input);
    match input {
        KernelInput::AdmitLocalSkill { .. }
        | KernelInput::AdmitRetryPolicy { .. }
        | KernelInput::AdmitGraphStepScopes { .. }
        | KernelInput::NormalizeSandboxDeclaration { .. }
        | KernelInput::SandboxRequiresApproval { .. }
        | KernelInput::AdmitSandbox { .. }
        | KernelInput::BuildLocalScopeAdmission { .. }
        | KernelInput::BuildAuthorityProofMetadata { .. }
        | KernelInput::ValidateCredentialBinding { .. }
        | KernelInput::EvaluatePublicPullRequestCandidate { .. }
        | KernelInput::EvaluatePublicCommentOpportunity { .. }
        | KernelInput::NormalizePublicWorkPolicy { .. } => evaluate_policy_input(input),
        KernelInput::CreateSingleStepState { .. }
        | KernelInput::TransitionSingleStep { .. }
        | KernelInput::CreateSequentialGraphState { .. }
        | KernelInput::PlanSequentialGraphTransition { .. }
        | KernelInput::TransitionSequentialGraph { .. }
        | KernelInput::EvaluateFanoutSync { .. }
        | KernelInput::FanoutSyncDecisionKey { .. } => evaluate_state_machine_input(input),
    }
}

fn evaluate_policy_input(input: KernelInput) -> Result<JsonValue, KernelEvalError> {
    match input {
        KernelInput::AdmitLocalSkill { skill, options } => {
            to_value(admit_local_skill(&skill, &options))
        }
        KernelInput::AdmitRetryPolicy { request } => to_value(admit_retry_policy(&request)),
        KernelInput::AdmitGraphStepScopes { request } => {
            to_value(admit_graph_step_scopes(&request))
        }
        KernelInput::NormalizeSandboxDeclaration { sandbox } => {
            to_value(normalize_sandbox_declaration(sandbox.as_ref()))
        }
        KernelInput::SandboxRequiresApproval { sandbox } => {
            to_value(sandbox_requires_approval(sandbox.as_ref()))
        }
        KernelInput::AdmitSandbox { sandbox, options } => {
            to_value(admit_sandbox(sandbox.as_ref(), &options))
        }
        KernelInput::BuildLocalScopeAdmission {
            auth,
            grants,
            options,
        } => to_value(build_local_scope_admission(
            auth.as_ref(),
            &grants,
            &options,
        )),
        KernelInput::BuildAuthorityProofMetadata { options } => {
            to_value(build_authority_proof_metadata(&options))
        }
        KernelInput::ValidateCredentialBinding { request } => {
            to_value(validate_credential_binding(&request))
        }
        KernelInput::EvaluatePublicPullRequestCandidate { request, policy } => {
            to_value(evaluate_public_pull_request_candidate(&request, &policy))
        }
        KernelInput::EvaluatePublicCommentOpportunity { request, policy } => {
            to_value(evaluate_public_comment_opportunity(&request, &policy))
        }
        KernelInput::NormalizePublicWorkPolicy { policy } => {
            to_value(normalize_public_work_policy(&policy))
        }
        _ => unreachable!("policy dispatch only receives policy inputs"),
    }
}

fn evaluate_state_machine_input(input: KernelInput) -> Result<JsonValue, KernelEvalError> {
    match input {
        KernelInput::CreateSingleStepState { step_id } => {
            to_value(create_single_step_state(step_id))
        }
        KernelInput::TransitionSingleStep { state, event } => {
            to_value(transition_single_step(&state, &event))
        }
        KernelInput::CreateSequentialGraphState { graph_id, steps } => {
            to_value(create_sequential_graph_state(graph_id, &steps))
        }
        KernelInput::PlanSequentialGraphTransition {
            state,
            steps,
            fanout_policies,
            resolved_fanout_gate_keys,
        } => {
            let resolved = resolved_fanout_gate_keys.map(vec_to_set);
            to_value(plan_sequential_graph_transition(
                &state,
                &steps,
                &fanout_policies,
                resolved.as_ref(),
            ))
        }
        KernelInput::TransitionSequentialGraph { state, event } => {
            to_value(transition_sequential_graph(&state, &event))
        }
        KernelInput::EvaluateFanoutSync {
            policy,
            results,
            resolved_gate_keys,
        } => {
            let resolved = resolved_gate_keys.map(vec_to_set);
            to_value(evaluate_fanout_sync(&policy, &results, resolved.as_ref()))
        }
        KernelInput::FanoutSyncDecisionKey { decision } => Ok(JsonValue::String(
            fanout_sync_decision_key(&decision.group_id, &decision.rule_fired),
        )),
        _ => unreachable!("state-machine dispatch only receives state-machine inputs"),
    }
}

fn to_value(value: impl serde::Serialize) -> Result<JsonValue, KernelEvalError> {
    let source = serde_json::to_string(&value)
        .map_err(|error| KernelEvalError::SerializeOutput(error.to_string()))?;
    serde_json::from_str(&source)
        .map_err(|error| KernelEvalError::SerializeOutput(error.to_string()))
}

fn vec_to_set(values: Vec<String>) -> BTreeSet<String> {
    values.into_iter().collect()
}

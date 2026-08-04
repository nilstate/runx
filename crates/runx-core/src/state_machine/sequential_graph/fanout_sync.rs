use std::collections::BTreeSet;

use super::super::fanout::{
    evaluate_fanout_sync, evaluate_fanout_sync_without_gates, gate_free_fanout_outcome,
};
use super::super::types::{
    FanoutBranchResult, FanoutGroupPolicy, FanoutSyncDecision, FanoutSyncOutcome, GraphStepStatus,
    SequentialGraphState, SequentialGraphStepDefinition,
};
use super::index::SequentialGraphStepIndex;

/// Evaluate one indexed fanout group from canonical graph state.
///
/// Planning, execution receipts, and performance probes all use this owner so
/// branch selection and output inclusion cannot drift between paths.
#[must_use]
pub fn evaluate_sequential_fanout_sync(
    state: &SequentialGraphState,
    definitions: &[SequentialGraphStepDefinition],
    step_index: &SequentialGraphStepIndex,
    policy: &FanoutGroupPolicy,
    resolved_gate_keys: Option<&BTreeSet<String>>,
) -> FanoutSyncDecision {
    let include_outputs = policy_requires_outputs(policy);
    let positions = step_index
        .fanout_positions(&policy.group_id)
        .unwrap_or_default();
    if !include_outputs {
        let (success_count, failure_count) = gate_free_counts(state, positions);
        return evaluate_fanout_sync_without_gates(
            policy,
            positions.len(),
            success_count,
            failure_count,
        );
    }
    let results = step_index
        .fanout_positions(&policy.group_id)
        .into_iter()
        .flatten()
        .filter_map(|position| {
            definitions
                .get(*position)
                .map(|definition| (*position, definition))
        })
        .map(|(position, definition)| {
            let step = state.steps.get(position);
            FanoutBranchResult {
                step_id: definition.id.clone(),
                status: step.map_or(GraphStepStatus::Failed, |step| step.status.clone()),
                outputs: step.and_then(|step| step.outputs.clone()),
            }
        })
        .collect::<Vec<_>>();
    evaluate_fanout_sync(policy, &results, resolved_gate_keys)
}

pub(super) fn sequential_fanout_proceeds_without_gates(
    state: &SequentialGraphState,
    step_index: &SequentialGraphStepIndex,
    policy: &FanoutGroupPolicy,
) -> Option<bool> {
    if policy_requires_outputs(policy) {
        return None;
    }
    let positions = step_index
        .fanout_positions(&policy.group_id)
        .unwrap_or_default();
    let (success_count, failure_count) = gate_free_counts(state, positions);
    Some(
        gate_free_fanout_outcome(policy, positions.len(), success_count, failure_count)
            == FanoutSyncOutcome::Proceed,
    )
}

fn gate_free_counts(state: &SequentialGraphState, positions: &[usize]) -> (usize, usize) {
    let mut success_count = 0usize;
    let mut failure_count = 0usize;
    for position in positions {
        match state.steps.get(*position).map(|step| &step.status) {
            Some(GraphStepStatus::Succeeded) => success_count += 1,
            Some(GraphStepStatus::Failed) | None => failure_count += 1,
            Some(
                GraphStepStatus::Pending | GraphStepStatus::Running | GraphStepStatus::Skipped,
            ) => {}
        }
    }
    (success_count, failure_count)
}

fn policy_requires_outputs(policy: &FanoutGroupPolicy) -> bool {
    policy
        .threshold_gates
        .as_ref()
        .is_some_and(|gates| !gates.is_empty())
        || policy
            .conflict_gates
            .as_ref()
            .is_some_and(|gates| !gates.is_empty())
}

#[cfg(test)]
mod tests {
    use super::evaluate_sequential_fanout_sync;
    use crate::state_machine::{
        FanoutBranchFailurePolicy, FanoutGroupPolicy, FanoutSyncOutcome, FanoutSyncStrategy,
        GraphStepStatus, SequentialGraphStepDefinition, create_sequential_graph_state,
        create_sequential_graph_step_index,
    };

    #[test]
    fn missing_indexed_branch_state_fails_closed() {
        let definitions = ["first", "second"]
            .into_iter()
            .map(|id| SequentialGraphStepDefinition {
                id: id.to_owned(),
                context_from: None,
                retry: None,
                fanout_group: Some("workers".to_owned()),
            })
            .collect::<Vec<_>>();
        let index = create_sequential_graph_step_index(&definitions);
        let mut state = create_sequential_graph_state("graph", &definitions);
        state.steps[0].status = GraphStepStatus::Succeeded;
        state.steps.pop();
        let policy = FanoutGroupPolicy {
            group_id: "workers".to_owned(),
            strategy: FanoutSyncStrategy::All,
            min_success: None,
            on_branch_failure: FanoutBranchFailurePolicy::Continue,
            threshold_gates: None,
            conflict_gates: None,
        };

        let decision = evaluate_sequential_fanout_sync(&state, &definitions, &index, &policy, None);

        assert_eq!(decision.decision, FanoutSyncOutcome::Halt);
        assert_eq!(decision.branch_count, 2);
        assert_eq!(decision.success_count, 1);
        assert_eq!(decision.failure_count, 1);
    }
}

use std::collections::{BTreeMap, BTreeSet};

use super::super::types::{
    FanoutGroupPolicy, GraphStepStatus, SequentialGraphPlan, SequentialGraphState,
    SequentialGraphStepDefinition,
};
use super::fanout_group::{
    FanoutGroupPlan, contiguous_fanout_group, fanout_group_id, plan_fanout_group,
};
use super::index::SequentialGraphStepIndex;
use super::step_readiness::{missing_context_at, retry_budget_exhausted};

#[must_use]
pub fn plan_sequential_graph_transition(
    state: &SequentialGraphState,
    steps: &[SequentialGraphStepDefinition],
    fanout_policies: &BTreeMap<String, FanoutGroupPolicy>,
    resolved_fanout_gate_keys: Option<&BTreeSet<String>>,
) -> SequentialGraphPlan {
    let step_index = SequentialGraphStepIndex::new(steps);
    plan_sequential_graph_transition_indexed(
        state,
        steps,
        &step_index,
        fanout_policies,
        resolved_fanout_gate_keys,
    )
}

#[must_use]
pub fn plan_sequential_graph_transition_indexed(
    state: &SequentialGraphState,
    steps: &[SequentialGraphStepDefinition],
    step_index: &SequentialGraphStepIndex,
    fanout_policies: &BTreeMap<String, FanoutGroupPolicy>,
    resolved_fanout_gate_keys: Option<&BTreeSet<String>>,
) -> SequentialGraphPlan {
    if let Some(running_step) = state
        .steps
        .iter()
        .find(|step| step.status == GraphStepStatus::Running)
    {
        return SequentialGraphPlan::Blocked {
            step_id: running_step.step_id.clone(),
            reason: "step is already running".to_owned(),
            sync_decision: None,
        };
    }

    plan_sequential_graph_transition_indexed_from(
        state,
        steps,
        step_index,
        fanout_policies,
        resolved_fanout_gate_keys,
        0,
    )
}

/// Plan from a cursor whose preceding steps are known to be terminal.
///
/// Runtime executors maintain this cursor as steps complete, avoiding a fresh
/// scan of the terminal prefix for every transition. Callers that do not own
/// that invariant must use [`plan_sequential_graph_transition_indexed`].
#[must_use]
pub fn plan_sequential_graph_transition_indexed_from(
    state: &SequentialGraphState,
    steps: &[SequentialGraphStepDefinition],
    step_index: &SequentialGraphStepIndex,
    fanout_policies: &BTreeMap<String, FanoutGroupPolicy>,
    resolved_fanout_gate_keys: Option<&BTreeSet<String>>,
    start_index: usize,
) -> SequentialGraphPlan {
    debug_assert!(state.steps.iter().take(start_index).all(|step| matches!(
        step.status,
        GraphStepStatus::Succeeded | GraphStepStatus::Skipped
    )));

    let mut index = start_index.min(steps.len());
    while index < steps.len() {
        let step_definition = &steps[index];
        if let Some(group_id) = fanout_group_id(step_definition) {
            let group_steps = contiguous_fanout_group(steps, index, group_id);
            match plan_fanout_group(
                state,
                step_index,
                index,
                steps,
                group_steps,
                fanout_policies.get(group_id),
                resolved_fanout_gate_keys,
            ) {
                FanoutGroupPlan::Proceed => {
                    index += group_steps.len();
                    continue;
                }
                FanoutGroupPlan::Plan(plan) => return *plan,
            }
        }

        if let Some(plan) = plan_step(state, step_index, index, step_definition) {
            return plan;
        }
        index += 1;
    }

    SequentialGraphPlan::Complete
}

fn plan_step(
    state: &SequentialGraphState,
    step_index: &SequentialGraphStepIndex,
    definition_index: usize,
    step_definition: &SequentialGraphStepDefinition,
) -> Option<SequentialGraphPlan> {
    let Some(step_state) = step_index.state_at(state, definition_index, &step_definition.id) else {
        return Some(SequentialGraphPlan::Failed {
            step_id: step_definition.id.clone(),
            reason: "step state is missing".to_owned(),
            sync_decision: None,
        });
    };

    if step_state.status == GraphStepStatus::Running {
        return Some(SequentialGraphPlan::Blocked {
            step_id: step_definition.id.clone(),
            reason: "step is already running".to_owned(),
            sync_decision: None,
        });
    }

    // A succeeded step is done; a `when`-skipped step is selected out. Both are
    // terminal, so the forward walker moves past them to the next live step.
    if matches!(
        step_state.status,
        GraphStepStatus::Succeeded | GraphStepStatus::Skipped
    ) {
        return None;
    }
    if retry_budget_exhausted(step_state, step_definition) {
        return Some(SequentialGraphPlan::Failed {
            step_id: step_definition.id.clone(),
            reason: "step failed and retry budget is exhausted".to_owned(),
            sync_decision: None,
        });
    }
    if let Some(missing_context) =
        missing_context_at(state, step_index, definition_index, step_definition)
    {
        return Some(SequentialGraphPlan::Blocked {
            step_id: step_definition.id.clone(),
            reason: format!("waiting for context from {missing_context}"),
            sync_decision: None,
        });
    }

    Some(SequentialGraphPlan::RunStep {
        step_id: step_definition.id.clone(),
        attempt: step_state.attempts + 1,
        context_from: step_definition.context_from.clone().unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        plan_sequential_graph_transition_indexed, plan_sequential_graph_transition_indexed_from,
    };
    use crate::state_machine::{
        GraphStepStatus, SequentialGraphStepDefinition, create_sequential_graph_state,
        create_sequential_graph_step_index,
    };

    #[test]
    fn terminal_prefix_cursor_preserves_the_canonical_plan() {
        let definitions = (0..3)
            .map(|index| SequentialGraphStepDefinition {
                id: format!("step_{index}"),
                context_from: None,
                retry: None,
                fanout_group: None,
            })
            .collect::<Vec<_>>();
        let index = create_sequential_graph_step_index(&definitions);
        let mut state = create_sequential_graph_state("graph", &definitions);
        state.steps[0].status = GraphStepStatus::Succeeded;

        let canonical = plan_sequential_graph_transition_indexed(
            &state,
            &definitions,
            &index,
            &BTreeMap::new(),
            None,
        );
        let from_cursor = plan_sequential_graph_transition_indexed_from(
            &state,
            &definitions,
            &index,
            &BTreeMap::new(),
            None,
            1,
        );

        assert_eq!(from_cursor, canonical);
    }
}

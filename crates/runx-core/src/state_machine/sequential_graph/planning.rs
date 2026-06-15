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
    skipped_steps: &BTreeSet<String>,
) -> SequentialGraphPlan {
    let step_index = SequentialGraphStepIndex::new(steps);
    plan_sequential_graph_transition_indexed(
        state,
        steps,
        &step_index,
        fanout_policies,
        resolved_fanout_gate_keys,
        skipped_steps,
    )
}

#[must_use]
pub fn plan_sequential_graph_transition_indexed(
    state: &SequentialGraphState,
    steps: &[SequentialGraphStepDefinition],
    step_index: &SequentialGraphStepIndex,
    fanout_policies: &BTreeMap<String, FanoutGroupPolicy>,
    resolved_fanout_gate_keys: Option<&BTreeSet<String>>,
    skipped_steps: &BTreeSet<String>,
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

    let mut index = 0;
    while index < steps.len() {
        let step_definition = &steps[index];
        // a `when` condition the runtime resolved to false selects this step out;
        // it is treated as done so the forward walker simply moves past it.
        if skipped_steps.contains(&step_definition.id) {
            index += 1;
            continue;
        }
        if let Some(group_id) = fanout_group_id(step_definition) {
            let group_steps = contiguous_fanout_group(steps, index, group_id);
            match plan_fanout_group(
                state,
                step_index,
                index,
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

    if step_state.status == GraphStepStatus::Succeeded {
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

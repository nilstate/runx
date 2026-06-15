use std::collections::BTreeMap;

use runx_contracts::{JsonObject, JsonValue};
use runx_core::state_machine::{
    FanoutBranchResult, FanoutGroupPolicy, GraphStepStatus, SequentialGraphPlan,
    SequentialGraphState, SequentialGraphStepDefinition, SequentialGraphStepIndex,
    create_sequential_graph_step_index, plan_sequential_graph_transition_indexed,
};
use runx_parser::{ExecutionGraph, GraphStep};

use crate::{RuntimeError, StepRun};

pub(crate) struct ExecutionGraphIndex {
    definitions: Vec<SequentialGraphStepDefinition>,
    planner_index: SequentialGraphStepIndex,
    step_positions: StepPositionIndex,
    fanout_group_positions: BTreeMap<String, Vec<usize>>,
}

struct StepPositionIndex {
    positions: BTreeMap<String, usize>,
}

impl StepPositionIndex {
    fn new() -> Self {
        Self {
            positions: BTreeMap::new(),
        }
    }

    fn insert(&mut self, step_id: &str, index: usize) {
        self.positions.insert(step_id.to_owned(), index);
    }

    fn position(&self, step_id: &str) -> Option<usize> {
        self.positions.get(step_id).copied()
    }
}

impl ExecutionGraphIndex {
    #[must_use]
    pub(crate) fn new(
        graph: &ExecutionGraph,
        definitions: Vec<SequentialGraphStepDefinition>,
    ) -> Self {
        let planner_index = create_sequential_graph_step_index(&definitions);
        let mut step_positions = StepPositionIndex::new();
        let mut fanout_group_positions: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for (index, step) in graph.steps.iter().enumerate() {
            step_positions.insert(&step.id, index);
            if let Some(group_id) = step.fanout_group.as_deref().filter(|id| !id.is_empty()) {
                fanout_group_positions
                    .entry(group_id.to_owned())
                    .or_default()
                    .push(index);
            }
        }
        Self {
            definitions,
            planner_index,
            step_positions,
            fanout_group_positions,
        }
    }

    pub(crate) fn plan_transition(
        &self,
        state: &SequentialGraphState,
        fanout_policies: &BTreeMap<String, FanoutGroupPolicy>,
    ) -> SequentialGraphPlan {
        plan_sequential_graph_transition_indexed(
            state,
            &self.definitions,
            &self.planner_index,
            fanout_policies,
            None,
        )
    }

    pub(crate) fn find_step<'a>(
        &self,
        graph: &'a ExecutionGraph,
        step_id: &str,
    ) -> Result<&'a GraphStep, RuntimeError> {
        graph
            .steps
            .get(self.step_positions.position(step_id).ok_or_else(|| {
                RuntimeError::StepMissing {
                    step_id: step_id.to_owned(),
                }
            })?)
            .filter(|step| step.id == step_id)
            .ok_or_else(|| RuntimeError::StepMissing {
                step_id: step_id.to_owned(),
            })
    }

    pub(crate) fn branch_results(
        &self,
        graph: &ExecutionGraph,
        state: &SequentialGraphState,
        group_id: &str,
        include_outputs: bool,
    ) -> Vec<FanoutBranchResult> {
        let Some(indexes) = self.fanout_group_positions.get(group_id) else {
            return Vec::new();
        };
        indexes
            .iter()
            .filter_map(|index| graph.steps.get(*index))
            .map(|step| {
                let state = self.state_for(state, &step.id);
                FanoutBranchResult {
                    step_id: step.id.clone(),
                    status: state.map_or(GraphStepStatus::Failed, |state| state.status.clone()),
                    outputs: if include_outputs {
                        state.and_then(|state| state.outputs.clone())
                    } else {
                        None
                    },
                }
            })
            .collect()
    }

    fn state_for<'a>(
        &self,
        state: &'a SequentialGraphState,
        step_id: &str,
    ) -> Option<&'a runx_core::state_machine::SequentialGraphStepState> {
        self.step_positions
            .position(step_id)
            .and_then(|index| state.steps.get(index))
            .filter(|state| state.step_id == step_id)
    }
}

pub(crate) struct PriorRunIndex<'a> {
    runs: BTreeMap<&'a str, &'a StepRun>,
}

impl<'a> PriorRunIndex<'a> {
    #[must_use]
    pub(crate) fn new(prior_runs: &'a [StepRun]) -> Self {
        let mut runs = BTreeMap::new();
        for run in prior_runs {
            runs.insert(run.step_id.as_str(), run);
        }
        Self { runs }
    }

    #[must_use]
    pub(crate) fn from_positions(
        prior_runs: &'a [StepRun],
        positions: &'a BTreeMap<String, usize>,
    ) -> Self {
        Self {
            runs: positions
                .iter()
                .filter_map(|(step_id, index)| {
                    prior_runs
                        .get(*index)
                        .map(|run| (step_id.as_str(), run))
                        .filter(|(_, run)| run.step_id == *step_id)
                })
                .collect(),
        }
    }

    pub(crate) fn output(&self, from_step: &str, output: &str) -> Result<JsonValue, RuntimeError> {
        let Some(run) = self.runs.get(from_step) else {
            return Err(RuntimeError::GraphBlocked {
                step_id: from_step.to_owned(),
                reason: "context source step has not run".to_owned(),
            });
        };
        Ok(resolve_output_path(&run.outputs, output).unwrap_or(JsonValue::Null))
    }
}

pub(crate) fn resolve_output_path(outputs: &JsonObject, output: &str) -> Option<JsonValue> {
    let mut segments = output.split('.');
    let first = segments.next()?;
    let mut value = outputs.get(first)?;
    for segment in segments {
        let JsonValue::Object(object) = value else {
            return None;
        };
        value = object.get(segment)?;
    }
    Some(value.clone())
}

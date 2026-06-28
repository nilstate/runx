use std::collections::BTreeMap;

use runx_contracts::{JsonObject, JsonValue};
use runx_core::state_machine::{
    FanoutBranchResult, FanoutGroupPolicy, GraphStepStatus, SequentialGraphPlan,
    SequentialGraphState, SequentialGraphStepDefinition, SequentialGraphStepIndex,
    create_sequential_graph_step_index, plan_sequential_graph_transition_indexed,
};
use runx_parser::{ExecutionGraph, GraphStep};

use crate::execution::output_projection::BASE_OUTPUT_FIELDS;
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
        reject_base_key_edge(from_step, output)?;
        resolve_output_path(&run.outputs, output).map_err(|break_at| {
            RuntimeError::ContextEdgeUnresolved {
                from_step: from_step.to_owned(),
                output_path: output.to_owned(),
                missing_segment: break_at.missing_segment,
                available_keys: break_at.available_keys,
            }
        })
    }
}

/// Base/diagnostic fields (`raw`/`skill_claim`/`stdout`/`stderr`/`status`) are kept
/// in a step's `outputs` for receipts and effect replay, but they are not part of
/// the step's addressable contract. A context edge whose first path segment names
/// one of them is rejected loudly so authors bind to the contract (declared outputs
/// or artifact packets), never to diagnostic material.
fn reject_base_key_edge(from_step: &str, output: &str) -> Result<(), RuntimeError> {
    let first = output.split('.').next().unwrap_or(output);
    if BASE_OUTPUT_FIELDS.contains(&first) {
        return Err(RuntimeError::ContextEdgeBaseKey {
            from_step: from_step.to_owned(),
            output_path: output.to_owned(),
            base_field: first.to_owned(),
        });
    }
    Ok(())
}

/// Where a context-edge path stopped resolving: the segment that was absent and the keys
/// that were available at that depth (empty when the value there was not an object).
pub(crate) struct ContextPathBreak {
    pub(crate) missing_segment: String,
    pub(crate) available_keys: Vec<String>,
}

pub(crate) fn resolve_output_path(
    outputs: &JsonObject,
    output: &str,
) -> Result<JsonValue, ContextPathBreak> {
    let mut segments = output.split('.');
    let Some(first) = segments.next() else {
        return Err(ContextPathBreak {
            missing_segment: String::new(),
            available_keys: outputs.keys().cloned().collect(),
        });
    };
    let mut value = outputs.get(first).ok_or_else(|| ContextPathBreak {
        missing_segment: first.to_owned(),
        available_keys: outputs.keys().cloned().collect(),
    })?;
    for segment in segments {
        let JsonValue::Object(object) = value else {
            return Err(ContextPathBreak {
                missing_segment: segment.to_owned(),
                available_keys: Vec::new(),
            });
        };
        value = object.get(segment).ok_or_else(|| ContextPathBreak {
            missing_segment: segment.to_owned(),
            available_keys: object.keys().cloned().collect(),
        })?;
    }
    Ok(value.clone())
}

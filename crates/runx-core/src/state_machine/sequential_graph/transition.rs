use runx_contracts::JsonObject;

use super::super::types::{
    GraphStatus, GraphStepStatus, SequentialGraphEvent, SequentialGraphState,
    SequentialGraphStepState, StepAdmissionWitness,
};

#[must_use]
pub fn transition_sequential_graph(
    state: &SequentialGraphState,
    event: &SequentialGraphEvent,
) -> SequentialGraphState {
    let mut next = state.clone();
    apply_sequential_graph_event(&mut next, event);
    next
}

pub fn apply_sequential_graph_event(
    state: &mut SequentialGraphState,
    event: &SequentialGraphEvent,
) {
    match event {
        SequentialGraphEvent::StartStep { step_id, at } => {
            update_step_in_place(state, step_id, |step| start_step_in_place(step, at));
            state.status = GraphStatus::Running;
        }
        SequentialGraphEvent::StepSucceeded {
            step_id,
            at,
            receipt_id,
            admission_witness,
            outputs,
        } => update_step_in_place(state, step_id, |step| {
            succeed_step_in_place(step, at, receipt_id, admission_witness, outputs.clone())
        }),
        SequentialGraphEvent::StepFailed { step_id, at, error } => {
            update_step_in_place(state, step_id, |step| fail_step_in_place(step, at, error));
        }
        SequentialGraphEvent::StepSkipped { step_id, at } => {
            update_step_in_place(state, step_id, |step| skip_step_in_place(step, at));
        }
        SequentialGraphEvent::Complete if is_graph_complete(state) => {
            state.status = GraphStatus::Succeeded;
        }
        SequentialGraphEvent::Complete => {}
        SequentialGraphEvent::PauseGraph { .. } => {
            state.status = GraphStatus::Paused;
        }
        SequentialGraphEvent::EscalateGraph { .. } => {
            state.status = GraphStatus::Escalated;
        }
        SequentialGraphEvent::FailGraph { .. } => {
            state.status = GraphStatus::Failed;
        }
    }
}

fn start_step_in_place(step: &mut SequentialGraphStepState, at: &str) {
    if matches!(
        step.status,
        GraphStepStatus::Running | GraphStepStatus::Succeeded
    ) {
        return;
    }
    step.status = GraphStepStatus::Running;
    step.attempts += 1;
    step.started_at = Some(at.to_owned());
    step.completed_at = None;
    step.outputs = None;
    step.error = None;
}

fn succeed_step_in_place(
    step: &mut SequentialGraphStepState,
    at: &str,
    receipt_id: &str,
    admission_witness: &StepAdmissionWitness,
    outputs: Option<JsonObject>,
) {
    if step.status != GraphStepStatus::Running {
        return;
    }
    if !admission_witness.matches_step_receipt(&step.step_id, receipt_id) {
        return;
    }
    step.status = GraphStepStatus::Succeeded;
    step.completed_at = Some(at.to_owned());
    step.receipt_id = Some(receipt_id.to_owned());
    step.outputs = outputs;
    step.error = None;
}

fn fail_step_in_place(step: &mut SequentialGraphStepState, at: &str, error: &str) {
    if step.status != GraphStepStatus::Running {
        return;
    }
    step.status = GraphStepStatus::Failed;
    step.completed_at = Some(at.to_owned());
    step.outputs = None;
    step.error = Some(error.to_owned());
}

fn skip_step_in_place(step: &mut SequentialGraphStepState, at: &str) {
    if step.status != GraphStepStatus::Pending {
        return;
    }
    step.status = GraphStepStatus::Skipped;
    step.completed_at = Some(at.to_owned());
    step.outputs = None;
    step.error = None;
}

fn update_step_in_place(
    state: &mut SequentialGraphState,
    step_id: &str,
    update: impl FnOnce(&mut SequentialGraphStepState),
) {
    if let Some(step) = state.steps.iter_mut().find(|step| step.step_id == step_id) {
        update(step);
    }
}

fn is_graph_complete(state: &SequentialGraphState) -> bool {
    state.steps.iter().all(|step| {
        !matches!(
            step.status,
            GraphStepStatus::Pending | GraphStepStatus::Running
        )
    })
}

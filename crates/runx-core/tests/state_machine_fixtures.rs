use std::collections::{BTreeMap, BTreeSet};

use runx_core::state_machine::{
    FanoutBranchResult, FanoutGroupPolicy, SequentialGraphEvent, SequentialGraphState,
    SequentialGraphStepDefinition, SingleStepEvent, SingleStepState, create_sequential_graph_state,
    create_single_step_state, evaluate_fanout_sync, fanout_sync_decision_key,
    plan_sequential_graph_transition, transition_sequential_graph, transition_single_step,
};
use serde::Deserialize;
use serde_json::Value;

type TestResult = Result<(), String>;

#[derive(Deserialize)]
struct KernelFixture {
    name: String,
    input: StateMachineInput,
    expected: Expected,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Expected {
    Output {
        value: Value,
    },
    Error {
        code: String,
        message: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
enum StateMachineInput {
    #[serde(rename = "state-machine.createSingleStepState")]
    CreateSingleStepState { step_id: String },
    #[serde(rename = "state-machine.transitionSingleStep")]
    TransitionSingleStep {
        state: SingleStepState,
        event: SingleStepEvent,
    },
    #[serde(rename = "state-machine.createSequentialGraphState")]
    CreateSequentialGraphState {
        graph_id: String,
        steps: Vec<SequentialGraphStepDefinition>,
    },
    #[serde(rename = "state-machine.planSequentialGraphTransition")]
    PlanSequentialGraphTransition {
        state: SequentialGraphState,
        steps: Vec<SequentialGraphStepDefinition>,
        #[serde(default)]
        fanout_policies: BTreeMap<String, FanoutGroupPolicy>,
        resolved_fanout_gate_keys: Option<Vec<String>>,
    },
    #[serde(rename = "state-machine.transitionSequentialGraph")]
    TransitionSequentialGraph {
        state: SequentialGraphState,
        event: SequentialGraphEvent,
    },
    #[serde(rename = "state-machine.evaluateFanoutSync")]
    EvaluateFanoutSync {
        policy: FanoutGroupPolicy,
        results: Vec<FanoutBranchResult>,
        resolved_gate_keys: Option<Vec<String>>,
    },
    #[serde(rename = "state-machine.fanoutSyncDecisionKey")]
    FanoutSyncDecisionKey { decision: DecisionKeyInput },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecisionKeyInput {
    group_id: String,
    rule_fired: String,
}

#[test]
fn fixture_single_step_create_pending() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/single-step-create-pending.json"
    ))
}

#[test]
fn fixture_single_step_transition_succeed() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/single-step-transition-succeed.json"
    ))
}

#[test]
fn fixture_single_step_transition_ignores_invalid_event() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/single-step-transition-ignores-invalid-event.json"
    ))
}

#[test]
fn fixture_sequential_create_graph() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/sequential-create-graph.json"
    ))
}

#[test]
fn fixture_sequential_plan_first_step() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/sequential-plan-first-step.json"
    ))
}

#[test]
fn fixture_sequential_plan_retry_after_failure() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/sequential-plan-retry-after-failure.json"
    ))
}

#[test]
fn fixture_sequential_transition_step_succeeded() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/sequential-transition-step-succeeded.json"
    ))
}

#[test]
fn fixture_fanout_plan_branch_set() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/fanout-plan-branch-set.json"
    ))
}

#[test]
fn fixture_fanout_plan_conflict_escalates() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/fanout-plan-conflict-escalates.json"
    ))
}

#[test]
fn fixture_fanout_plan_resolved_threshold_proceeds() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/fanout-plan-resolved-threshold-proceeds.json"
    ))
}

#[test]
fn fixture_fanout_evaluate_branch_failure_halts() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/fanout-evaluate-branch-failure-halts.json"
    ))
}

#[test]
fn fixture_fanout_evaluate_threshold_pause() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/fanout-evaluate-threshold-pause.json"
    ))
}

#[test]
fn fixture_fanout_evaluate_resolved_threshold_proceeds() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/fanout-evaluate-resolved-threshold-proceeds.json"
    ))
}

#[test]
fn fixture_fanout_decision_key() -> TestResult {
    assert_fixture(include_str!(
        "../../../fixtures/kernel/state-machine/fanout-decision-key.json"
    ))
}

fn assert_fixture(json: &str) -> TestResult {
    let fixture: KernelFixture = serde_json::from_str(json).map_err(string_error)?;
    let actual = evaluate_input(fixture.input)?;
    match fixture.expected {
        Expected::Output { value } => {
            assert_eq!(actual, value, "fixture {}", fixture.name);
            Ok(())
        }
        Expected::Error { code, message } => Err(format!(
            "fixture {} expected error {code} {message:?}, but state-machine dispatch succeeded",
            fixture.name
        )),
    }
}

fn evaluate_input(input: StateMachineInput) -> Result<Value, String> {
    match input {
        StateMachineInput::CreateSingleStepState { step_id } => {
            to_value(create_single_step_state(step_id))
        }
        StateMachineInput::TransitionSingleStep { state, event } => {
            to_value(transition_single_step(&state, &event))
        }
        StateMachineInput::CreateSequentialGraphState { graph_id, steps } => {
            to_value(create_sequential_graph_state(graph_id, &steps))
        }
        StateMachineInput::PlanSequentialGraphTransition {
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
        StateMachineInput::TransitionSequentialGraph { state, event } => {
            to_value(transition_sequential_graph(&state, &event))
        }
        StateMachineInput::EvaluateFanoutSync {
            policy,
            results,
            resolved_gate_keys,
        } => {
            let resolved = resolved_gate_keys.map(vec_to_set);
            to_value(evaluate_fanout_sync(&policy, &results, resolved.as_ref()))
        }
        StateMachineInput::FanoutSyncDecisionKey { decision } => Ok(Value::String(
            fanout_sync_decision_key(&decision.group_id, &decision.rule_fired),
        )),
    }
}

fn to_value(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(string_error)
}

fn vec_to_set(values: Vec<String>) -> BTreeSet<String> {
    values.into_iter().collect()
}

fn string_error(error: serde_json::Error) -> String {
    error.to_string()
}

use std::collections::BTreeMap;

use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use runx_contracts::{JsonNumber, JsonValue};
use runx_core::state_machine::{
    FanoutBranchFailurePolicy, FanoutBranchResult, FanoutGateAction, FanoutGroupPolicy,
    FanoutSyncDecision, FanoutSyncOutcome, FanoutSyncStrategy, FanoutThresholdGate, GraphStatus,
    GraphStepStatus, SequentialGraphEvent, SequentialGraphPlan, SequentialGraphState,
    SequentialGraphStepDefinition, SequentialGraphStepState, SingleStepEvent, SingleStepState,
    StepAdmissionWitness, StepStatus, evaluate_fanout_sync, fanout_sync_decision_key,
    plan_sequential_graph_transition, transition_sequential_graph, transition_single_step,
};

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn single_step_transitions_are_deterministic(
        state in single_step_state(),
        event in single_step_event(),
    ) {
        let left = transition_single_step(&state, &event);
        let right = transition_single_step(&state, &event);

        prop_assert_eq!(left, right);
    }

    #[test]
    fn terminal_single_step_states_ignore_later_events(
        mut state in single_step_state(),
        event in single_step_event(),
    ) {
        state.status = if state.step_id.len() % 2 == 0 {
            StepStatus::Succeeded
        } else {
            StepStatus::Failed
        };
        let next = transition_single_step(&state, &event);

        prop_assert_eq!(next, state);
    }

    #[test]
    fn sequential_graph_transitions_are_deterministic(
        state in sequential_graph_state(),
        event in sequential_graph_event(),
    ) {
        let left = transition_sequential_graph(&state, &event);
        let right = transition_sequential_graph(&state, &event);

        prop_assert_eq!(left, right);
    }

    #[test]
    fn graph_status_override_events_are_unconditional(
        state in sequential_graph_state(),
        reason in safe_string(),
        error in safe_string(),
    ) {
        let paused = transition_sequential_graph(
            &state,
            &SequentialGraphEvent::PauseGraph {
                reason: reason.clone(),
            },
        );
        let escalated = transition_sequential_graph(
            &state,
            &SequentialGraphEvent::EscalateGraph {
                reason,
            },
        );
        let failed = transition_sequential_graph(&state, &SequentialGraphEvent::FailGraph { error });

        prop_assert_eq!(paused.status, GraphStatus::Paused);
        prop_assert_eq!(escalated.status, GraphStatus::Escalated);
        prop_assert_eq!(failed.status, GraphStatus::Failed);
    }

    #[test]
    fn complete_only_succeeds_when_no_steps_are_pending_or_running(
        mut state in sequential_graph_state(),
        has_blocking_step in any::<bool>(),
    ) {
        if has_blocking_step {
            state.steps[0].status = GraphStepStatus::Pending;
            let next = transition_sequential_graph(&state, &SequentialGraphEvent::Complete);

            prop_assert_eq!(next, state);
        } else {
            for (index, step) in state.steps.iter_mut().enumerate() {
                step.status = if index % 2 == 0 {
                    GraphStepStatus::Succeeded
                } else {
                    GraphStepStatus::Failed
                };
            }
            let mut expected = state.clone();
            expected.status = GraphStatus::Succeeded;
            let next = transition_sequential_graph(&state, &SequentialGraphEvent::Complete);

            prop_assert_eq!(next, expected);
        }
    }

    #[test]
    fn fanout_decision_keys_are_structural(
        group_id in safe_string(),
        rule_fired in safe_string(),
    ) {
        let left = fanout_sync_decision_key(&group_id, &rule_fired);
        let right = fanout_sync_decision_key(&group_id, &rule_fired);
        let encoded = serde_json::to_string(&left).map_err(test_case_error)?;
        let decoded: String = serde_json::from_str(&encoded).map_err(test_case_error)?;

        prop_assert_eq!(&left, &right);
        prop_assert_eq!(&left, &decoded);
    }

    #[test]
    fn fanout_decision_keys_survive_decision_roundtrip(
        decision in fanout_sync_decision(),
    ) {
        let encoded = serde_json::to_string(&decision).map_err(test_case_error)?;
        let decoded: FanoutSyncDecision = serde_json::from_str(&encoded).map_err(test_case_error)?;
        let before_key = fanout_sync_decision_key(&decision.group_id, &decision.rule_fired);
        let after_key = fanout_sync_decision_key(&decoded.group_id, &decoded.rule_fired);

        prop_assert_eq!(before_key, after_key);
    }
}

#[test]
fn threshold_compared_to_serializes_whole_numbers_like_javascript() -> Result<(), serde_json::Error>
{
    let decision = evaluate_fanout_sync(
        &threshold_policy(JsonNumber::F64(1.0)),
        &[threshold_result(JsonNumber::I64(2))],
        None,
    );
    let json = serde_json::to_string(&decision)?;

    assert!(json.contains(r#""comparedTo":1"#));
    assert!(!json.contains(r#""comparedTo":1.0"#));
    Ok(())
}

#[test]
fn non_finite_threshold_output_is_non_numeric() {
    let decision = evaluate_fanout_sync(
        &threshold_policy(JsonNumber::F64(0.8)),
        &[threshold_result(JsonNumber::F64(f64::NAN))],
        None,
    );

    assert_eq!(decision.decision, FanoutSyncOutcome::Halt);
    assert_eq!(decision.rule_fired, "threshold.risk.risk_score.non_numeric");
}

#[test]
fn empty_fanout_group_behaves_like_linear_step() {
    let steps = vec![SequentialGraphStepDefinition {
        id: "first".to_owned(),
        context_from: None,
        retry: None,
        fanout_group: Some(String::new()),
    }];
    let state = SequentialGraphState {
        graph_id: "graph".to_owned(),
        status: GraphStatus::Pending,
        steps: vec![SequentialGraphStepState {
            step_id: "first".to_owned(),
            status: GraphStepStatus::Pending,
            attempts: 0,
            started_at: None,
            completed_at: None,
            receipt_id: None,
            outputs: None,
            error: None,
        }],
    };

    let plan = plan_sequential_graph_transition(&state, &steps, &BTreeMap::new(), None);

    assert_eq!(
        plan,
        SequentialGraphPlan::RunStep {
            step_id: "first".to_owned(),
            attempt: 1,
            context_from: Vec::new(),
        }
    );
}

fn threshold_policy(above: JsonNumber) -> FanoutGroupPolicy {
    FanoutGroupPolicy {
        group_id: "risk".to_owned(),
        strategy: FanoutSyncStrategy::All,
        min_success: None,
        on_branch_failure: FanoutBranchFailurePolicy::Halt,
        threshold_gates: Some(vec![FanoutThresholdGate {
            step: "risk".to_owned(),
            field: "risk_score".to_owned(),
            above,
            action: FanoutGateAction::Pause,
        }]),
        conflict_gates: None,
    }
}

fn threshold_result(value: JsonNumber) -> FanoutBranchResult {
    FanoutBranchResult {
        step_id: "risk".to_owned(),
        status: GraphStepStatus::Succeeded,
        outputs: Some(
            [("risk_score".to_owned(), JsonValue::Number(value))]
                .into_iter()
                .collect(),
        ),
    }
}

fn single_step_state() -> impl Strategy<Value = SingleStepState> {
    (
        safe_string(),
        step_status(),
        prop::option::of(safe_string()),
        prop::option::of(safe_string()),
        prop::option::of(safe_string()),
    )
        .prop_map(
            |(step_id, status, started_at, completed_at, error)| SingleStepState {
                step_id,
                status,
                started_at,
                completed_at,
                error,
            },
        )
}

fn single_step_event() -> impl Strategy<Value = SingleStepEvent> {
    prop_oneof![
        Just(SingleStepEvent::Admit),
        safe_string().prop_map(|at| SingleStepEvent::Start { at }),
        (safe_string(), safe_string(), safe_string()).prop_map(|(at, step_id, receipt_id)| {
            SingleStepEvent::Succeed {
                at,
                admission_witness: Box::new(StepAdmissionWitness::local_runtime(
                    step_id, receipt_id,
                )),
            }
        }),
        (safe_string(), safe_string()).prop_map(|(at, error)| SingleStepEvent::Fail { at, error }),
    ]
}

fn sequential_graph_state() -> impl Strategy<Value = SequentialGraphState> {
    (
        safe_string(),
        graph_status(),
        prop::collection::vec(sequential_step_state(), 1..4),
    )
        .prop_map(|(graph_id, status, steps)| SequentialGraphState {
            graph_id,
            status,
            steps,
        })
}

fn sequential_step_state() -> impl Strategy<Value = SequentialGraphStepState> {
    (
        safe_string(),
        graph_step_status(),
        0_u32..4,
        prop::option::of(safe_string()),
        prop::option::of(safe_string()),
        prop::option::of(safe_string()),
        prop::option::of(safe_string()),
    )
        .prop_map(
            |(step_id, status, attempts, started_at, completed_at, receipt_id, error)| {
                SequentialGraphStepState {
                    step_id,
                    status,
                    attempts,
                    started_at,
                    completed_at,
                    receipt_id,
                    outputs: None,
                    error,
                }
            },
        )
}

fn sequential_graph_event() -> impl Strategy<Value = SequentialGraphEvent> {
    prop_oneof![
        (safe_string(), safe_string())
            .prop_map(|(step_id, at)| { SequentialGraphEvent::StartStep { step_id, at } }),
        (safe_string(), safe_string(), safe_string()).prop_map(|(step_id, at, receipt_id)| {
            SequentialGraphEvent::StepSucceeded {
                admission_witness: Box::new(StepAdmissionWitness::local_runtime(
                    &step_id,
                    &receipt_id,
                )),
                step_id,
                at,
                receipt_id,
                outputs: None,
            }
        }),
        (safe_string(), safe_string(), safe_string()).prop_map(|(step_id, at, error)| {
            SequentialGraphEvent::StepFailed { step_id, at, error }
        }),
        Just(SequentialGraphEvent::Complete),
        safe_string().prop_map(|reason| SequentialGraphEvent::PauseGraph { reason }),
        safe_string().prop_map(|reason| SequentialGraphEvent::EscalateGraph { reason }),
        safe_string().prop_map(|error| SequentialGraphEvent::FailGraph { error }),
    ]
}

fn step_status() -> impl Strategy<Value = StepStatus> {
    prop_oneof![
        Just(StepStatus::Pending),
        Just(StepStatus::Admitted),
        Just(StepStatus::Running),
        Just(StepStatus::Succeeded),
        Just(StepStatus::Failed),
    ]
}

fn graph_status() -> impl Strategy<Value = GraphStatus> {
    prop_oneof![
        Just(GraphStatus::Pending),
        Just(GraphStatus::Running),
        Just(GraphStatus::Succeeded),
        Just(GraphStatus::Failed),
        Just(GraphStatus::Paused),
        Just(GraphStatus::Escalated),
    ]
}

fn graph_step_status() -> impl Strategy<Value = GraphStepStatus> {
    prop_oneof![
        Just(GraphStepStatus::Pending),
        Just(GraphStepStatus::Running),
        Just(GraphStepStatus::Succeeded),
        Just(GraphStepStatus::Failed),
    ]
}

fn fanout_sync_decision() -> impl Strategy<Value = FanoutSyncDecision> {
    (
        safe_string(),
        fanout_sync_outcome(),
        fanout_sync_strategy(),
        safe_string(),
        safe_string(),
        0_usize..8,
        0_usize..8,
        0_usize..8,
        0_usize..8,
    )
        .prop_map(
            |(
                group_id,
                decision,
                strategy,
                rule_fired,
                reason,
                branch_count,
                success_count,
                failure_count,
                required_successes,
            )| {
                FanoutSyncDecision {
                    group_id,
                    decision,
                    strategy,
                    rule_fired,
                    reason,
                    branch_count,
                    success_count,
                    failure_count,
                    required_successes,
                    gate: None,
                }
            },
        )
}

fn fanout_sync_outcome() -> impl Strategy<Value = FanoutSyncOutcome> {
    prop_oneof![
        Just(FanoutSyncOutcome::Proceed),
        Just(FanoutSyncOutcome::Halt),
        Just(FanoutSyncOutcome::Pause),
        Just(FanoutSyncOutcome::Escalate),
    ]
}

fn fanout_sync_strategy() -> impl Strategy<Value = FanoutSyncStrategy> {
    prop_oneof![
        Just(FanoutSyncStrategy::All),
        Just(FanoutSyncStrategy::Any),
        Just(FanoutSyncStrategy::Quorum),
    ]
}

fn safe_string() -> impl Strategy<Value = String> {
    (0_u8..26, prop::collection::vec(0_u8..37, 0..12)).prop_map(|(first, rest)| {
        let mut output = String::with_capacity(rest.len() + 1);
        output.push((b'a' + first) as char);
        for value in rest {
            output.push(safe_char(value));
        }
        output
    })
}

fn test_case_error(error: serde_json::Error) -> TestCaseError {
    TestCaseError::fail(error.to_string())
}

fn safe_char(value: u8) -> char {
    match value {
        0..=25 => (b'a' + value) as char,
        26..=35 => (b'0' + (value - 26)) as char,
        _ => '_',
    }
}

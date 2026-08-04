use std::collections::BTreeSet;

use super::types::{
    FanoutBranchFailurePolicy, FanoutBranchResult, FanoutGate, FanoutGroupPolicy,
    FanoutSyncDecision, FanoutSyncOutcome, FanoutSyncStrategy, GraphStepStatus,
};

mod conflict;
mod threshold;
mod values;

use conflict::conflict_decision;
use threshold::threshold_decision;

#[must_use]
pub fn fanout_sync_decision_key(group_id: &str, rule_fired: &str) -> String {
    format!("{group_id}:{rule_fired}")
}

#[must_use]
pub fn evaluate_fanout_sync(
    policy: &FanoutGroupPolicy,
    results: &[FanoutBranchResult],
    resolved_gate_keys: Option<&BTreeSet<String>>,
) -> FanoutSyncDecision {
    let counts = Counts::from_results(policy, results);

    if policy.on_branch_failure == FanoutBranchFailurePolicy::Halt && counts.failure_count > 0 {
        return branch_failure_decision(policy, counts);
    }

    if let Some(decision) = threshold_decision(policy, results, resolved_gate_keys, counts) {
        return decision;
    }

    if let Some(decision) = conflict_decision(policy, results, resolved_gate_keys, counts) {
        return decision;
    }

    if counts.success_count >= counts.required_successes {
        return quorum_decision(policy, FanoutSyncOutcome::Proceed, counts);
    }

    quorum_decision(policy, FanoutSyncOutcome::Halt, counts)
}

pub(super) fn evaluate_fanout_sync_without_gates(
    policy: &FanoutGroupPolicy,
    branch_count: usize,
    success_count: usize,
    failure_count: usize,
) -> FanoutSyncDecision {
    debug_assert!(
        policy.threshold_gates.as_ref().is_none_or(Vec::is_empty)
            && policy.conflict_gates.as_ref().is_none_or(Vec::is_empty)
    );
    let counts = Counts::new(
        branch_count,
        success_count,
        failure_count,
        required_success_count(policy, branch_count),
    );
    if policy.on_branch_failure == FanoutBranchFailurePolicy::Halt && failure_count > 0 {
        return branch_failure_decision(policy, counts);
    }
    let outcome = gate_free_fanout_outcome(policy, branch_count, success_count, failure_count);
    quorum_decision(policy, outcome, counts)
}

pub(super) fn gate_free_fanout_outcome(
    policy: &FanoutGroupPolicy,
    branch_count: usize,
    success_count: usize,
    failure_count: usize,
) -> FanoutSyncOutcome {
    if policy.on_branch_failure == FanoutBranchFailurePolicy::Halt && failure_count > 0 {
        return FanoutSyncOutcome::Halt;
    }
    if success_count >= required_success_count(policy, branch_count) {
        FanoutSyncOutcome::Proceed
    } else {
        FanoutSyncOutcome::Halt
    }
}

fn branch_failure_decision(policy: &FanoutGroupPolicy, counts: Counts) -> FanoutSyncDecision {
    sync_decision(
        policy,
        FanoutSyncOutcome::Halt,
        "quorum",
        counts,
        DecisionDetails::new(
            "branch_failure.halt",
            format!(
                "{}/{} branches failed and on_branch_failure is halt",
                counts.failure_count, counts.branch_count
            ),
        ),
    )
}

fn quorum_decision(
    policy: &FanoutGroupPolicy,
    outcome: FanoutSyncOutcome,
    counts: Counts,
) -> FanoutSyncDecision {
    sync_decision(
        policy,
        outcome,
        "quorum",
        counts,
        DecisionDetails::new(
            format!("{}.min_success", strategy_name(&policy.strategy)),
            format!(
                "{}/{} branches succeeded; required {}",
                counts.success_count, counts.branch_count, counts.required_successes
            ),
        ),
    )
}

#[derive(Clone, Copy)]
struct Counts {
    branch_count: usize,
    success_count: usize,
    failure_count: usize,
    required_successes: usize,
}

impl Counts {
    fn from_results(policy: &FanoutGroupPolicy, results: &[FanoutBranchResult]) -> Self {
        let branch_count = results.len();
        let success_count = results
            .iter()
            .filter(|result| result.status == GraphStepStatus::Succeeded)
            .count();
        let failure_count = results
            .iter()
            .filter(|result| result.status == GraphStepStatus::Failed)
            .count();
        let required_successes = required_success_count(policy, branch_count);

        Self::new(
            branch_count,
            success_count,
            failure_count,
            required_successes,
        )
    }

    fn new(
        branch_count: usize,
        success_count: usize,
        failure_count: usize,
        required_successes: usize,
    ) -> Self {
        Self {
            branch_count,
            success_count,
            failure_count,
            required_successes,
        }
    }
}

struct DecisionDetails {
    rule_fired: String,
    reason: String,
    gate: Option<FanoutGate>,
}

impl DecisionDetails {
    fn new(rule_fired: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            rule_fired: rule_fired.into(),
            reason: reason.into(),
            gate: None,
        }
    }

    fn with_gate(mut self, gate: FanoutGate) -> Self {
        self.gate = Some(gate);
        self
    }
}

fn is_resolved(
    decision: &FanoutSyncDecision,
    resolved_gate_keys: Option<&BTreeSet<String>>,
) -> bool {
    resolved_gate_keys.is_some_and(|keys| {
        keys.contains(&fanout_sync_decision_key(
            &decision.group_id,
            &decision.rule_fired,
        ))
    })
}

fn sync_decision(
    policy: &FanoutGroupPolicy,
    decision: FanoutSyncOutcome,
    _type: &str,
    counts: Counts,
    details: DecisionDetails,
) -> FanoutSyncDecision {
    FanoutSyncDecision {
        group_id: policy.group_id.clone(),
        decision,
        strategy: policy.strategy.clone(),
        rule_fired: details.rule_fired,
        reason: details.reason,
        branch_count: counts.branch_count,
        success_count: counts.success_count,
        failure_count: counts.failure_count,
        required_successes: counts.required_successes,
        gate: details.gate,
    }
}

fn required_success_count(policy: &FanoutGroupPolicy, branch_count: usize) -> usize {
    match policy.strategy {
        FanoutSyncStrategy::All => branch_count,
        FanoutSyncStrategy::Any => 1,
        FanoutSyncStrategy::Quorum => policy
            .min_success
            .map_or(branch_count, |value| value as usize),
    }
}

fn strategy_name(strategy: &FanoutSyncStrategy) -> &'static str {
    match strategy {
        FanoutSyncStrategy::All => "all",
        FanoutSyncStrategy::Any => "any",
        FanoutSyncStrategy::Quorum => "quorum",
    }
}

#[cfg(test)]
mod tests {
    use super::{evaluate_fanout_sync, evaluate_fanout_sync_without_gates};
    use crate::state_machine::{
        FanoutBranchFailurePolicy, FanoutBranchResult, FanoutGroupPolicy, FanoutSyncStrategy,
        GraphStepStatus,
    };

    #[test]
    fn gate_free_count_path_matches_the_canonical_evaluator() {
        let status_sets = [
            vec![GraphStepStatus::Succeeded, GraphStepStatus::Succeeded],
            vec![GraphStepStatus::Succeeded, GraphStepStatus::Failed],
            vec![GraphStepStatus::Failed, GraphStepStatus::Failed],
            vec![
                GraphStepStatus::Succeeded,
                GraphStepStatus::Pending,
                GraphStepStatus::Running,
                GraphStepStatus::Skipped,
            ],
            Vec::new(),
        ];
        for strategy in [
            FanoutSyncStrategy::All,
            FanoutSyncStrategy::Any,
            FanoutSyncStrategy::Quorum,
        ] {
            for on_branch_failure in [
                FanoutBranchFailurePolicy::Halt,
                FanoutBranchFailurePolicy::Continue,
            ] {
                let policy = FanoutGroupPolicy {
                    group_id: "workers".to_owned(),
                    min_success: (strategy == FanoutSyncStrategy::Quorum).then_some(2),
                    strategy: strategy.clone(),
                    on_branch_failure,
                    threshold_gates: None,
                    conflict_gates: None,
                };
                for statuses in &status_sets {
                    let results = statuses
                        .iter()
                        .enumerate()
                        .map(|(index, status)| FanoutBranchResult {
                            step_id: format!("branch_{index}"),
                            status: status.clone(),
                            outputs: None,
                        })
                        .collect::<Vec<_>>();
                    let success_count = statuses
                        .iter()
                        .filter(|status| **status == GraphStepStatus::Succeeded)
                        .count();
                    let failure_count = statuses
                        .iter()
                        .filter(|status| **status == GraphStepStatus::Failed)
                        .count();

                    assert_eq!(
                        evaluate_fanout_sync_without_gates(
                            &policy,
                            statuses.len(),
                            success_count,
                            failure_count,
                        ),
                        evaluate_fanout_sync(&policy, &results, None),
                        "strategy={strategy:?} failure_policy={:?} statuses={statuses:?}",
                        policy.on_branch_failure,
                    );
                }
            }
        }
    }
}

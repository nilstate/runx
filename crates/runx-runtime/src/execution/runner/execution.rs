// rust-style-allow: large-file because graph execution keeps step planning,
// fanout synchronization, and checkpoint emission together while Rust remains
// the parity implementation for the existing execution contract.
use std::collections::BTreeMap;
use std::path::Path;
use std::thread;

use runx_contracts::{ExecutionEvent, FanoutReceiptSyncPoint, JsonValue};
use runx_core::state_machine::{
    FanoutBranchResult, FanoutGroupPolicy, FanoutSyncDecision, FanoutSyncOutcome, GraphStepStatus,
    SequentialGraphEvent, SequentialGraphPlan, SequentialGraphState, apply_sequential_graph_event,
    create_sequential_graph_state, evaluate_fanout_sync,
};
use runx_parser::{ExecutionGraph, GraphStep};

use super::super::fanout::fanout_policies;
use super::super::graph::{LoadedStepSkill, StepSkillCache, StepSkillLoadOptions, find_step};
use super::super::graph_index::{ExecutionGraphIndex, PriorRunIndex};
use super::scheduler::{
    FanoutSchedule, FanoutScheduler, ParallelFanoutSchedule, ScheduledFanoutStep,
    parallel_safe_step_shape, scheduled_step,
};
use super::step_execution::{
    LoadedStepExecutionRequest, run_step_with_loaded_skill, run_step_with_loaded_skill_index,
};
use super::steps::{output_error, runtime_error_step_run};
use super::sync::{fanout_sync_point, latest_fanout_receipt_ids};
use super::{GraphCheckpoint, GraphRun, Runtime, RuntimeOptions, StepRun};
use crate::RuntimeError;
use crate::adapter::SkillAdapter;
use crate::host::{Host, NoopHost};
use crate::journal::ExecutionJournal;
use crate::lifecycle::LifecycleEvent;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StepFailureMode {
    Propagate,
    RecordAndContinue,
}

pub(super) struct GraphExecution {
    graph_index: ExecutionGraphIndex,
    step_skill_cache: StepSkillCache,
    state: SequentialGraphState,
    pub(super) runs: Vec<StepRun>,
    run_positions: BTreeMap<String, usize>,
    pub(super) sync_points: Vec<FanoutReceiptSyncPoint>,
    journal: ExecutionJournal,
}

pub(super) struct FanoutRunPlan {
    group_id: String,
    step_ids: Vec<String>,
    attempts: BTreeMap<String, u32>,
}

struct ParallelStepRun {
    sequence: usize,
    step_id: String,
    attempt: u32,
    run: StepRun,
}

struct ParallelFanoutJob<'a> {
    sequence: usize,
    step_id: String,
    attempt: u32,
    step: &'a GraphStep,
    loaded_skill: Option<LoadedStepSkill>,
}

#[derive(Clone, Copy)]
pub(super) struct StepExecutionPlan<'a> {
    step_id: &'a str,
    attempt: u32,
    failure_mode: StepFailureMode,
}

const DISABLE_RUNTIME_INDEXES_ENV: &str = "RUNX_RUNTIME_DISABLE_INDEXES";

impl GraphExecution {
    pub(super) fn new(graph: &ExecutionGraph) -> Self {
        let definitions = super::super::graph::step_definitions(graph);
        let state = create_sequential_graph_state(graph.name.clone(), &definitions);
        let graph_index = ExecutionGraphIndex::new(graph, definitions);
        Self {
            graph_index,
            step_skill_cache: StepSkillCache::default(),
            state,
            runs: Vec::new(),
            run_positions: BTreeMap::new(),
            sync_points: Vec::new(),
            journal: ExecutionJournal::default(),
        }
    }

    pub(super) fn from_checkpoint(
        graph: &ExecutionGraph,
        checkpoint: GraphCheckpoint,
    ) -> Result<Self, RuntimeError> {
        if checkpoint.graph_name != graph.name {
            return Err(RuntimeError::CheckpointGraphMismatch {
                checkpoint_graph: checkpoint.graph_name,
                graph: graph.name.clone(),
            });
        }
        let definitions = super::super::graph::step_definitions(graph);
        let graph_index = ExecutionGraphIndex::new(graph, definitions);
        let run_positions = run_positions(&checkpoint.steps);
        Ok(Self {
            graph_index,
            step_skill_cache: StepSkillCache::default(),
            state: checkpoint.state,
            runs: checkpoint.steps,
            run_positions,
            sync_points: checkpoint.sync_points,
            journal: checkpoint.journal,
        })
    }

    pub(super) fn run<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        host: &mut dyn Host,
        max_new_steps: Option<usize>,
    ) -> Result<(), RuntimeError>
    where
        A: SkillAdapter,
    {
        let fanout_policies = fanout_policies(graph);
        let initial_step_count = self.runs.len();
        loop {
            if reached_step_limit(initial_step_count, self.runs.len(), max_new_steps) {
                return Ok(());
            }
            self.mark_when_skipped_steps(graph, &runtime.options.created_at);
            let plan = self
                .graph_index
                .plan_transition(&self.state, &fanout_policies);
            if self.apply_plan(runtime, graph_dir, graph, host, &fanout_policies, plan)? {
                break;
            }
        }
        Ok(())
    }

    /// Mark every step whose `when` condition the runtime has resolved to false
    /// as `Skipped`, so the planner walks past it and graph completion treats it
    /// as terminal. Evaluated against the runs so far, so a branch is only
    /// selected out once the step it reads from has produced its output.
    fn mark_when_skipped_steps(&mut self, graph: &ExecutionGraph, at: &str) {
        for step_id in when_skipped_steps(graph, &self.runs) {
            let is_pending = self
                .state
                .steps
                .iter()
                .any(|step| step.step_id == step_id && step.status == GraphStepStatus::Pending);
            if is_pending {
                apply_sequential_graph_event(
                    &mut self.state,
                    &SequentialGraphEvent::StepSkipped {
                        step_id,
                        at: at.to_owned(),
                    },
                );
            }
        }
    }

    pub(super) fn apply_plan<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        host: &mut dyn Host,
        fanout_policies: &BTreeMap<String, FanoutGroupPolicy>,
        plan: SequentialGraphPlan,
    ) -> Result<bool, RuntimeError>
    where
        A: SkillAdapter,
    {
        match plan {
            SequentialGraphPlan::RunStep {
                step_id, attempt, ..
            } => self.apply_step_plan(runtime, graph_dir, graph, host, &step_id, attempt),
            SequentialGraphPlan::RunFanout {
                group_id,
                step_ids,
                attempts,
                ..
            } => {
                self.run_fanout_plan(
                    runtime,
                    graph_dir,
                    graph,
                    host,
                    fanout_policies,
                    FanoutRunPlan {
                        group_id,
                        step_ids,
                        attempts,
                    },
                )?;
                Ok(false)
            }
            SequentialGraphPlan::Complete => Ok(self.complete_graph()),
            SequentialGraphPlan::Blocked {
                step_id,
                reason,
                sync_decision,
            } => self.block_graph(graph, step_id, reason, sync_decision),
            SequentialGraphPlan::Failed {
                step_id,
                reason,
                sync_decision,
            } => self.fail_graph(graph, step_id, reason, sync_decision),
            SequentialGraphPlan::Paused {
                step_id,
                reason,
                sync_decision,
            } => self.pause_for_sync(graph, step_id, reason, sync_decision),
            SequentialGraphPlan::Escalated {
                step_id,
                reason,
                sync_decision,
            } => self.escalate_for_sync(graph, step_id, reason, sync_decision),
        }
    }

    pub(super) fn apply_step_plan<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        host: &mut dyn Host,
        step_id: &str,
        attempt: u32,
    ) -> Result<bool, RuntimeError>
    where
        A: SkillAdapter,
    {
        self.run_one_step(runtime, graph_dir, graph, step_id, attempt, host)?;
        Ok(false)
    }

    pub(super) fn complete_graph(&mut self) -> bool {
        apply_sequential_graph_event(&mut self.state, &SequentialGraphEvent::Complete);
        true
    }

    pub(super) fn run_fanout_plan<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        host: &mut dyn Host,
        fanout_policies: &BTreeMap<String, FanoutGroupPolicy>,
        plan: FanoutRunPlan,
    ) -> Result<(), RuntimeError>
    where
        A: SkillAdapter,
    {
        if runtime
            .options
            .env
            .contains_key(DISABLE_RUNTIME_INDEXES_ENV)
        {
            self.run_serial_fanout_steps(
                runtime,
                graph_dir,
                graph,
                host,
                &plan.step_ids,
                &plan.attempts,
            )?;
            return self.record_proceeding_fanout_sync_point(
                graph,
                fanout_policies,
                &plan.group_id,
            );
        }

        let scheduler = FanoutScheduler::from_env(&runtime.options.env);
        let steps =
            self.scheduled_fanout_steps(runtime, graph_dir, graph, &plan.step_ids, &plan.attempts)?;
        match scheduler.schedule(steps) {
            FanoutSchedule::Serial(steps) => {
                self.run_scheduled_fanout_steps(runtime, graph_dir, graph, host, steps)?;
            }
            FanoutSchedule::Parallel(schedule) => {
                self.run_parallel_fanout_steps(runtime, graph_dir, graph, host, schedule)?;
            }
        }
        self.record_proceeding_fanout_sync_point(graph, fanout_policies, &plan.group_id)
    }

    fn run_serial_fanout_steps<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        host: &mut dyn Host,
        step_ids: &[String],
        attempts: &BTreeMap<String, u32>,
    ) -> Result<(), RuntimeError>
    where
        A: SkillAdapter,
    {
        let steps = step_ids
            .iter()
            .map(|step_id| ScheduledFanoutStep {
                step_id,
                attempt: attempts.get(step_id).copied().unwrap_or(1),
                can_run_parallel: false,
            })
            .collect();
        self.run_scheduled_fanout_steps(runtime, graph_dir, graph, host, steps)
    }

    fn scheduled_fanout_steps<'a, A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        step_ids: &'a [String],
        attempts: &'a BTreeMap<String, u32>,
    ) -> Result<Vec<ScheduledFanoutStep<'a>>, RuntimeError>
    where
        A: SkillAdapter,
    {
        step_ids
            .iter()
            .map(|step_id| {
                let step = self.find_step(graph, step_id)?;
                Ok(scheduled_step(
                    step_id,
                    attempts,
                    self.can_run_parallel_fanout_step(runtime, graph_dir, step),
                ))
            })
            .collect()
    }

    fn can_run_parallel_fanout_step<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        step: &GraphStep,
    ) -> bool
    where
        A: SkillAdapter,
    {
        if !parallel_safe_step_shape(step, &runtime.options().effects) {
            return false;
        }
        let Ok(Some(skill)) = self.cached_step_skill(runtime, graph_dir, step) else {
            return false;
        };
        runtime.adapter.fanout_execution_mode(&skill.source)
            == crate::adapter::FanoutExecutionMode::IsolatedParallel
    }

    fn run_scheduled_fanout_steps<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        host: &mut dyn Host,
        steps: Vec<ScheduledFanoutStep<'_>>,
    ) -> Result<(), RuntimeError>
    where
        A: SkillAdapter,
    {
        for step in steps {
            self.run_one_step_with_mode(
                runtime,
                graph_dir,
                graph,
                host,
                StepExecutionPlan {
                    step_id: step.step_id,
                    attempt: step.attempt,
                    failure_mode: StepFailureMode::RecordAndContinue,
                },
            )?;
        }
        Ok(())
    }

    fn run_parallel_fanout_steps<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        host: &mut dyn Host,
        schedule: ParallelFanoutSchedule<'_>,
    ) -> Result<(), RuntimeError>
    where
        A: SkillAdapter,
    {
        for scheduled in &schedule.steps {
            let step = self.find_step(graph, scheduled.step_id)?;
            enforce_guards(graph, step, &self.runs)?;
        }
        for scheduled in &schedule.steps {
            self.record_lifecycle(host, LifecycleEvent::step_started(scheduled.step_id))?;
            self.start_step(runtime, scheduled.step_id);
        }

        let results = self.execute_parallel_fanout_steps(
            runtime,
            graph_dir,
            graph,
            &schedule.steps,
            schedule.max_concurrency,
        )?;
        for result in results {
            self.commit_step_run(
                runtime,
                host,
                StepExecutionPlan {
                    step_id: &result.step_id,
                    attempt: result.attempt,
                    failure_mode: StepFailureMode::RecordAndContinue,
                },
                result.run,
                false,
            )?;
        }
        Ok(())
    }

    fn execute_parallel_fanout_steps<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        steps: &[ScheduledFanoutStep<'_>],
        max_concurrency: usize,
    ) -> Result<Vec<ParallelStepRun>, RuntimeError>
    where
        A: SkillAdapter,
    {
        let mut results = Vec::with_capacity(steps.len());
        let chunk_size = max_concurrency.max(1);
        for (chunk_index, chunk) in steps.chunks(chunk_size).enumerate() {
            let mut chunk_results = self.execute_parallel_fanout_batch(
                runtime,
                graph_dir,
                graph,
                chunk,
                chunk_index * chunk_size,
            )?;
            results.append(&mut chunk_results);
        }
        results.sort_by_key(|result| result.sequence);
        Ok(results)
    }

    fn execute_parallel_fanout_batch<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        steps: &[ScheduledFanoutStep<'_>],
        sequence_base: usize,
    ) -> Result<Vec<ParallelStepRun>, RuntimeError>
    where
        A: SkillAdapter,
    {
        let jobs = self.parallel_fanout_jobs(runtime, graph_dir, graph, steps, sequence_base)?;
        let runs = &self.runs;
        let run_positions = &self.run_positions;
        thread::scope(|scope| {
            let mut handles = Vec::with_capacity(jobs.len());
            for job in jobs {
                let adapter = runtime.adapter.clone_for_fanout().ok_or_else(|| {
                    RuntimeError::UnsupportedAdapter {
                        adapter_type: format!("{} parallel fanout", runtime.adapter.adapter_type()),
                    }
                })?;
                let options = runtime.options.clone();
                let graph_name = graph.name.as_str();
                handles.push(scope.spawn(move || {
                    let run = execute_parallel_fanout_step(ParallelFanoutStepExecution {
                        adapter,
                        options,
                        graph_dir,
                        graph_name,
                        step: job.step,
                        attempt: job.attempt,
                        loaded_skill: job.loaded_skill,
                        prior_runs: runs,
                        run_positions,
                    })?;
                    Ok::<ParallelStepRun, RuntimeError>(ParallelStepRun {
                        sequence: job.sequence,
                        step_id: job.step_id,
                        attempt: job.attempt,
                        run,
                    })
                }));
            }
            join_parallel_fanout_handles(handles)
        })
    }

    fn parallel_fanout_jobs<'a>(
        &mut self,
        runtime: &Runtime<impl SkillAdapter>,
        graph_dir: &Path,
        graph: &'a ExecutionGraph,
        steps: &[ScheduledFanoutStep<'_>],
        sequence_base: usize,
    ) -> Result<Vec<ParallelFanoutJob<'a>>, RuntimeError> {
        steps
            .iter()
            .enumerate()
            .map(|(offset, scheduled)| {
                let step = self.find_step(graph, scheduled.step_id)?;
                Ok(ParallelFanoutJob {
                    sequence: sequence_base + offset,
                    step_id: scheduled.step_id.to_owned(),
                    attempt: scheduled.attempt,
                    step,
                    loaded_skill: self.cached_step_skill(runtime, graph_dir, step)?,
                })
            })
            .collect()
    }

    pub(super) fn block_graph(
        &mut self,
        graph: &ExecutionGraph,
        step_id: String,
        reason: String,
        sync_decision: Option<FanoutSyncDecision>,
    ) -> Result<bool, RuntimeError> {
        if let Some(sync_decision) = sync_decision {
            self.push_sync_point(graph, &sync_decision)?;
        }
        Err(RuntimeError::GraphBlocked { step_id, reason })
    }

    pub(super) fn fail_graph(
        &mut self,
        graph: &ExecutionGraph,
        step_id: String,
        reason: String,
        sync_decision: Option<FanoutSyncDecision>,
    ) -> Result<bool, RuntimeError> {
        if let Some(sync_decision) = sync_decision {
            self.push_sync_point(graph, &sync_decision)?;
        }
        apply_sequential_graph_event(
            &mut self.state,
            &SequentialGraphEvent::FailGraph {
                error: reason.clone(),
            },
        );
        Err(RuntimeError::GraphPlanningFailed { step_id, reason })
    }

    pub(super) fn pause_graph(
        &mut self,
        step_id: String,
        reason: String,
        sync_decision: runx_core::state_machine::FanoutSyncDecision,
    ) -> Result<bool, RuntimeError> {
        apply_sequential_graph_event(
            &mut self.state,
            &SequentialGraphEvent::PauseGraph {
                reason: reason.clone(),
            },
        );
        Err(RuntimeError::GraphPaused {
            step_id,
            reason,
            sync_decision: Box::new(sync_decision),
        })
    }

    pub(super) fn pause_for_sync(
        &mut self,
        graph: &ExecutionGraph,
        step_id: String,
        reason: String,
        sync_decision: FanoutSyncDecision,
    ) -> Result<bool, RuntimeError> {
        self.push_sync_point(graph, &sync_decision)?;
        self.pause_graph(step_id, reason, sync_decision)
    }

    pub(super) fn escalate_graph(
        &mut self,
        step_id: String,
        reason: String,
        sync_decision: runx_core::state_machine::FanoutSyncDecision,
    ) -> Result<bool, RuntimeError> {
        apply_sequential_graph_event(
            &mut self.state,
            &SequentialGraphEvent::EscalateGraph {
                reason: reason.clone(),
            },
        );
        Err(RuntimeError::GraphEscalated {
            step_id,
            reason,
            sync_decision: Box::new(sync_decision),
        })
    }

    pub(super) fn escalate_for_sync(
        &mut self,
        graph: &ExecutionGraph,
        step_id: String,
        reason: String,
        sync_decision: FanoutSyncDecision,
    ) -> Result<bool, RuntimeError> {
        self.push_sync_point(graph, &sync_decision)?;
        self.escalate_graph(step_id, reason, sync_decision)
    }

    pub(super) fn run_one_step<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        step_id: &str,
        attempt: u32,
        host: &mut dyn Host,
    ) -> Result<(), RuntimeError>
    where
        A: SkillAdapter,
    {
        self.run_one_step_with_mode(
            runtime,
            graph_dir,
            graph,
            host,
            StepExecutionPlan {
                step_id,
                attempt,
                failure_mode: StepFailureMode::Propagate,
            },
        )
    }

    pub(super) fn run_one_step_with_mode<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        host: &mut dyn Host,
        plan: StepExecutionPlan<'_>,
    ) -> Result<(), RuntimeError>
    where
        A: SkillAdapter,
    {
        let step = self.find_step(graph, plan.step_id)?;
        enforce_guards(graph, step, &self.runs)?;
        let retry_remaining = retry_budget_remaining(step, plan.attempt);
        self.record_lifecycle(host, LifecycleEvent::step_started(plan.step_id))?;
        self.start_step(runtime, plan.step_id);
        let run = self.execute_step_plan(runtime, graph_dir, graph, step, host, plan)?;
        self.commit_step_run(runtime, host, plan, run, retry_remaining)
    }

    fn execute_step_plan<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        step: &GraphStep,
        host: &mut dyn Host,
        plan: StepExecutionPlan<'_>,
    ) -> Result<StepRun, RuntimeError>
    where
        A: SkillAdapter,
    {
        let run_result = if runtime
            .options
            .env
            .contains_key(DISABLE_RUNTIME_INDEXES_ENV)
        {
            self.execute_step_without_index(runtime, graph_dir, graph, step, host, plan)
        } else {
            self.execute_step_with_index(runtime, graph_dir, graph, step, host, plan)
        };
        Ok(match run_result {
            Ok(run) => run,
            Err(error) if plan.failure_mode == StepFailureMode::RecordAndContinue => {
                runtime_error_step_run(runtime, &graph.name, step, plan.attempt, error)?
            }
            Err(error) => return Err(error),
        })
    }

    fn execute_step_without_index<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        step: &GraphStep,
        host: &mut dyn Host,
        plan: StepExecutionPlan<'_>,
    ) -> Result<StepRun, RuntimeError>
    where
        A: SkillAdapter,
    {
        let loaded_skill = self.cached_step_skill(runtime, graph_dir, step)?;
        run_step_with_loaded_skill(
            LoadedStepExecutionRequest {
                runtime,
                graph_dir,
                graph_name: &graph.name,
                step,
                attempt: plan.attempt,
                loaded_skill,
                host,
            },
            &self.runs,
        )
    }

    fn execute_step_with_index<A>(
        &mut self,
        runtime: &Runtime<A>,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        step: &GraphStep,
        host: &mut dyn Host,
        plan: StepExecutionPlan<'_>,
    ) -> Result<StepRun, RuntimeError>
    where
        A: SkillAdapter,
    {
        let loaded_skill = self.cached_step_skill(runtime, graph_dir, step)?;
        let prior_run_index = PriorRunIndex::from_positions(&self.runs, &self.run_positions);
        run_step_with_loaded_skill_index(
            LoadedStepExecutionRequest {
                runtime,
                graph_dir,
                graph_name: &graph.name,
                step,
                attempt: plan.attempt,
                loaded_skill,
                host,
            },
            &prior_run_index,
        )
    }

    fn commit_step_run<A>(
        &mut self,
        runtime: &Runtime<A>,
        host: &mut dyn Host,
        plan: StepExecutionPlan<'_>,
        run: StepRun,
        retry_remaining: bool,
    ) -> Result<(), RuntimeError>
    where
        A: SkillAdapter,
    {
        if run.output.succeeded() {
            self.succeed_step(runtime, plan.step_id, &run);
            self.push_run(run);
            self.record_lifecycle(host, LifecycleEvent::step_completed(plan.step_id))
        } else {
            self.fail_step(runtime, plan.step_id, &run);
            host.log(format!("step {} failed", plan.step_id))?;
            self.record_lifecycle(host, LifecycleEvent::step_failed(plan.step_id))?;
            let terminal =
                plan.failure_mode != StepFailureMode::RecordAndContinue && !retry_remaining;
            // runx must never swallow a step error. A cli-tool failure reports
            // detail on stderr, but the governed HTTP front captures a non-2xx
            // response body on stdout with the status in metadata. Prefer stderr,
            // then fall back to the status and body so the message is never empty.
            let message = if run.output.stderr.trim().is_empty() {
                let status = run
                    .output
                    .metadata
                    .get("http_status")
                    .and_then(|value| value.as_str())
                    .map(|status| format!("status {status}: "))
                    .unwrap_or_default();
                let body = run.output.stdout.trim();
                if body.is_empty() {
                    format!("{status}step failed with no error output")
                } else {
                    format!("{status}{body}")
                }
            } else {
                run.output.stderr.clone()
            };
            // The failed run is recorded even on terminal failure so the run
            // list agrees with the journal's StepFailed event; a failed attempt
            // must never be silently absent from the execution record.
            self.push_run(run);
            if terminal {
                Err(RuntimeError::SkillFailed {
                    skill_name: plan.step_id.to_owned(),
                    message,
                })
            } else {
                Ok(())
            }
        }
    }

    fn push_run(&mut self, run: StepRun) {
        let index = self.runs.len();
        self.run_positions.insert(run.step_id.clone(), index);
        self.runs.push(run);
    }

    pub(super) fn start_step<A>(&mut self, runtime: &Runtime<A>, step_id: &str) {
        apply_sequential_graph_event(
            &mut self.state,
            &SequentialGraphEvent::StartStep {
                step_id: step_id.to_owned(),
                at: runtime.options.created_at.clone(),
            },
        );
    }

    pub(super) fn succeed_step<A>(&mut self, runtime: &Runtime<A>, step_id: &str, run: &StepRun) {
        apply_sequential_graph_event(
            &mut self.state,
            &SequentialGraphEvent::StepSucceeded {
                step_id: step_id.to_owned(),
                at: runtime.options.created_at.clone(),
                receipt_id: run.receipt.id.to_string(),
                admission_witness: Box::new(run.admission_witness.clone()),
                outputs: Some(run.outputs.clone()),
            },
        );
    }

    pub(super) fn fail_step<A>(&mut self, runtime: &Runtime<A>, step_id: &str, run: &StepRun) {
        apply_sequential_graph_event(
            &mut self.state,
            &SequentialGraphEvent::StepFailed {
                step_id: step_id.to_owned(),
                at: runtime.options.created_at.clone(),
                error: output_error(run),
            },
        );
    }

    pub(super) fn record(
        &mut self,
        host: &mut dyn Host,
        event: ExecutionEvent,
    ) -> Result<(), RuntimeError> {
        self.journal.push(event.clone());
        host.report(event)
    }

    pub(super) fn record_lifecycle(
        &mut self,
        host: &mut dyn Host,
        event: LifecycleEvent,
    ) -> Result<(), RuntimeError> {
        self.record(host, event.into_execution_event())
    }

    pub(super) fn finish(
        self,
        graph: ExecutionGraph,
        receipt: runx_contracts::Receipt,
    ) -> GraphRun {
        GraphRun {
            graph,
            state: self.state,
            steps: self.runs,
            sync_points: self.sync_points,
            receipt,
            journal: self.journal,
        }
    }

    pub(super) fn checkpoint(self, graph_name: String) -> GraphCheckpoint {
        GraphCheckpoint {
            graph_name,
            state: self.state,
            steps: self.runs,
            sync_points: self.sync_points,
            journal: self.journal,
        }
    }

    pub(super) fn record_proceeding_fanout_sync_point(
        &mut self,
        graph: &ExecutionGraph,
        fanout_policies: &BTreeMap<String, FanoutGroupPolicy>,
        group_id: &str,
    ) -> Result<(), RuntimeError> {
        let follow_up = self
            .graph_index
            .plan_transition(&self.state, fanout_policies);
        if matches!(
            follow_up,
            SequentialGraphPlan::RunFanout {
                group_id: ref next_group_id,
                ..
            } if next_group_id == group_id
        ) {
            return Ok(());
        }

        let Some(policy) = fanout_policies.get(group_id) else {
            return Ok(());
        };
        let decision = evaluate_fanout_sync(
            policy,
            &self.branch_results(graph, group_id, fanout_policy_requires_outputs(policy)),
            None,
        );
        if decision.decision == FanoutSyncOutcome::Proceed {
            self.push_sync_point(graph, &decision)?;
        }
        Ok(())
    }

    pub(super) fn push_sync_point(
        &mut self,
        graph: &ExecutionGraph,
        decision: &FanoutSyncDecision,
    ) -> Result<(), RuntimeError> {
        let sync_point = fanout_sync_point(
            decision,
            &latest_fanout_receipt_ids(&self.runs, graph, &decision.group_id),
        );
        let already_recorded = self.sync_points.iter().any(|existing| {
            existing.group_id == sync_point.group_id
                && existing.rule_fired == sync_point.rule_fired
                && existing.decision == sync_point.decision
        });
        if !already_recorded {
            self.sync_points.push(sync_point);
        }
        Ok(())
    }

    pub(super) fn branch_results(
        &self,
        graph: &ExecutionGraph,
        group_id: &str,
        include_outputs: bool,
    ) -> Vec<FanoutBranchResult> {
        self.graph_index
            .branch_results(graph, &self.state, group_id, include_outputs)
    }

    fn cached_step_skill(
        &mut self,
        runtime: &Runtime<impl SkillAdapter>,
        graph_dir: &Path,
        step: &GraphStep,
    ) -> Result<Option<LoadedStepSkill>, RuntimeError> {
        if step.run.is_some() || step.tool.is_some() {
            return Ok(None);
        }
        self.step_skill_cache
            .load(
                graph_dir,
                step,
                StepSkillLoadOptions {
                    env: &runtime.options().env,
                },
            )
            .map(Some)
    }

    fn find_step<'a>(
        &self,
        graph: &'a ExecutionGraph,
        step_id: &str,
    ) -> Result<&'a GraphStep, RuntimeError> {
        self.graph_index
            .find_step(graph, step_id)
            .or_else(|_| find_step(graph, step_id))
    }
}

struct ParallelFanoutStepExecution<'a> {
    adapter: Box<dyn SkillAdapter + Send + Sync>,
    options: RuntimeOptions,
    graph_dir: &'a Path,
    graph_name: &'a str,
    step: &'a GraphStep,
    attempt: u32,
    loaded_skill: Option<LoadedStepSkill>,
    prior_runs: &'a [StepRun],
    run_positions: &'a BTreeMap<String, usize>,
}

fn execute_parallel_fanout_step(
    execution: ParallelFanoutStepExecution<'_>,
) -> Result<StepRun, RuntimeError> {
    let ParallelFanoutStepExecution {
        adapter,
        options,
        graph_dir,
        graph_name,
        step,
        attempt,
        loaded_skill,
        prior_runs,
        run_positions,
    } = execution;
    let runtime = Runtime::new(adapter, options);
    let prior_run_index = PriorRunIndex::from_positions(prior_runs, run_positions);
    let mut host = NoopHost;
    match run_step_with_loaded_skill_index(
        LoadedStepExecutionRequest {
            runtime: &runtime,
            graph_dir,
            graph_name,
            step,
            attempt,
            loaded_skill,
            host: &mut host,
        },
        &prior_run_index,
    ) {
        Ok(run) => Ok(run),
        Err(error) => runtime_error_step_run(&runtime, graph_name, step, attempt, error),
    }
}

fn join_parallel_fanout_handles(
    handles: Vec<thread::ScopedJoinHandle<'_, Result<ParallelStepRun, RuntimeError>>>,
) -> Result<Vec<ParallelStepRun>, RuntimeError> {
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        results.push(handle.join().map_err(|_| RuntimeError::SkillFailed {
            skill_name: "fanout".to_owned(),
            message: "parallel fanout worker panicked".to_owned(),
        })??);
    }
    Ok(results)
}

fn run_positions(runs: &[StepRun]) -> BTreeMap<String, usize> {
    let mut positions = BTreeMap::new();
    for (index, run) in runs.iter().enumerate() {
        positions.insert(run.step_id.clone(), index);
    }
    positions
}

fn retry_budget_remaining(step: &GraphStep, attempt: u32) -> bool {
    let max_attempts = step.retry.as_ref().map_or(1, |retry| {
        u32::try_from(retry.max_attempts).unwrap_or(u32::MAX)
    });
    attempt < max_attempts
}

fn fanout_policy_requires_outputs(policy: &FanoutGroupPolicy) -> bool {
    policy
        .threshold_gates
        .as_ref()
        .is_some_and(|gates| !gates.is_empty())
        || policy
            .conflict_gates
            .as_ref()
            .is_some_and(|gates| !gates.is_empty())
}

pub(super) fn reached_step_limit(
    initial: usize,
    current: usize,
    max_new_steps: Option<usize>,
) -> bool {
    max_new_steps.is_some_and(|max| current.saturating_sub(initial) >= max)
}

pub(super) fn enforce_guards(
    graph: &ExecutionGraph,
    step: &GraphStep,
    runs: &[StepRun],
) -> Result<(), RuntimeError> {
    let Some(policy) = &graph.policy else {
        return Ok(());
    };
    for gate in policy.guards.iter().filter(|gate| gate.step == step.id) {
        let Some(value) = transition_field_value(&gate.field, runs) else {
            return Err(RuntimeError::GraphBlocked {
                step_id: step.id.clone(),
                reason: format!("guard '{}' is unresolved", gate.field),
            });
        };
        if let Some(expected) = &gate.equals
            && value != expected
        {
            return Err(RuntimeError::GraphBlocked {
                step_id: step.id.clone(),
                reason: format!("guard '{}' expected {}", gate.field, display_json(expected)),
            });
        }
        if let Some(disallowed) = &gate.not_equals
            && value == disallowed
        {
            return Err(RuntimeError::GraphBlocked {
                step_id: step.id.clone(),
                reason: format!(
                    "guard '{}' must not equal {}",
                    gate.field,
                    display_json(disallowed)
                ),
            });
        }
        if gate.equals.is_none() && gate.not_equals.is_none() {
            return Err(RuntimeError::GraphBlocked {
                step_id: step.id.clone(),
                reason: format!("guard '{}' has no comparison", gate.field),
            });
        }
    }
    Ok(())
}

pub(super) fn transition_field_value<'a>(
    field: &str,
    runs: &'a [StepRun],
) -> Option<&'a JsonValue> {
    let mut segments = field.split('.');
    let step_id = segments.next()?;
    let run = runs.iter().rev().find(|run| run.step_id == step_id)?;
    let first = segments.next()?;
    if first == "skill_claim" {
        return None;
    }
    let mut value = run.outputs.get(first)?;
    for segment in segments {
        let JsonValue::Object(object) = value else {
            return None;
        };
        value = object.get(segment)?;
    }
    Some(value)
}

pub(super) fn display_json(value: &JsonValue) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "<unprintable>".to_owned())
}

/// Resolve which steps a `when` condition selects out, given the runs so far.
/// A step is skipped only when its `when` field is resolved and the condition
/// does not hold; an unresolved field leaves the step pending so a branch is
/// never skipped before the step it depends on has run.
pub(super) fn when_skipped_steps(
    graph: &ExecutionGraph,
    runs: &[StepRun],
) -> std::collections::BTreeSet<String> {
    let mut skipped = std::collections::BTreeSet::new();
    for step in &graph.steps {
        let Some(when) = &step.when else {
            continue;
        };
        let Some(value) = transition_field_value(&when.field, runs) else {
            continue;
        };
        let satisfied = match (&when.equals, &when.not_equals) {
            (Some(expected), _) => value == expected,
            (_, Some(disallowed)) => value != disallowed,
            _ => true,
        };
        if !satisfied {
            skipped.insert(step.id.clone());
        }
    }
    skipped
}

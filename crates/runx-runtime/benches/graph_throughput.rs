use std::collections::BTreeMap;
use std::hint::black_box;

use criterion::{Criterion, criterion_group, criterion_main};
use runx_contracts::{JsonObject, JsonValue};
use runx_core::state_machine::{
    FanoutBranchFailurePolicy, FanoutGroupPolicy, FanoutSyncStrategy, GraphStatus,
    SequentialGraphEvent, SequentialGraphPlan, SequentialGraphStepDefinition,
    SequentialGraphStepIndex, StepAdmissionWitness, apply_sequential_graph_event,
    create_sequential_graph_state, create_sequential_graph_step_index,
    plan_sequential_graph_transition_indexed,
};
use runx_runtime::{
    InvocationStatus, RuntimeOptions, SkillOutput, StepRun,
    receipts::{graph_receipt_with_signature_policy, step_receipt_with_signature_policy},
};
use tempfile::TempDir;

const CREATED_AT: &str = "2026-05-26T00:00:00Z";

fn bench_graph_throughput(c: &mut Criterion) {
    c.bench_function("graph_planning", |b| {
        let steps = sequential_steps(192);
        let step_index = create_sequential_graph_step_index(&steps);
        let policies = BTreeMap::new();
        b.iter(|| {
            drive_state_machine(
                black_box(&steps),
                black_box(&step_index),
                black_box(&policies),
            )
        })
    });

    c.bench_function("wide_fanout", |b| {
        let steps = fanout_steps(96);
        let step_index = create_sequential_graph_step_index(&steps);
        let policies = fanout_policies("wide", 96);
        b.iter(|| {
            drive_state_machine(
                black_box(&steps),
                black_box(&step_index),
                black_box(&policies),
            )
        })
    });

    c.bench_function("context_projection", |b| {
        let runs = synthetic_prior_runs(128);
        let edges = indexed_context_edges(128);
        b.iter(|| project_context(black_box(&runs), black_box(&edges)))
    });

    c.bench_function("output_projection", |b| {
        let output = skill_output(r#"{"answer":"ok","score":0.91,"nested":{"value":42}}"#);
        b.iter(|| project_output(black_box(&output)))
    });

    c.bench_function("graph_receipt_sealing", |b| {
        let options = RuntimeOptions {
            created_at: CREATED_AT.to_owned(),
            ..RuntimeOptions::local_development()
        };
        let template = synthetic_step_runs(&options, 32);
        b.iter(|| {
            let mut steps = black_box(template.clone());
            graph_receipt_with_signature_policy(
                "throughput_graph",
                &mut steps,
                Vec::new(),
                CREATED_AT,
                options.signature_policy(),
            )
            .map(|receipt| receipt.digest)
        })
    });

    c.bench_function("receipt_store_append", |b| {
        let options = RuntimeOptions {
            created_at: CREATED_AT.to_owned(),
            ..RuntimeOptions::local_development()
        };
        let receipts = synthetic_receipts(&options, 12);
        b.iter(|| append_receipts(black_box(&receipts)))
    });

    c.bench_function("receipt_store_index", |b| {
        let options = RuntimeOptions {
            created_at: CREATED_AT.to_owned(),
            ..RuntimeOptions::local_development()
        };
        let receipts = synthetic_receipts(&options, 12);
        let temp_dir = TempDir::new().map_err(|source| source.to_string());
        let temp_dir = match temp_dir {
            Ok(temp_dir) => temp_dir,
            Err(message) => return b.iter(|| Err::<usize, String>(message.clone())),
        };
        let store = runx_runtime::LocalReceiptStore::new(temp_dir.path().join("receipts"));
        for receipt in &receipts {
            if let Err(error) = store.write_receipt(receipt) {
                return b.iter(|| Err::<usize, String>(error.to_string()));
            }
        }
        b.iter(|| {
            store
                .rebuild_index()
                .map(|index| black_box(index.entries.len()))
                .map_err(|error| error.to_string())
        })
    });
}

fn sequential_steps(count: usize) -> Vec<SequentialGraphStepDefinition> {
    (0..count)
        .map(|index| SequentialGraphStepDefinition {
            id: format!("step_{index}"),
            context_from: (index > 0).then(|| vec![format!("step_{}", index - 1)]),
            retry: None,
            fanout_group: None,
        })
        .collect()
}

fn fanout_steps(branches: usize) -> Vec<SequentialGraphStepDefinition> {
    (0..branches)
        .map(|index| SequentialGraphStepDefinition {
            id: format!("branch_{index}"),
            context_from: None,
            retry: None,
            fanout_group: Some("wide".to_owned()),
        })
        .chain(std::iter::once(SequentialGraphStepDefinition {
            id: "join".to_owned(),
            context_from: Some(
                (0..branches)
                    .map(|index| format!("branch_{index}"))
                    .collect(),
            ),
            retry: None,
            fanout_group: None,
        }))
        .collect()
}

fn fanout_policies(group_id: &str, branches: usize) -> BTreeMap<String, FanoutGroupPolicy> {
    let mut policies = BTreeMap::new();
    policies.insert(
        group_id.to_owned(),
        FanoutGroupPolicy {
            group_id: group_id.to_owned(),
            strategy: FanoutSyncStrategy::Quorum,
            min_success: Some(u32::try_from(branches).unwrap_or(u32::MAX)),
            on_branch_failure: FanoutBranchFailurePolicy::Continue,
            threshold_gates: None,
            conflict_gates: None,
        },
    );
    policies
}

fn drive_state_machine(
    steps: &[SequentialGraphStepDefinition],
    step_index: &SequentialGraphStepIndex,
    policies: &BTreeMap<String, FanoutGroupPolicy>,
) -> usize {
    let mut state = create_sequential_graph_state("throughput_graph", steps);
    let mut completed = 0usize;
    loop {
        let plan =
            plan_sequential_graph_transition_indexed(&state, steps, step_index, policies, None);
        match plan {
            SequentialGraphPlan::RunStep {
                step_id, attempt, ..
            } => {
                state = start_step(state, &step_id);
                state = succeed_step(state, &step_id, attempt);
                completed += 1;
            }
            SequentialGraphPlan::RunFanout {
                step_ids, attempts, ..
            } => {
                for step_id in step_ids {
                    let attempt = attempts.get(&step_id).copied().unwrap_or(1);
                    state = start_step(state, &step_id);
                    state = succeed_step(state, &step_id, attempt);
                    completed += 1;
                }
            }
            SequentialGraphPlan::Complete => {
                apply_sequential_graph_event(&mut state, &SequentialGraphEvent::Complete);
                return completed + usize::from(state.status == GraphStatus::Succeeded);
            }
            SequentialGraphPlan::Blocked { .. }
            | SequentialGraphPlan::Failed { .. }
            | SequentialGraphPlan::Paused { .. }
            | SequentialGraphPlan::Escalated { .. } => return completed,
        }
    }
}

fn start_step(
    mut state: runx_core::state_machine::SequentialGraphState,
    step_id: &str,
) -> runx_core::state_machine::SequentialGraphState {
    apply_sequential_graph_event(
        &mut state,
        &SequentialGraphEvent::StartStep {
            step_id: step_id.to_owned(),
            at: CREATED_AT.to_owned(),
        },
    );
    state
}

fn succeed_step(
    mut state: runx_core::state_machine::SequentialGraphState,
    step_id: &str,
    attempt: u32,
) -> runx_core::state_machine::SequentialGraphState {
    let receipt_id = format!("sha256:{step_id}_{attempt}");
    apply_sequential_graph_event(
        &mut state,
        &SequentialGraphEvent::StepSucceeded {
            step_id: step_id.to_owned(),
            at: CREATED_AT.to_owned(),
            receipt_id: receipt_id.clone(),
            admission_witness: Box::new(StepAdmissionWitness::local_runtime(step_id, receipt_id)),
            outputs: Some(object([(
                "value",
                JsonValue::String(format!("{step_id}:{attempt}")),
            )])),
        },
    );
    state
}

fn indexed_context_edges(count: usize) -> Vec<(String, usize)> {
    (0..count)
        .map(|index| (format!("input_{index}"), index))
        .collect()
}

fn project_context(runs: &[StepRun], edges: &[(String, usize)]) -> usize {
    let mut projected = 0usize;
    for (input, from_index) in edges {
        projected += input.len();
        if let Some(JsonValue::String(value)) = runs
            .get(*from_index)
            .and_then(|run| nested_value(&run.outputs))
        {
            projected += value.len();
        }
    }
    projected
}

fn nested_value(outputs: &JsonObject) -> Option<&JsonValue> {
    let JsonValue::Object(nested) = outputs.get("nested")? else {
        return None;
    };
    nested.get("value")
}

fn project_output(output: &SkillOutput) -> JsonObject {
    let mut object = JsonObject::new();
    object.insert(
        "stdout".to_owned(),
        JsonValue::String(output.stdout.clone()),
    );
    object.insert(
        "stderr".to_owned(),
        JsonValue::String(output.stderr.clone()),
    );
    object.insert("status".to_owned(), JsonValue::String("success".to_owned()));
    object
}

fn synthetic_prior_runs(count: usize) -> Vec<StepRun> {
    let options = RuntimeOptions {
        created_at: CREATED_AT.to_owned(),
        ..RuntimeOptions::local_development()
    };
    synthetic_step_runs(&options, count)
}

fn synthetic_step_runs(options: &RuntimeOptions, count: usize) -> Vec<StepRun> {
    (0..count)
        .map(|index| {
            let step_id = format!("step_{index}");
            let output = skill_output(&format!(
                r#"{{"nested":{{"value":{index}}},"status":"ok"}}"#
            ));
            let receipt = match step_receipt_with_signature_policy(
                "throughput_graph",
                &step_id,
                1,
                &output,
                CREATED_AT,
                options.signature_policy(),
            ) {
                Ok(receipt) => receipt,
                Err(_error) => std::process::exit(2),
            };
            StepRun {
                step_id: step_id.clone(),
                attempt: 1,
                skill: step_id.clone(),
                runner: None,
                fanout_group: None,
                outputs: object([(
                    "nested",
                    JsonValue::Object(object([("value", JsonValue::String(index.to_string()))])),
                )]),
                admission_witness: StepAdmissionWitness::local_runtime(
                    &step_id,
                    receipt.id.as_str(),
                ),
                output,
                receipt,
            }
        })
        .collect()
}

fn synthetic_receipts(options: &RuntimeOptions, count: usize) -> Vec<runx_contracts::Receipt> {
    synthetic_step_runs(options, count)
        .into_iter()
        .map(|run| run.receipt)
        .collect()
}

fn append_receipts(receipts: &[runx_contracts::Receipt]) -> Result<usize, String> {
    let temp_dir = TempDir::new().map_err(|source| source.to_string())?;
    let store = runx_runtime::LocalReceiptStore::new(temp_dir.path().join("receipts"));
    for receipt in receipts {
        store
            .write_receipt(receipt)
            .map_err(|error| error.to_string())?;
    }
    Ok(receipts.len())
}

fn skill_output(stdout: &str) -> SkillOutput {
    SkillOutput {
        status: InvocationStatus::Success,
        stdout: stdout.to_owned(),
        stderr: String::new(),
        exit_code: Some(0),
        duration_ms: 0,
        metadata: JsonObject::new(),
    }
}

fn object(entries: impl IntoIterator<Item = (&'static str, JsonValue)>) -> JsonObject {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

criterion_group!(benches, bench_graph_throughput);
criterion_main!(benches);

use super::{
    PackageHarnessReport, SkillRunError, SkillRunOverrides, execute_skill_run_with_overrides,
};

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::{JsonObject, JsonValue};
use runx_parser::{HarnessCallerFixture, RunnerHarnessCase, SkillRunnerManifest};

use crate::RuntimeError;
use crate::effects::RuntimeEffectRegistry;
use crate::execution::orchestrator::SkillRunRequest;
use crate::execution::prepared_skill::missing_required_inputs;

use super::runner_manifest::{load_runner_manifest, resolve_skill_dir, selected_runner};

/// Run every harness case owned by a skill package: inline `harness.cases`
/// plus conventional `fixtures/*.yaml` files. Discovery is deterministic and
/// this is the single package entry point used by both the CLI and publishing.
#[cfg(feature = "cli-tool")]
pub(crate) fn run_package_harness_with_effects(
    skill_path: &Path,
    receipt_dir: Option<&Path>,
    env: Option<&BTreeMap<String, String>>,
    effects: &RuntimeEffectRegistry,
) -> Result<PackageHarnessReport, SkillRunError> {
    let skill_dir = resolve_skill_dir(skill_path)?;
    let mut report = run_inline_harness_with_effects(&skill_dir, receipt_dir, env, effects)?;
    let fixture_paths = conventional_fixture_paths(&skill_dir)?;
    if fixture_paths.is_empty() {
        return Ok(report);
    }

    let mut options = crate::execution::runner::RuntimeOptions::from_env_or_local_development(
        env.cloned()
            .unwrap_or_else(crate::services::process_env_snapshot),
    )?;
    options.created_at = crate::time::DEFAULT_CREATED_AT.to_owned();
    options.effects = effects.clone();
    for fixture_path in fixture_paths {
        report.case_count += 1;
        match crate::execution::harness::run_harness_fixture_with_adapter(
            &fixture_path,
            super::SkillRunGraphAdapter::default(),
            options.clone(),
        ) {
            Ok(output) => {
                if matches!(
                    output.fixture.kind,
                    crate::execution::harness::HarnessFixtureKind::Graph
                ) {
                    report.graph_case_count += 1;
                }
                report.case_names.push(output.fixture.name);
                report.receipt_ids.push(output.receipt.id.to_string());
            }
            Err(error) => report
                .assertion_errors
                .push(format!("{}: {error}", fixture_path.display())),
        }
    }
    report.assertion_error_count = report.assertion_errors.len();
    report.status = if report.assertion_errors.is_empty() {
        "passed"
    } else {
        "failed"
    };
    Ok(report)
}

#[cfg(feature = "cli-tool")]
fn conventional_fixture_paths(skill_dir: &Path) -> Result<Vec<PathBuf>, SkillRunError> {
    let fixtures_dir = skill_dir.join("fixtures");
    let entries = match fs::read_dir(&fixtures_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(
                RuntimeError::io(format!("reading {}", fixtures_dir.display()), source).into(),
            );
        }
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| {
            RuntimeError::io(format!("reading {}", fixtures_dir.display()), source)
        })?;
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| matches!(extension, "yaml" | "yml"))
        {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

/// Run a skill's declared inline harness and summarize it. Each declared case is
/// run through the same path as `runx skill` (so a graph that blocks on an agent
/// step yields `needs_agent`, exactly as a real run would), with the case's
/// runner selected and its caller answers/approvals seeded for a single pass.
/// A skill with no declared harness is `not_declared` (not a failure). The
/// run is `passed` only when every case meets its declared expectation.
pub(crate) fn run_inline_harness_with_effects(
    skill_path: &Path,
    receipt_dir: Option<&Path>,
    env: Option<&BTreeMap<String, String>>,
    effects: &RuntimeEffectRegistry,
) -> Result<PackageHarnessReport, SkillRunError> {
    let skill_dir = resolve_skill_dir(skill_path)?;
    let manifest = load_runner_manifest(&skill_dir)?;
    let Some(harness) = manifest.harness.as_ref() else {
        return Ok(PackageHarnessReport::not_declared());
    };
    if harness.cases.is_empty() {
        return Ok(PackageHarnessReport::not_declared());
    }

    let cwd = std::env::current_dir()
        .map_err(|source| RuntimeError::io("resolving cwd for inline harness", source))?;

    let mut assertion_errors = Vec::new();
    let mut case_names = Vec::with_capacity(harness.cases.len());
    let mut receipt_ids = Vec::new();
    let mut graph_case_count = 0;

    for case in &harness.cases {
        case_names.push(case.name.clone());
        let outcome =
            run_inline_harness_case(&skill_dir, receipt_dir, env, &manifest, case, &cwd, effects);
        if outcome.is_graph {
            graph_case_count += 1;
        }
        if let Some(receipt_id) = outcome.receipt_id {
            receipt_ids.push(receipt_id);
        }
        if let Some(error) = outcome.assertion_error {
            assertion_errors.push(error);
        }
    }

    let status = if assertion_errors.is_empty() {
        "passed"
    } else {
        "failed"
    };
    Ok(PackageHarnessReport {
        assertion_error_count: assertion_errors.len(),
        status,
        case_count: harness.cases.len(),
        assertion_errors,
        case_names,
        receipt_ids,
        graph_case_count,
    })
}

struct InlineHarnessCaseOutcome {
    is_graph: bool,
    receipt_id: Option<String>,
    assertion_error: Option<String>,
}

fn run_inline_harness_case(
    skill_dir: &Path,
    receipt_dir: Option<&Path>,
    env: Option<&BTreeMap<String, String>>,
    manifest: &SkillRunnerManifest,
    case: &RunnerHarnessCase,
    cwd: &Path,
    effects: &RuntimeEffectRegistry,
) -> InlineHarnessCaseOutcome {
    let runner = match selected_runner(manifest, case.runner.as_deref()) {
        Ok(runner) => runner,
        Err(error) => return inline_harness_case_error(&case.name, error),
    };
    let is_graph = runner.source.source_type == runx_parser::SourceKind::Graph;

    // Enforce the required-input contract the real `runx skill` prepare stage
    // applies. The harness executes directly, so without this a missing required
    // input would seal an empty run instead of blocking, masking the failure.
    let missing = missing_required_inputs(runner, &case.inputs);
    if !missing.is_empty() {
        return InlineHarnessCaseOutcome {
            is_graph,
            receipt_id: None,
            assertion_error: inline_harness_status_error(case, "failure"),
        };
    }

    let request = inline_harness_case_request(skill_dir, receipt_dir, env, case, cwd);
    let overrides = SkillRunOverrides {
        runner: case.runner.clone(),
        seeded_answers: seeded_answers_from_caller(&case.caller),
    };
    match execute_skill_run_with_overrides(&request, &overrides, effects) {
        Ok(output) => InlineHarnessCaseOutcome {
            is_graph,
            receipt_id: receipt_id_from_output(&output),
            assertion_error: inline_harness_expectation_error(case, &output),
        },
        Err(error) => InlineHarnessCaseOutcome {
            is_graph,
            receipt_id: None,
            assertion_error: Some(format!("{}: {error}", case.name)),
        },
    }
}

fn inline_harness_case_request(
    skill_dir: &Path,
    receipt_dir: Option<&Path>,
    env: Option<&BTreeMap<String, String>>,
    case: &RunnerHarnessCase,
    cwd: &Path,
) -> SkillRunRequest {
    let mut env: BTreeMap<String, String> =
        env.cloned().unwrap_or_else(|| std::env::vars().collect());
    env.extend(case.env.clone());
    SkillRunRequest {
        skill_path: skill_dir.to_path_buf(),
        receipt_dir: receipt_dir.map(Path::to_path_buf),
        run_id: None,
        answers_path: None,
        inputs: case.inputs.clone(),
        env,
        cwd: cwd.to_path_buf(),
        local_credential: None,
    }
}

fn inline_harness_case_error(
    case_name: &str,
    error: impl std::fmt::Display,
) -> InlineHarnessCaseOutcome {
    InlineHarnessCaseOutcome {
        is_graph: false,
        receipt_id: None,
        assertion_error: Some(format!("{case_name}: {error}")),
    }
}

fn receipt_id_from_output(output: &JsonValue) -> Option<String> {
    output
        .as_object()
        .and_then(|object| object.get("receipt_id"))
        .and_then(JsonValue::as_str)
        .map(str::to_owned)
}

fn inline_harness_expectation_error(
    case: &RunnerHarnessCase,
    output: &JsonValue,
) -> Option<String> {
    inline_harness_status_error(case, inline_harness_actual_status(output))
}

fn inline_harness_status_error(case: &RunnerHarnessCase, actual: &str) -> Option<String> {
    let expected = case.expect.status.as_deref()?;
    (actual != expected).then(|| format!("{}: expected status {expected}, got {actual}", case.name))
}

// Merge a harness case's caller answers + approvals into one map keyed by
// resolution request id, the shape the seeded agent/graph answer lookup expects.
// Approvals are recorded as booleans under their gate id.
fn seeded_answers_from_caller(caller: &HarnessCallerFixture) -> Option<JsonObject> {
    let mut merged = caller.answers.clone().unwrap_or_default();
    if let Some(approvals) = &caller.approvals {
        for (gate, approved) in approvals {
            merged
                .entry(gate.clone())
                .or_insert_with(|| JsonValue::Bool(*approved));
        }
    }
    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

// Map an `execute_skill_run` output onto the harness status vocabulary
// (sealed/failure/needs_agent/policy_denied). A pending run is needs_agent; a
// terminal run is derived from its closure disposition so the mapping matches
// the standalone harness `status_from_disposition`.
fn inline_harness_actual_status(output: &JsonValue) -> &'static str {
    let Some(object) = output.as_object() else {
        return "sealed";
    };
    if object.get("status").and_then(JsonValue::as_str) == Some("needs_agent") {
        return "needs_agent";
    }
    let disposition = object
        .get("closure")
        .and_then(JsonValue::as_object)
        .and_then(|closure| closure.get("disposition"))
        .and_then(JsonValue::as_str);
    match disposition {
        Some("deferred") => "needs_agent",
        Some("blocked") => "policy_denied",
        Some("declined" | "failed" | "killed" | "timed_out" | "superseded") => "failure",
        _ => "sealed",
    }
}

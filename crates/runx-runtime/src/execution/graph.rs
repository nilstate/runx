// rust-style-allow: large-file - graph loading keeps stage, registry, and local skill resolution together.
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::{JsonObject, JsonValue, sha256_prefixed};
use runx_core::state_machine::{RetryPolicy, SequentialGraphStepDefinition};
use runx_parser::{
    ExecutionGraph, GraphStep, SkillArtifactContract, SkillRunnerDefinition, SkillRunnerManifest,
    SkillSource, ValidatedSkill, parse_graph_yaml, parse_runner_manifest_yaml, validate_graph,
    validate_runner_manifest,
};

use crate::receipts::paths::RUNX_CWD_ENV;
use crate::registry::{
    InstallCandidate, InstallLocalSkillOptions, RegistryResolveOptions, create_file_registry_store,
    install_local_skill, materialization_cache_path, materialization_digest_marker,
    resolve_registry_skill, split_skill_id, trusted_registry_manifest_keys_from_env,
};
use crate::{RuntimeError, StepRun};

use super::graph_index::PriorRunIndex;

#[derive(Clone)]
pub(crate) struct LoadedStepSkill {
    pub(crate) name: String,
    pub(crate) source: SkillSource,
    pub(crate) directory: PathBuf,
    /// The invoked runner's declared artifact contract. A sub-skill step exposes
    /// this contract at the OUTER step (the packet, e.g. `research_packet`,
    /// becomes `<step>.<packet>.data`), never the sub-skill's internals.
    pub(crate) artifacts: Option<SkillArtifactContract>,
}

#[derive(Default)]
pub(crate) struct StepSkillCache {
    loaded: BTreeMap<String, LoadedStepSkill>,
}

impl StepSkillCache {
    pub(crate) fn load(
        &mut self,
        graph_dir: &Path,
        step: &GraphStep,
        options: StepSkillLoadOptions<'_>,
    ) -> Result<LoadedStepSkill, RuntimeError> {
        if let Some(skill) = self.loaded.get(&step.id) {
            return Ok(skill.clone());
        }
        let skill = load_step_skill(graph_dir, step, options)?;
        self.loaded.insert(step.id.clone(), skill.clone());
        Ok(skill)
    }
}

#[derive(Clone, Copy)]
pub(crate) struct StepSkillLoadOptions<'a> {
    pub(crate) env: &'a BTreeMap<String, String>,
}

pub(crate) fn load_graph(graph_path: &Path) -> Result<ExecutionGraph, RuntimeError> {
    let source = fs::read_to_string(graph_path)
        .map_err(|source| RuntimeError::io("reading graph file", source))?;
    let raw = parse_graph_yaml(&source)?;
    validate_graph(raw).map_err(RuntimeError::from)
}

pub(crate) fn materialize_graph_inputs(
    mut graph: ExecutionGraph,
    graph_inputs: &JsonObject,
) -> ExecutionGraph {
    for step in &mut graph.steps {
        let mut inputs = graph_inputs.clone();
        for (key, value) in &step.inputs {
            if let Some(value) = materialize_graph_input_value(value, graph_inputs) {
                inputs.insert(key.clone(), value);
            } else {
                inputs.remove(key);
            }
        }
        step.inputs = inputs;
    }
    graph
}

fn materialize_graph_input_value(
    value: &JsonValue,
    graph_inputs: &JsonObject,
) -> Option<JsonValue> {
    match value {
        JsonValue::String(value) => {
            if let Some(path) = value.strip_prefix("$input.") {
                return resolve_graph_input_path(graph_inputs, path).cloned();
            }
            if value.starts_with("{{") && value.ends_with("}}") {
                let path = value.trim_start_matches('{').trim_end_matches('}').trim();
                return resolve_graph_input_path(graph_inputs, path).cloned();
            }
            Some(JsonValue::String(value.clone()))
        }
        JsonValue::Array(values) => Some(JsonValue::Array(
            values
                .iter()
                .filter_map(|value| materialize_graph_input_value(value, graph_inputs))
                .collect(),
        )),
        JsonValue::Object(object) => Some(JsonValue::Object(
            object
                .iter()
                .filter_map(|(key, value)| {
                    materialize_graph_input_value(value, graph_inputs)
                        .map(|value| (key.clone(), value))
                })
                .collect(),
        )),
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => Some(value.clone()),
    }
}

fn resolve_graph_input_path<'a>(value: &'a JsonObject, path: &str) -> Option<&'a JsonValue> {
    let mut current: Option<&JsonValue> = None;
    for segment in path.split('.') {
        current = match current {
            None => value.get(segment),
            Some(JsonValue::Object(object)) => object.get(segment),
            Some(_) => return None,
        };
    }
    current
}

pub(crate) fn load_skill(skill_dir: &Path) -> Result<ValidatedSkill, RuntimeError> {
    let skill_path = skill_dir.join("SKILL.md");
    if !skill_path.exists() {
        return Err(RuntimeError::SkillFileMissing { path: skill_path });
    }
    let source = fs::read_to_string(&skill_path)
        .map_err(|source| RuntimeError::io("reading skill markdown", source))?;
    let raw = runx_parser::parse_skill_markdown(&source)?;
    runx_parser::validate_skill(raw).map_err(RuntimeError::from)
}

pub(crate) fn load_step_skill(
    graph_dir: &Path,
    step: &GraphStep,
    options: StepSkillLoadOptions<'_>,
) -> Result<LoadedStepSkill, RuntimeError> {
    let directory = skill_dir(graph_dir, step, options)?;
    if let Some(runner) = load_step_runner(&directory, step.runner.as_deref())? {
        return Ok(LoadedStepSkill {
            name: runner.name,
            source: runner.source,
            directory,
            artifacts: runner.artifacts,
        });
    }
    let skill = load_skill(&directory)?;
    Ok(LoadedStepSkill {
        name: skill.name,
        source: skill.source,
        directory,
        artifacts: skill.artifacts,
    })
}

fn load_step_runner(
    skill_dir: &Path,
    requested_runner: Option<&str>,
) -> Result<Option<SkillRunnerDefinition>, RuntimeError> {
    let manifest_path = skill_dir.join("X.yaml");
    if !manifest_path.exists() {
        if let Some(runner) = requested_runner {
            return Err(RuntimeError::UnsupportedRunnerSelection {
                runner: runner.to_owned(),
            });
        }
        return Ok(None);
    }
    let source = fs::read_to_string(&manifest_path).map_err(|source| {
        RuntimeError::io(format!("reading {}", manifest_path.display()), source)
    })?;
    let parsed = parse_runner_manifest_yaml(&source).map_err(RuntimeError::from)?;
    let manifest = validate_runner_manifest(parsed).map_err(RuntimeError::from)?;
    select_step_runner(&manifest, requested_runner)
        .cloned()
        .map(Some)
}

fn select_step_runner<'a>(
    manifest: &'a SkillRunnerManifest,
    requested_runner: Option<&str>,
) -> Result<&'a SkillRunnerDefinition, RuntimeError> {
    if let Some(runner) = requested_runner {
        return manifest.runners.get(runner).ok_or_else(|| {
            RuntimeError::UnsupportedRunnerSelection {
                runner: runner.to_owned(),
            }
        });
    }
    let defaults = manifest
        .runners
        .values()
        .filter(|runner| runner.default)
        .collect::<Vec<_>>();
    match defaults.as_slice() {
        [runner] => Ok(*runner),
        [] if manifest.runners.len() == 1 => manifest.runners.values().next().ok_or_else(|| {
            RuntimeError::UnsupportedRunnerSelection {
                runner: "default".to_owned(),
            }
        }),
        [] => Err(RuntimeError::UnsupportedRunnerSelection {
            runner: "default".to_owned(),
        }),
        _ => Err(RuntimeError::UnsupportedRunnerSelection {
            runner: "default".to_owned(),
        }),
    }
}

pub(crate) fn step_definitions(graph: &ExecutionGraph) -> Vec<SequentialGraphStepDefinition> {
    graph
        .steps
        .iter()
        .map(|step| SequentialGraphStepDefinition {
            id: step.id.clone(),
            context_from: context_from(step),
            retry: step.retry.as_ref().map(|retry| RetryPolicy {
                max_attempts: retry_attempts(retry.max_attempts),
            }),
            fanout_group: step.fanout_group.clone(),
        })
        .collect()
}

pub(crate) fn skill_dir(
    graph_dir: &Path,
    step: &GraphStep,
    options: StepSkillLoadOptions<'_>,
) -> Result<PathBuf, RuntimeError> {
    if let Some(skill) = &step.skill {
        if is_registry_step_ref(skill) {
            return materialize_registry_step_skill(graph_dir, step, skill, options);
        }
        return Ok(graph_dir.join(skill));
    }
    Err(RuntimeError::StepMissingSkill {
        step_id: step.id.clone(),
    })
}

// rust-style-allow: long-function - registry step materialization owns cache, digest, and manifest restoration.
fn materialize_registry_step_skill(
    graph_dir: &Path,
    step: &GraphStep,
    reference: &str,
    options: StepSkillLoadOptions<'_>,
) -> Result<PathBuf, RuntimeError> {
    let Some(registry_dir) = options.env.get("RUNX_REGISTRY_DIR") else {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: format!(
                "nested skill '{reference}' is a registry ref, but RUNX_REGISTRY_DIR is not configured"
            ),
        });
    };
    let registry_url = options.env.get("RUNX_REGISTRY_URL").cloned();
    let store = create_file_registry_store(registry_dir);
    let resolution = resolve_registry_skill(
        &store,
        reference,
        RegistryResolveOptions {
            version: None,
            registry_url,
        },
    )
    .map_err(|source| RuntimeError::InvalidRunStep {
        step_id: step.id.clone(),
        reason: format!("nested skill registry ref '{reference}' could not be resolved: {source}"),
    })?
    .ok_or_else(|| RuntimeError::InvalidRunStep {
        step_id: step.id.clone(),
        reason: format!("nested skill registry ref '{reference}' was not found"),
    })?;

    let (owner, name) = split_skill_id(&resolution.skill_id).map_err(|source| {
        RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: format!(
                "nested skill registry ref '{reference}' resolved to invalid skill id '{}': {source}",
                resolution.skill_id
            ),
        }
    })?;
    let profile_digest = resolution
        .profile_document
        .as_ref()
        .map(|document| sha256_prefixed(document.as_bytes()));
    let identity_digest = sha256_prefixed(
        materialization_digest_marker(
            &prefixed_digest(&resolution.digest),
            profile_digest.as_deref(),
            resolution.package_digest.as_deref(),
        )
        .as_bytes(),
    );
    let cache_root = runtime_cwd(options.env, graph_dir)
        .join(".runx")
        .join("registry-step-skills")
        .join(registry_source_fingerprint(registry_dir));
    let destination_root = materialization_cache_path(
        &cache_root,
        owner,
        name,
        &resolution.version,
        &identity_digest,
    );
    let candidate = InstallCandidate {
        markdown: resolution.markdown,
        profile_document: resolution.profile_document,
        package_files: resolution.package_files,
        package_digest: resolution.package_digest,
        source: resolution.source,
        source_label: resolution.source_label,
        r#ref: format!("{}@{}", resolution.skill_id, resolution.version),
        skill_id: Some(resolution.skill_id),
        version: Some(resolution.version),
        signed_manifest: resolution.signed_manifest,
        profile_digest: resolution.profile_digest,
        runner_names: resolution.runner_names,
        trust_tier: Some(resolution.trust_tier),
        manifest_source_authority: crate::registry::registry_manifest_source_authority_from_env(
            options.env,
        ),
    };
    let trusted_manifest_keys = trusted_registry_manifest_keys_from_env(options.env).map_err(
        |source| RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: format!(
                "nested skill registry ref '{reference}' trust configuration is invalid: {source}"
            ),
        },
    )?;
    let install = install_local_skill(
        &candidate,
        &InstallLocalSkillOptions {
            destination_root,
            expected_digest: None,
            trusted_manifest_keys,
        },
    )
    .map_err(|source| RuntimeError::InvalidRunStep {
        step_id: step.id.clone(),
        reason: format!("nested skill registry ref '{reference}' failed admission: {source}"),
    })?;
    install
        .destination
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: format!(
                "nested skill registry ref '{reference}' installed to invalid path {}",
                install.destination.display()
            ),
        })
}

fn runtime_cwd(env: &BTreeMap<String, String>, graph_dir: &Path) -> PathBuf {
    env.get(RUNX_CWD_ENV)
        .map(|value| crate::resolve_path_from_user_input(value, env, graph_dir, false))
        .unwrap_or_else(|| graph_dir.to_path_buf())
}

fn registry_source_fingerprint(registry_dir: &str) -> String {
    sha256_prefixed(registry_dir.as_bytes())
        .trim_start_matches("sha256:")
        .chars()
        .take(16)
        .collect()
}

fn prefixed_digest(digest: &str) -> String {
    if digest.starts_with("sha256:") {
        digest.to_owned()
    } else {
        format!("sha256:{digest}")
    }
}

fn is_registry_step_ref(reference: &str) -> bool {
    reference.starts_with("registry:")
        || reference.starts_with("runx-registry:")
        || reference.starts_with("runx://skill/")
}

pub(crate) fn resolve_inputs(
    step: &GraphStep,
    prior_runs: &[StepRun],
) -> Result<JsonObject, RuntimeError> {
    let prior_run_index = PriorRunIndex::new(prior_runs);
    resolve_inputs_with_index(step, &prior_run_index)
}

pub(crate) fn resolve_inputs_with_index(
    step: &GraphStep,
    prior_run_index: &PriorRunIndex<'_>,
) -> Result<JsonObject, RuntimeError> {
    let mut inputs = step.inputs.clone();
    if step.context_edges.is_empty() {
        return Ok(inputs);
    }
    for edge in &step.context_edges {
        let value = prior_run_index.output(&edge.from_step, &edge.output)?;
        inputs.insert(edge.input.clone(), value);
    }
    Ok(inputs)
}

fn context_from(step: &GraphStep) -> Option<Vec<String>> {
    let refs = step
        .context_edges
        .iter()
        .map(|edge| edge.from_step.clone())
        .collect::<Vec<_>>();
    (!refs.is_empty()).then_some(refs)
}

fn retry_attempts(max_attempts: u64) -> u32 {
    u32::try_from(max_attempts).unwrap_or(u32::MAX)
}

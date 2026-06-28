// rust-style-allow: large-file - skill command keeps parse, inspect, registry provenance, and execution wiring together until the native skill UX settles.
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use runx_contracts::{JsonObject, JsonValue};
use runx_runtime::SkillRunRequest;
use runx_runtime::orchestrator::LocalCredentialDescriptor;

mod inputs;
mod output;
mod parser;
mod resolver;

use output::{SkillOutputResume, skill_result_exit_code, write_skill_output};
pub use parser::parse_skill_plan;
use resolver::{RegistryTrustState, ResolvedSkillRef, resolve_skill_ref_details};

#[derive(Debug, PartialEq)]
pub struct SkillPlan {
    pub action: SkillAction,
    pub skill_path: PathBuf,
    pub runner: Option<String>,
    pub receipt_dir: Option<PathBuf>,
    pub run_id: Option<String>,
    pub answers: Option<PathBuf>,
    pub registry: Option<String>,
    pub expected_digest: Option<String>,
    pub json: bool,
    pub inputs: BTreeMap<String, JsonValue>,
    /// One-shot, per-run local credential descriptor supplied via
    /// `--credential` and `--secret-env`. The secret is read from the named
    /// process environment variable so raw secret material never appears on
    /// argv. Runner-specific execution validates whether that delivery channel
    /// is supported before any child process starts.
    pub local_credential: Option<LocalCredentialDescriptor>,
}

#[derive(Debug, PartialEq)]
pub enum SkillAction {
    Inspect,
    Run,
}

// rust-style-allow: long-function - the top-level command path owns resolve/inspect/run/failure presentation in one explicit dispatch.
pub fn run_native_skill(plan: SkillPlan) -> ExitCode {
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let env = env::vars().collect();
    let resume_skill_ref = plan.skill_path.to_string_lossy().into_owned();
    let resolved = match resolve_skill_ref_details(
        &plan.skill_path,
        &cwd,
        resolver::SkillResolverOptions {
            env: &env,
            registry: plan.registry.as_deref(),
            expected_digest: plan.expected_digest.as_deref(),
        },
    ) {
        Ok(skill_path) => skill_path,
        Err(error) => {
            return write_skill_failure(&error.to_string(), plan.json, "skill_error", 1, None);
        }
    };
    let skill_path = resolved.runnable_path.clone();
    if plan.action == SkillAction::Inspect {
        return write_skill_inspection(
            &skill_path,
            plan.runner.as_deref(),
            plan.json,
            registry_provenance(&resolved),
        );
    }
    let resume = SkillOutputResume {
        skill_ref: Some(&resume_skill_ref),
        selected_runner: plan.runner.as_deref(),
        receipt_dir: plan.receipt_dir.as_deref(),
        answers_path: plan.answers.as_deref(),
    };
    let request = SkillRunRequest {
        skill_path,
        receipt_dir: plan.receipt_dir.clone(),
        run_id: plan.run_id.clone(),
        answers_path: plan.answers.clone(),
        inputs: plan.inputs,
        env,
        cwd,
        local_credential: plan.local_credential,
    };
    let orchestrator = crate::runtime::local_orchestrator();
    let result = match plan.runner.as_deref() {
        Some(runner) => orchestrator.run_skill_with_runner(&request, runner),
        None => orchestrator.run_skill(&request),
    };
    match result {
        Ok(mut result) => {
            attach_registry_provenance(&mut result.output, &resolved);
            let exit_code = skill_result_exit_code(&result.output);
            write_skill_output(&result.output, plan.json, exit_code, resume)
        }
        Err(error) => write_skill_failure(
            &error.to_string(),
            plan.json,
            "skill_error",
            1,
            registry_provenance(&resolved),
        ),
    }
}

fn write_skill_inspection(
    skill_path: &Path,
    runner: Option<&str>,
    json: bool,
    provenance: Option<JsonObject>,
) -> ExitCode {
    match inspect_skill(skill_path, runner, provenance) {
        Ok(value) if json => crate::cli_io::write_stdout_code(
            &format!(
                "{}\n",
                serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_owned())
            ),
            0,
        ),
        Ok(value) => write_inspection_text(&value),
        Err(message) => write_skill_failure(&message, json, "skill_error", 1, None),
    }
}

// rust-style-allow: long-function - inspection assembles one public JSON contract from SKILL.md, X.yaml, fixtures, and selected runner metadata.
fn inspect_skill(
    skill_path: &Path,
    selected_runner: Option<&str>,
    provenance: Option<JsonObject>,
) -> Result<JsonValue, String> {
    let skill_dir = skill_directory(skill_path);
    let skill_md = fs::read_to_string(skill_dir.join("SKILL.md")).map_err(|error| {
        format!(
            "could not read skill markdown {}: {error}",
            skill_dir.join("SKILL.md").display()
        )
    })?;
    let frontmatter = parse_skill_frontmatter(&skill_md)?;
    let x_yaml_path = skill_dir.join("X.yaml");
    let profile = match fs::read_to_string(&x_yaml_path) {
        Ok(contents) => parse_yaml_object(&contents, &x_yaml_path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => JsonObject::new(),
        Err(error) => {
            return Err(format!("could not read {}: {error}", x_yaml_path.display()));
        }
    };
    let runners = profile
        .get("runners")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    let mut output = JsonObject::new();
    output.insert(
        "schema".to_owned(),
        JsonValue::String("runx.skill.inspect.v1".to_owned()),
    );
    output.insert("status".to_owned(), JsonValue::String("ok".to_owned()));
    insert_frontmatter_string(&mut output, &frontmatter, "name", "name");
    insert_frontmatter_string(&mut output, &frontmatter, "description", "description");
    if let Some(version) = profile.get("version").and_then(JsonValue::as_str) {
        output.insert("version".to_owned(), JsonValue::String(version.to_owned()));
    }
    if let Some(provenance) = provenance {
        output.insert(
            "registry_provenance".to_owned(),
            JsonValue::Object(provenance),
        );
    }
    output.insert(
        "skill_path".to_owned(),
        JsonValue::String(skill_dir.to_string_lossy().into_owned()),
    );
    output.insert(
        "runners".to_owned(),
        JsonValue::Array(
            runners
                .keys()
                .map(|runner| JsonValue::String(runner.clone()))
                .collect(),
        ),
    );
    if let Some(runner) = selected_runner {
        let runner_def = runners
            .get(runner)
            .and_then(JsonValue::as_object)
            .ok_or_else(|| format!("skill has no runner '{runner}'"))?;
        output.insert("runner".to_owned(), inspect_runner(runner, runner_def));
        output.insert(
            "examples".to_owned(),
            JsonValue::Array(fixture_examples(&skill_dir, runner)),
        );
        output.insert(
            "resume".to_owned(),
            JsonValue::Object(JsonObject::from([
                (
                    "may_pause".to_owned(),
                    JsonValue::Bool(runner_may_pause(runner_def)),
                ),
                (
                    "command".to_owned(),
                    JsonValue::String("runx resume <run-id> answers.json".to_owned()),
                ),
            ])),
        );
    }
    Ok(JsonValue::Object(output))
}

// rust-style-allow: long-function - text rendering mirrors the inspect JSON shape and is kept adjacent to avoid presentation drift.
fn write_inspection_text(value: &JsonValue) -> ExitCode {
    let Some(object) = value.as_object() else {
        return crate::cli_io::write_stdout_code("{}\n", 0);
    };
    let mut out = String::new();
    out.push_str(&format!(
        "skill: {}\n",
        object_string(object, "name").unwrap_or("<unnamed>")
    ));
    if let Some(description) = object_string(object, "description") {
        out.push_str(&format!("description: {description}\n"));
    }
    if let Some(version) = object_string(object, "version") {
        out.push_str(&format!("version: {version}\n"));
    }
    if let Some(runner) = object.get("runner").and_then(JsonValue::as_object) {
        out.push_str(&format!(
            "runner: {}\n",
            object_string(runner, "name").unwrap_or("<unknown>")
        ));
        if let Some(kind) = object_string(runner, "type") {
            out.push_str(&format!("type: {kind}\n"));
        }
        if let Some(inputs) = runner.get("inputs").and_then(JsonValue::as_array) {
            if !inputs.is_empty() {
                out.push_str("inputs:\n");
                for input in inputs {
                    if let Some(input) = input.as_object() {
                        let name = object_string(input, "name").unwrap_or("<unknown>");
                        let kind = object_string(input, "type").unwrap_or("json");
                        let required = input
                            .get("required")
                            .and_then(JsonValue::as_bool)
                            .unwrap_or(false);
                        let marker = if required { "required" } else { "optional" };
                        out.push_str(&format!("  - {name}: {kind} ({marker})\n"));
                    }
                }
            }
        }
        if let Some(examples) = object.get("examples").and_then(JsonValue::as_array)
            && !examples.is_empty()
        {
            out.push_str("examples:\n");
            for example in examples {
                if let Some(example) = example.as_str() {
                    out.push_str(&format!("  - {example}\n"));
                }
            }
        }
        if let Some(resume) = object.get("resume").and_then(JsonValue::as_object)
            && resume
                .get("may_pause")
                .and_then(JsonValue::as_bool)
                .unwrap_or(false)
        {
            out.push_str(&format!(
                "resume: {}\n",
                object_string(resume, "command").unwrap_or("runx resume <run-id> answers.json")
            ));
        }
        out.push_str("run: runx skill <skill> [runner]\n");
    } else if let Some(runners) = object.get("runners").and_then(JsonValue::as_array) {
        out.push_str("runners:\n");
        for runner in runners {
            if let Some(runner) = runner.as_str() {
                out.push_str(&format!("  - {runner}\n"));
            }
        }
        out.push_str("next: runx skill <skill> <runner>\n");
    }
    crate::cli_io::write_stdout_code(&out, 0)
}

fn skill_directory(skill_path: &Path) -> PathBuf {
    if skill_path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
        return skill_path.parent().unwrap_or(skill_path).to_path_buf();
    }
    skill_path.to_path_buf()
}

fn parse_skill_frontmatter(markdown: &str) -> Result<JsonObject, String> {
    let Some(rest) = markdown.strip_prefix("---") else {
        return Ok(JsonObject::new());
    };
    let Some((frontmatter, _body)) = rest.split_once("\n---") else {
        return Ok(JsonObject::new());
    };
    serde_norway::from_str::<JsonValue>(frontmatter)
        .map_err(|error| format!("skill frontmatter is invalid YAML: {error}"))
        .map(|value| match value {
            JsonValue::Object(object) => object,
            _ => JsonObject::new(),
        })
}

fn parse_yaml_object(contents: &str, path: &Path) -> Result<JsonObject, String> {
    serde_norway::from_str::<JsonValue>(contents)
        .map_err(|error| format!("{} is invalid YAML: {error}", path.display()))
        .and_then(|value| match value {
            JsonValue::Object(object) => Ok(object),
            _ => Err(format!("{} must contain a YAML object", path.display())),
        })
}

fn insert_frontmatter_string(
    output: &mut JsonObject,
    frontmatter: &JsonObject,
    source_key: &str,
    output_key: &str,
) {
    if let Some(value) = object_string(frontmatter, source_key) {
        output.insert(output_key.to_owned(), JsonValue::String(value.to_owned()));
    }
}

fn inspect_runner(name: &str, runner: &JsonObject) -> JsonValue {
    let mut output = JsonObject::new();
    output.insert("name".to_owned(), JsonValue::String(name.to_owned()));
    if let Some(kind) = object_string(runner, "type") {
        output.insert("type".to_owned(), JsonValue::String(kind.to_owned()));
    }
    let inputs = runner
        .get("inputs")
        .and_then(JsonValue::as_object)
        .map(|inputs| {
            inputs
                .iter()
                .map(|(name, input)| inspect_input(name, input))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    output.insert("inputs".to_owned(), JsonValue::Array(inputs));
    JsonValue::Object(output)
}

fn inspect_input(name: &str, value: &JsonValue) -> JsonValue {
    let mut output = JsonObject::new();
    output.insert("name".to_owned(), JsonValue::String(name.to_owned()));
    if let Some(input) = value.as_object() {
        if let Some(kind) = object_string(input, "type") {
            output.insert("type".to_owned(), JsonValue::String(kind.to_owned()));
        }
        output.insert(
            "required".to_owned(),
            JsonValue::Bool(
                input
                    .get("required")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(false),
            ),
        );
        if let Some(description) = object_string(input, "description") {
            output.insert(
                "description".to_owned(),
                JsonValue::String(description.to_owned()),
            );
        }
    }
    JsonValue::Object(output)
}

fn object_string<'a>(object: &'a JsonObject, key: &str) -> Option<&'a str> {
    object.get(key).and_then(JsonValue::as_str)
}

fn fixture_examples(skill_dir: &Path, runner: &str) -> Vec<JsonValue> {
    let fixtures_dir = skill_dir.join("fixtures");
    let Ok(entries) = fs::read_dir(fixtures_dir) else {
        return Vec::new();
    };
    let mut fixtures = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?.to_owned();
            (name.ends_with(".yaml") && fixture_targets_runner(&path, runner)).then_some(name)
        })
        .map(JsonValue::String)
        .collect::<Vec<_>>();
    fixtures.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
    fixtures
}

fn fixture_targets_runner(path: &Path, runner: &str) -> bool {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_norway::from_str::<JsonValue>(&contents).ok())
        .and_then(|value| value.as_object().cloned())
        .and_then(|object| {
            object
                .get("runner")
                .and_then(JsonValue::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|fixture_runner| fixture_runner == runner)
}

fn runner_may_pause(runner: &JsonObject) -> bool {
    matches!(
        object_string(runner, "type"),
        Some("agent") | Some("agent-task") | Some("graph")
    )
}

fn attach_registry_provenance(output: &mut JsonValue, resolved: &ResolvedSkillRef) {
    let Some(provenance) = registry_provenance(resolved) else {
        return;
    };
    let JsonValue::Object(object) = output else {
        return;
    };
    object.insert(
        "registry_provenance".to_owned(),
        JsonValue::Object(provenance),
    );
}

fn registry_provenance(resolved: &ResolvedSkillRef) -> Option<JsonObject> {
    let skill_id = resolved.skill_id.as_ref()?;
    let mut provenance = JsonObject::new();
    provenance.insert("skill_id".to_owned(), JsonValue::String(skill_id.clone()));
    insert_optional(&mut provenance, "version", resolved.version.as_ref());
    insert_optional(&mut provenance, "digest", resolved.digest.as_ref());
    insert_optional(
        &mut provenance,
        "profile_digest",
        resolved.profile_digest.as_ref(),
    );
    insert_optional(
        &mut provenance,
        "registry_source",
        resolved.registry_source.as_ref(),
    );
    insert_optional(
        &mut provenance,
        "registry_source_fingerprint",
        resolved.registry_source_fingerprint.as_ref(),
    );
    insert_optional(&mut provenance, "trust_tier", resolved.trust_tier.as_ref());
    insert_optional(
        &mut provenance,
        "registry_key_id",
        resolved.registry_key_id.as_ref(),
    );
    if matches!(
        resolved.trust_state.as_ref(),
        Some(RegistryTrustState::Trusted)
    ) {
        provenance.insert(
            "trust_state".to_owned(),
            JsonValue::String("trusted".to_owned()),
        );
    }
    Some(provenance)
}

fn insert_optional(object: &mut JsonObject, key: &str, value: Option<&String>) {
    if let Some(value) = value {
        object.insert(key.to_owned(), JsonValue::String(value.clone()));
    }
}

fn write_skill_failure(
    message: &str,
    json: bool,
    code: &str,
    exit_code: u8,
    provenance: Option<JsonObject>,
) -> ExitCode {
    if json {
        let output = skill_json_failure_output(message, code, provenance);
        return crate::cli_io::write_stdout_code(&output, exit_code);
    }
    let _ignored = writeln!(io::stderr(), "runx: {message}");
    ExitCode::from(exit_code)
}

fn skill_json_failure_output(message: &str, code: &str, provenance: Option<JsonObject>) -> String {
    let mut error = JsonObject::new();
    error.insert("message".to_owned(), JsonValue::String(message.to_owned()));
    error.insert("code".to_owned(), JsonValue::String(code.to_owned()));
    let mut output = JsonObject::new();
    output.insert("status".to_owned(), JsonValue::String("failure".to_owned()));
    output.insert("error".to_owned(), JsonValue::Object(error));
    if let Some(provenance) = provenance {
        output.insert(
            "registry_provenance".to_owned(),
            JsonValue::Object(provenance),
        );
    }
    serde_json::to_string_pretty(&JsonValue::Object(output))
        .map(|json| format!("{json}\n"))
        .unwrap_or_else(|_| crate::router::json_failure_output(message, code))
}

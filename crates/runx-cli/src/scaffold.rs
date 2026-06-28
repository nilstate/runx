use std::env;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use runx_runtime::scaffold::{
    InitAction, InitGeneratedValues, RunxInitOptions, RunxInitResult, RunxNewOptions,
    RunxNewResult, runx_init, sanitize_runx_package_name, scaffold_runx_package,
};
use serde::Serialize;

use crate::router::{InitPlan, NewPlan};

pub fn run_native_new(plan: NewPlan) -> ExitCode {
    let cwd = match env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            let _ignored = write_stderr_line(&format!("runx: failed to resolve cwd: {error}"));
            return ExitCode::from(1);
        }
    };
    let env = crate::history::env_map();
    let directory =
        resolve_new_package_directory(&plan.name, plan.directory.as_deref(), &env, &cwd);
    let options = RunxNewOptions {
        name: plan.name,
        directory,
    };

    match scaffold_runx_package(&options) {
        Ok(result) => render_new_result(plan.json, &result),
        Err(error) => {
            let _ignored = write_stderr_line(&format!("runx: {error}"));
            ExitCode::from(1)
        }
    }
}

pub fn run_native_init(plan: InitPlan) -> ExitCode {
    let cwd = match env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            let _ignored = write_stderr_line(&format!("runx: failed to resolve cwd: {error}"));
            return ExitCode::from(1);
        }
    };
    let env = crate::history::env_map();
    let global_home_dir = resolve_global_home_dir(&env, &cwd);
    let official_cache_dir = resolve_official_skills_dir(&env, &cwd, &global_home_dir);
    let options = RunxInitOptions {
        action: if plan.global {
            InitAction::Global
        } else {
            InitAction::Project
        },
        project_dir: resolve_project_dir(&env, &cwd),
        global_home_dir,
        official_cache_dir,
        prefetch_official: plan.prefetch_official,
        generated: InitGeneratedValues::generate(),
    };

    match runx_init(&options) {
        Ok(result) => render_init_result(plan.json, &result),
        Err(error) => {
            let _ignored = write_stderr_line(&format!("runx: {error}"));
            ExitCode::from(1)
        }
    }
}

fn write_json<T: serde::Serialize>(command: &str, result: &T) -> ExitCode {
    match serde_json::to_string_pretty(result) {
        Ok(output) => write_stdout_line(&output),
        Err(error) => {
            let _ignored = write_stderr_line(&format!(
                "runx: failed to serialize {command} result: {error}"
            ));
            ExitCode::from(1)
        }
    }
}

fn render_new_result(json: bool, result: &RunxNewResult) -> ExitCode {
    if json {
        return write_json(
            "new",
            &NewJsonResult {
                status: "success",
                new: NewCommandResult {
                    action: "skill",
                    name: &result.name,
                    directory: &result.directory,
                    files: &result.files,
                    next_steps: &result.next_steps,
                },
            },
        );
    }
    write_stdout(&render_key_values(
        "runx new",
        &[
            ("skill", Some(result.name.clone())),
            ("directory", Some(result.directory.display().to_string())),
            ("files", Some(result.files.len().to_string())),
            ("next", Some(result.next_steps.join(" && "))),
        ],
    ))
}

fn render_init_result(json: bool, result: &RunxInitResult) -> ExitCode {
    if json {
        return write_json(
            "init",
            &InitJsonResult {
                status: "success",
                init: result,
            },
        );
    }
    let title = match &result.action {
        InitAction::Global => "runx global init",
        InitAction::Project => "runx project init",
    };
    write_stdout(&render_key_values(
        title,
        &[
            (
                "created",
                Some(if result.created { "yes" } else { "no" }.to_owned()),
            ),
            (
                "project",
                result
                    .project_dir
                    .as_ref()
                    .map(|path| path.display().to_string()),
            ),
            ("project_id", result.project_id.clone()),
            (
                "home",
                result
                    .global_home_dir
                    .as_ref()
                    .map(|path| path.display().to_string()),
            ),
            ("installation_id", result.installation_id.clone()),
            (
                "official_cache",
                result
                    .official_cache_dir
                    .as_ref()
                    .map(|path| path.display().to_string()),
            ),
        ],
    ))
}

fn render_key_values(title: &str, rows: &[(&str, Option<String>)]) -> String {
    let mut output = format!("\n  {title}  success\n\n");
    for (key, value) in rows {
        output.push_str(&format!("  {key}  {}\n", value.as_deref().unwrap_or("-")));
    }
    output.push('\n');
    output
}

fn resolve_new_package_directory(
    name: &str,
    directory: Option<&Path>,
    env: &std::collections::BTreeMap<String, String>,
    cwd: &Path,
) -> PathBuf {
    let root = new_package_base(env, cwd);
    match directory {
        Some(directory) if directory.is_absolute() => directory.to_path_buf(),
        Some(directory) => root.join(directory),
        None => root.join(sanitize_runx_package_name(name)),
    }
}

fn new_package_base(env: &std::collections::BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    env.get("RUNX_CWD")
        .map(|value| absolute_path(value, cwd))
        .or_else(|| env.get("INIT_CWD").map(|value| absolute_path(value, cwd)))
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn resolve_project_dir(env: &std::collections::BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    if let Some(project_dir) = env.get("RUNX_PROJECT_DIR") {
        return resolve_user_path(project_dir, env, cwd);
    }
    find_nearest_project_runx_dir(cwd).unwrap_or_else(|| workspace_base(env, cwd).join(".runx"))
}

fn resolve_global_home_dir(
    env: &std::collections::BTreeMap<String, String>,
    cwd: &Path,
) -> PathBuf {
    env.get("RUNX_HOME")
        .map(|value| resolve_user_path(value, env, cwd))
        .unwrap_or_else(default_home_runx_dir)
}

fn resolve_official_skills_dir(
    env: &std::collections::BTreeMap<String, String>,
    cwd: &Path,
    global_home_dir: &Path,
) -> PathBuf {
    env.get("RUNX_OFFICIAL_SKILLS_DIR")
        .map(|value| resolve_user_path(value, env, cwd))
        .unwrap_or_else(|| global_home_dir.join("official-skills"))
}

fn resolve_user_path(
    value: &str,
    env: &std::collections::BTreeMap<String, String>,
    cwd: &Path,
) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        workspace_base(env, cwd).join(path)
    }
}

fn workspace_base(env: &std::collections::BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    env.get("RUNX_CWD")
        .map(|value| absolute_path(value, cwd))
        .or_else(|| find_runx_workspace_root(cwd))
        .or_else(|| env.get("INIT_CWD").map(|value| absolute_path(value, cwd)))
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn absolute_path(value: &str, cwd: &Path) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

fn find_runx_workspace_root(start: &Path) -> Option<PathBuf> {
    for current in start.ancestors() {
        if current.join("pnpm-workspace.yaml").exists() {
            return Some(current.to_path_buf());
        }
    }
    None
}

fn find_nearest_project_runx_dir(start: &Path) -> Option<PathBuf> {
    for current in start.ancestors() {
        let candidate = current.join(".runx");
        if candidate.join("project.json").exists() {
            return Some(candidate);
        }
    }
    None
}

fn default_home_runx_dir() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".runx")
}

#[derive(Serialize)]
struct NewJsonResult<'a> {
    status: &'static str,
    new: NewCommandResult<'a>,
}

#[derive(Serialize)]
struct NewCommandResult<'a> {
    action: &'static str,
    name: &'a str,
    directory: &'a Path,
    files: &'a [String],
    next_steps: &'a [String],
}

#[derive(Serialize)]
struct InitJsonResult<'a> {
    status: &'static str,
    init: &'a RunxInitResult,
}

fn write_stdout(message: &str) -> ExitCode {
    crate::cli_io::write_stdout_code(message, 0)
}

fn write_stdout_line(message: &str) -> ExitCode {
    crate::cli_io::write_stdout_code(&format!("{message}\n"), 0)
}

fn write_stderr_line(message: &str) -> ExitCode {
    crate::cli_io::write_stderr_code(&format!("{message}\n"))
}

use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use runx_runtime::journal::list_local_history;
use runx_runtime::{
    LocalReceiptStore, ReceiptPathInputs, RuntimeReceiptConfig, resolve_receipt_path,
};

use crate::skill::{SkillAction, SkillPlan};

#[derive(Debug, PartialEq, Eq)]
pub struct ResumePlan {
    pub run_id: String,
    pub answers_path: PathBuf,
    pub receipt_dir: Option<PathBuf>,
    pub json: bool,
}

pub(crate) struct SkillResumeCommand<'a> {
    pub(crate) skill_ref: Option<&'a str>,
    pub(crate) run_id: &'a str,
    pub(crate) selected_runner: Option<&'a str>,
    pub(crate) receipt_dir: Option<&'a Path>,
    pub(crate) answers_path: Option<&'a Path>,
}

pub fn parse_resume_plan(args: &[OsString]) -> Result<ResumePlan, String> {
    if args.first().and_then(|arg| arg.to_str()) != Some("resume") {
        return Err("internal error: resume dispatcher received non-resume command".to_owned());
    }
    let mut receipt_dir = None;
    let mut json = false;
    let mut positionals = Vec::new();
    let mut index = 1;
    while index < args.len() {
        let token = string_arg(args, index)?;
        match token.as_str() {
            "--json" | "-j" => {
                json = true;
                index += 1;
            }
            "--non-interactive" => {
                index += 1;
            }
            value if value.starts_with("--receipt-dir=") => {
                receipt_dir = Some(PathBuf::from(value.trim_start_matches("--receipt-dir=")));
                index += 1;
            }
            value if value.starts_with("--receipts=") => {
                receipt_dir = Some(PathBuf::from(value.trim_start_matches("--receipts=")));
                index += 1;
            }
            value if value.starts_with("-R=") => {
                receipt_dir = Some(PathBuf::from(value.trim_start_matches("-R=")));
                index += 1;
            }
            "--receipt-dir" | "--receipts" | "-R" => {
                index += 1;
                receipt_dir = Some(PathBuf::from(string_arg(args, index)?));
                index += 1;
            }
            value if value.starts_with('-') => {
                return Err(format!("unknown runx resume option {value}"));
            }
            value => {
                positionals.push(value.to_owned());
                index += 1;
            }
        }
    }
    if positionals.len() != 2 {
        return Err("runx resume requires <run-id> <answers.json>".to_owned());
    }
    Ok(ResumePlan {
        run_id: positionals.remove(0),
        answers_path: PathBuf::from(positionals.remove(0)),
        receipt_dir,
        json,
    })
}

pub fn run_native_resume(plan: ResumePlan) -> ExitCode {
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let env = crate::cli_io::env_map();
    let receipt_config = RuntimeReceiptConfig::default();
    let resolved = resolve_receipt_path(ReceiptPathInputs {
        explicit_dir: plan.receipt_dir.as_deref(),
        runtime_config: Some(&receipt_config),
        env: &env,
        cwd: &cwd,
    });
    let store = LocalReceiptStore::new(&resolved.path);
    let history = match list_local_history(
        &store,
        &resolved.workspace_base,
        &resolved.project_runx_dir,
        &Default::default(),
    ) {
        Ok(history) => history,
        Err(error) => {
            return write_resume_failure(
                &format!("could not read receipt history: {error}"),
                plan.json,
                1,
            );
        }
    };
    let Some(pending) = history
        .pending_runs
        .iter()
        .find(|pending| pending.id == plan.run_id)
    else {
        return write_resume_failure(
            &format!("no pending run found for {}", plan.run_id),
            plan.json,
            1,
        );
    };
    let Some(skill_ref) = pending.resume_skill_ref.as_deref() else {
        return write_resume_failure(
            "pending run does not record a resume skill ref; rerun the original skill manually",
            plan.json,
            1,
        );
    };
    let skill_plan = SkillPlan {
        action: SkillAction::Run,
        skill_path: PathBuf::from(skill_ref),
        runner: pending.selected_runner.clone(),
        receipt_dir: plan.receipt_dir,
        run_id: Some(plan.run_id),
        answers: Some(plan.answers_path),
        registry: None,
        expected_digest: None,
        json: plan.json,
        inputs: BTreeMap::new(),
        local_credential: None,
    };
    crate::skill::run_native_skill(skill_plan)
}

pub(crate) fn render_skill_resume_command(command: SkillResumeCommand<'_>) -> String {
    let mut parts = vec![
        "runx".to_owned(),
        "resume".to_owned(),
        shell_token(command.run_id),
    ];
    parts.push(shell_token(
        &command
            .answers_path
            .map_or_else(|| "answers.json".into(), Path::to_string_lossy),
    ));
    if let Some(receipt_dir) = command.receipt_dir {
        parts.push("--receipt-dir".to_owned());
        parts.push(shell_token(&receipt_dir.to_string_lossy()));
    }
    let _legacy_context = (
        command.skill_ref,
        command.selected_runner.and_then(non_empty),
    );
    parts.join(" ")
}

fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn shell_token(value: &str) -> String {
    if value.is_empty() {
        return "''".to_owned();
    }
    if value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '/' | '.' | '_' | '-' | ':' | '@')
    }) {
        return value.to_owned();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn string_arg(args: &[OsString], index: usize) -> Result<String, String> {
    args.get(index)
        .ok_or_else(|| "missing value for runx resume argument".to_owned())?
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "runx resume arguments must be UTF-8".to_owned())
}

fn write_resume_failure(message: &str, json: bool, exit_code: u8) -> ExitCode {
    if json {
        return crate::cli_io::write_stdout_code(
            &crate::router::json_failure_output(message, "resume_error"),
            exit_code,
        );
    }
    let _ignored = writeln!(io::stderr(), "runx: {message}");
    ExitCode::from(exit_code)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{SkillResumeCommand, render_skill_resume_command};

    #[test]
    fn resume_command_quotes_operator_supplied_tokens() {
        let command = render_skill_resume_command(SkillResumeCommand {
            skill_ref: Some("skills/support reply"),
            run_id: "run abc",
            selected_runner: Some("agent task"),
            receipt_dir: Some(Path::new("custom receipts")),
            answers_path: Some(Path::new("my answers.json")),
        });

        assert_eq!(
            command,
            "runx resume 'run abc' 'my answers.json' --receipt-dir 'custom receipts'"
        );
    }

    #[test]
    fn resume_command_uses_safe_defaults_when_metadata_is_missing() {
        let command = render_skill_resume_command(SkillResumeCommand {
            skill_ref: None,
            run_id: "rx_123",
            selected_runner: None,
            receipt_dir: None,
            answers_path: None,
        });

        assert_eq!(command, "runx resume rx_123 answers.json");
    }
}

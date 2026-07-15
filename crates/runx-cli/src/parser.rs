use std::collections::BTreeMap;
use std::env;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use runx_runtime::{ParserEvalError, ParserEvalOutput, evaluate_parser_document_str};
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParserPlan {
    pub input: ParserInputSource,
    pub json: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ParserInputSource {
    Path(PathBuf),
    Stdin,
}

pub fn run_native_parser(plan: ParserPlan) -> ExitCode {
    let cwd = match env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            let error = ParserCliError::CurrentDirectory(error);
            return write_error(&error, plan.json);
        }
    };

    match run_parser_command(&plan, &crate::cli_io::env_map(), &cwd) {
        Ok(output) => crate::cli_io::write_stdout_code(&output.stdout, output.exit_code),
        Err(error) => write_error(&error, plan.json),
    }
}

pub fn run_parser_command(
    plan: &ParserPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<ParserCliOutput, ParserCliError> {
    if !plan.json {
        return Err(ParserCliError::InvalidArgs(
            "runx parser eval requires --json".to_owned(),
        ));
    }

    let raw = read_parser_input(&plan.input, env, cwd)?;
    let result = evaluate_parser_document_str(&raw)?;
    let stdout = serde_json::to_string_pretty(&ParserJsonEnvelope {
        status: "success",
        result: &result,
    })
    .map(|json| format!("{json}\n"))
    .map_err(ParserCliError::Serialize)?;
    Ok(ParserCliOutput {
        stdout,
        exit_code: 0,
    })
}

#[derive(Debug)]
pub struct ParserCliOutput {
    pub stdout: String,
    pub exit_code: u8,
}

#[derive(Debug)]
pub enum ParserCliError {
    CurrentDirectory(io::Error),
    InvalidArgs(String),
    Read(PathBuf, io::Error),
    ReadStdin(io::Error),
    Eval(ParserEvalError),
    Serialize(serde_json::Error),
}

impl ParserCliError {
    fn code(&self) -> &'static str {
        match self {
            Self::CurrentDirectory(_) => "current_directory",
            Self::InvalidArgs(_) => "invalid_args",
            Self::Read(_, _) => "read_input",
            Self::ReadStdin(_) => "read_stdin",
            Self::Eval(error) => error.code(),
            Self::Serialize(_) => "serialize_output",
        }
    }

    fn exit_code(&self) -> u8 {
        match self {
            Self::InvalidArgs(_) => 64,
            Self::CurrentDirectory(_)
            | Self::Read(_, _)
            | Self::ReadStdin(_)
            | Self::Eval(_)
            | Self::Serialize(_) => 1,
        }
    }
}

impl fmt::Display for ParserCliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CurrentDirectory(error) => write!(formatter, "failed to resolve cwd: {error}"),
            Self::InvalidArgs(message) => formatter.write_str(message),
            Self::Read(path, error) => {
                write!(
                    formatter,
                    "failed to read parser input {}: {error}",
                    path.display()
                )
            }
            Self::ReadStdin(error) => {
                write!(formatter, "failed to read parser input stdin: {error}")
            }
            Self::Eval(error) => write!(formatter, "{error}"),
            Self::Serialize(error) => {
                write!(formatter, "failed to serialize parser result: {error}")
            }
        }
    }
}

impl std::error::Error for ParserCliError {}

impl From<ParserEvalError> for ParserCliError {
    fn from(error: ParserEvalError) -> Self {
        Self::Eval(error)
    }
}

#[derive(Serialize)]
struct ParserJsonEnvelope<'a> {
    status: &'static str,
    result: &'a ParserEvalOutput,
}

#[derive(Serialize)]
struct ParserJsonError<'a> {
    status: &'static str,
    code: &'static str,
    message: &'a str,
}

fn read_parser_input(
    source: &ParserInputSource,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<String, ParserCliError> {
    match source {
        ParserInputSource::Path(path) => {
            let resolved = resolve_parser_path(path, env, cwd);
            fs::read_to_string(&resolved).map_err(|error| ParserCliError::Read(resolved, error))
        }
        ParserInputSource::Stdin => {
            let mut raw = String::new();
            io::stdin()
                .read_to_string(&mut raw)
                .map_err(ParserCliError::ReadStdin)?;
            Ok(raw)
        }
    }
}

fn resolve_parser_path(path: &Path, env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    runx_runtime::resolve_runx_workspace_base(env, cwd).join(path)
}

fn write_error(error: &ParserCliError, json: bool) -> ExitCode {
    if json {
        let message = error.to_string();
        match serde_json::to_string_pretty(&ParserJsonError {
            status: "error",
            code: error.code(),
            message: &message,
        }) {
            Ok(body) => {
                return crate::cli_io::write_stdout_code(&format!("{body}\n"), error.exit_code());
            }
            Err(serialize_error) => {
                let _ignored = crate::cli_io::write_stderr_code(&format!(
                    "runx: failed to serialize parser error: {serialize_error}\n"
                ));
                return ExitCode::from(1);
            }
        }
    }

    let _ignored = crate::cli_io::write_stderr_code(&format!("runx: {error}\n"));
    ExitCode::from(error.exit_code())
}

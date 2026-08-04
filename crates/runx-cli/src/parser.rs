use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::Path;
use std::process::ExitCode;

use runx_parser::{ParserEvalError, ParserEvalOutput, evaluate_parser_document_str};
use runx_runtime::WorkspaceEnv;
use serde::Serialize;

use crate::document_input::{DocumentInputError, read_document_input};

pub use crate::document_input::DocumentInputSource as ParserInputSource;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParserPlan {
    pub input: ParserInputSource,
    pub json: bool,
}

pub fn run_native_parser(plan: ParserPlan, workspace: &WorkspaceEnv) -> ExitCode {
    match run_parser_command(&plan, workspace.env(), workspace.cwd()) {
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

    let raw = read_document_input(&plan.input, env, cwd).map_err(ParserCliError::Input)?;
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
    Input(DocumentInputError),
    Eval(ParserEvalError),
    Serialize(serde_json::Error),
}

impl ParserCliError {
    fn code(&self) -> &'static str {
        match self {
            Self::CurrentDirectory(_) => "current_directory",
            Self::InvalidArgs(_) => "invalid_args",
            Self::Input(error) if error.is_stdin() => "read_stdin",
            Self::Input(_) => "read_input",
            Self::Eval(error) => error.code(),
            Self::Serialize(_) => "serialize_output",
        }
    }

    fn exit_code(&self) -> u8 {
        match self {
            Self::InvalidArgs(_) => 64,
            Self::CurrentDirectory(_) | Self::Input(_) | Self::Eval(_) | Self::Serialize(_) => 1,
        }
    }
}

impl fmt::Display for ParserCliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CurrentDirectory(error) => write!(formatter, "failed to resolve cwd: {error}"),
            Self::InvalidArgs(message) => formatter.write_str(message),
            Self::Input(error) => write!(formatter, "failed to read parser input {error}"),
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

fn write_error(error: &ParserCliError, json: bool) -> ExitCode {
    if json {
        return crate::cli_io::write_stdout_code(
            &crate::cli_error::json_failure_output(&error.to_string(), error.code()),
            error.exit_code(),
        );
    }

    let _ignored = crate::cli_io::write_stderr_code(&format!("runx: {error}\n"));
    ExitCode::from(error.exit_code())
}

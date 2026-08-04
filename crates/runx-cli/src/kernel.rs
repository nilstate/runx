use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::Path;
use std::process::ExitCode;

use runx_runtime::WorkspaceEnv;
use runx_runtime::kernel_eval::{KernelEvalError, KernelEvalOutput, evaluate_kernel_document_str};
use serde::Serialize;

use crate::document_input::{DocumentInputError, read_document_input};

pub use crate::document_input::DocumentInputSource as KernelInputSource;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KernelPlan {
    pub input: KernelInputSource,
    pub json: bool,
}

pub fn run_native_kernel(plan: KernelPlan, workspace: &WorkspaceEnv) -> ExitCode {
    match run_kernel_command(&plan, workspace.env(), workspace.cwd()) {
        Ok(output) => crate::cli_io::write_stdout_code(&output.stdout, output.exit_code),
        Err(error) => write_error(&error, plan.json),
    }
}

pub fn run_kernel_command(
    plan: &KernelPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<KernelCliOutput, KernelCliError> {
    if !plan.json {
        return Err(KernelCliError::InvalidArgs(
            "runx kernel eval requires --json".to_owned(),
        ));
    }

    let raw = read_document_input(&plan.input, env, cwd).map_err(KernelCliError::Input)?;
    let result = evaluate_kernel_document_str(&raw)?;
    let stdout = serde_json::to_string_pretty(&KernelJsonEnvelope {
        status: "success",
        result: &result,
    })
    .map(|json| format!("{json}\n"))
    .map_err(KernelCliError::Serialize)?;
    Ok(KernelCliOutput {
        stdout,
        exit_code: 0,
    })
}

#[derive(Debug)]
pub struct KernelCliOutput {
    pub stdout: String,
    pub exit_code: u8,
}

#[derive(Debug)]
pub enum KernelCliError {
    CurrentDirectory(io::Error),
    InvalidArgs(String),
    Input(DocumentInputError),
    Eval(KernelEvalError),
    Serialize(serde_json::Error),
}

impl KernelCliError {
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

impl fmt::Display for KernelCliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CurrentDirectory(error) => write!(formatter, "failed to resolve cwd: {error}"),
            Self::InvalidArgs(message) => formatter.write_str(message),
            Self::Input(error) => write!(formatter, "failed to read kernel input {error}"),
            Self::Eval(error) => write!(formatter, "{error}"),
            Self::Serialize(error) => {
                write!(formatter, "failed to serialize kernel result: {error}")
            }
        }
    }
}

impl std::error::Error for KernelCliError {}

impl From<KernelEvalError> for KernelCliError {
    fn from(error: KernelEvalError) -> Self {
        Self::Eval(error)
    }
}

#[derive(Serialize)]
struct KernelJsonEnvelope<'a> {
    status: &'static str,
    result: &'a KernelEvalOutput,
}

fn write_error(error: &KernelCliError, json: bool) -> ExitCode {
    if json {
        return crate::cli_io::write_stdout_code(
            &crate::cli_error::json_failure_output(&error.to_string(), error.code()),
            error.exit_code(),
        );
    }

    let _ignored = crate::cli_io::write_stderr_code(&format!("runx: {error}\n"));
    ExitCode::from(error.exit_code())
}

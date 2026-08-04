use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::Path;
use std::process::ExitCode;

use runx_pay::{
    PaymentAdmissionError, PaymentAdmissionIssueResponse, PaymentAdmissionRequest,
    PaymentAdmissionSigner,
};
use runx_runtime::WorkspaceEnv;
use serde::Serialize;

use crate::document_input::{DocumentInputError, read_document_input};

pub use crate::document_input::DocumentInputSource as PaymentInputSource;

pub const RUNX_PAYMENT_ADMISSION_KID_ENV: &str = "RUNX_PAYMENT_ADMISSION_KID";
pub const RUNX_PAYMENT_ADMISSION_SIGNING_KEY_ENV: &str =
    "RUNX_INTERNAL_PAYMENT_ADMISSION_SIGNING_KEY";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentPlan {
    pub action: PaymentAction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PaymentAction {
    IssueAdmission(PaymentAdmissionPlan),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentAdmissionPlan {
    pub input: PaymentInputSource,
    pub json: bool,
}

pub fn run_native_payment(plan: PaymentPlan, workspace: &WorkspaceEnv) -> ExitCode {
    match run_payment_command(&plan, workspace.env(), workspace.cwd()) {
        Ok(output) => crate::cli_io::write_stdout_code(&output.stdout, output.exit_code),
        Err(error) => write_error(&error, true),
    }
}

pub fn run_payment_command(
    plan: &PaymentPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<PaymentCliOutput, PaymentCliError> {
    match &plan.action {
        PaymentAction::IssueAdmission(issue) => issue_admission(issue, env, cwd),
    }
}

fn issue_admission(
    plan: &PaymentAdmissionPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<PaymentCliOutput, PaymentCliError> {
    if !plan.json {
        return Err(PaymentCliError::InvalidArgs(
            "runx payment admission issue requires --json".to_owned(),
        ));
    }
    let raw = read_document_input(&plan.input, env, cwd).map_err(PaymentCliError::Input)?;
    let request: PaymentAdmissionRequest =
        serde_json::from_str(&raw).map_err(PaymentCliError::ParseInput)?;
    let kid = non_empty_env(env, RUNX_PAYMENT_ADMISSION_KID_ENV)
        .ok_or(PaymentCliError::MissingSigningEnv)?;
    let seed = non_empty_env(env, RUNX_PAYMENT_ADMISSION_SIGNING_KEY_ENV)
        .ok_or(PaymentCliError::MissingSigningEnv)?;
    let signer = PaymentAdmissionSigner::from_seed_base64(kid, seed)?;
    let result = signer.issue(&request)?;
    let stdout = serde_json::to_string_pretty(&PaymentJsonEnvelope {
        status: "success",
        result: &result,
    })
    .map(|json| format!("{json}\n"))
    .map_err(PaymentCliError::Serialize)?;
    Ok(PaymentCliOutput {
        stdout,
        exit_code: 0,
    })
}

#[derive(Debug)]
pub struct PaymentCliOutput {
    pub stdout: String,
    pub exit_code: u8,
}

#[derive(Debug)]
pub enum PaymentCliError {
    CurrentDirectory(io::Error),
    InvalidArgs(String),
    MissingSigningEnv,
    Input(DocumentInputError),
    ParseInput(serde_json::Error),
    Admission(PaymentAdmissionError),
    Serialize(serde_json::Error),
}

impl PaymentCliError {
    fn code(&self) -> &'static str {
        match self {
            Self::CurrentDirectory(_) => "current_directory",
            Self::InvalidArgs(_) => "invalid_args",
            Self::MissingSigningEnv => "missing_signing_env",
            Self::Input(error) if error.is_stdin() => "read_stdin",
            Self::Input(_) => "read_input",
            Self::ParseInput(_) => "parse_input",
            Self::Admission(_) => "payment_admission",
            Self::Serialize(_) => "serialize_output",
        }
    }

    fn exit_code(&self) -> u8 {
        match self {
            Self::InvalidArgs(_) => 64,
            Self::CurrentDirectory(_)
            | Self::MissingSigningEnv
            | Self::Input(_)
            | Self::ParseInput(_)
            | Self::Admission(_)
            | Self::Serialize(_) => 1,
        }
    }
}

impl fmt::Display for PaymentCliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CurrentDirectory(error) => write!(formatter, "failed to resolve cwd: {error}"),
            Self::InvalidArgs(message) => formatter.write_str(message),
            Self::MissingSigningEnv => write!(
                formatter,
                "runx payment admission issue requires {RUNX_PAYMENT_ADMISSION_KID_ENV} and {RUNX_PAYMENT_ADMISSION_SIGNING_KEY_ENV}",
            ),
            Self::Input(error) => {
                write!(formatter, "failed to read payment admission input {error}")
            }
            Self::ParseInput(error) => write!(
                formatter,
                "failed to parse payment admission input: {error}"
            ),
            Self::Admission(error) => write!(formatter, "{error}"),
            Self::Serialize(error) => write!(
                formatter,
                "failed to serialize payment admission output: {error}"
            ),
        }
    }
}

impl std::error::Error for PaymentCliError {}

impl From<PaymentAdmissionError> for PaymentCliError {
    fn from(error: PaymentAdmissionError) -> Self {
        Self::Admission(error)
    }
}

#[derive(Serialize)]
struct PaymentJsonEnvelope<'a> {
    status: &'static str,
    result: &'a PaymentAdmissionIssueResponse,
}

fn write_error(error: &PaymentCliError, json: bool) -> ExitCode {
    if json {
        return crate::cli_io::write_stdout_code(
            &crate::cli_error::json_failure_output(&error.to_string(), error.code()),
            error.exit_code(),
        );
    }

    let _ignored = crate::cli_io::write_stderr_code(&format!("runx: {error}\n"));
    ExitCode::from(error.exit_code())
}

fn non_empty_env<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn issue_admission_requires_signing_env() {
        let plan = PaymentPlan {
            action: PaymentAction::IssueAdmission(PaymentAdmissionPlan {
                input: PaymentInputSource::Path(PathBuf::from("missing.json")),
                json: true,
            }),
        };
        let env = BTreeMap::new();
        let result = run_payment_command(&plan, &env, Path::new("."));
        assert!(matches!(result, Err(PaymentCliError::Input(_))));
    }
}

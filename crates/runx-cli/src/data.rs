use std::ffi::OsString;
use std::fmt;
use std::process::ExitCode;

use runx_runtime::{EventStoreMigrationProof, EventStoreMigrationRequest, WorkspaceEnv};
use serde::Serialize;

use crate::cli_args::{flag_value, os_arg, split_flag};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataPlan {
    pub database_path: String,
    pub data_source_ref: String,
    pub backup_path: Option<String>,
    pub json: bool,
}

pub fn parse_data_plan(args: &[OsString]) -> Result<DataPlan, String> {
    if args.len() < 2 || os_arg(args, 1, "data")? != "migrate" {
        return Err(
            "usage: runx data migrate --database path --source ref [--backup path] [--json]"
                .to_owned(),
        );
    }
    let mut database_path = None;
    let mut data_source_ref = None;
    let mut backup_path = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let token = os_arg(args, index, "data migrate")?;
        let (flag, inline) = split_flag(token);
        match flag {
            "--database" => {
                let (value, next) = flag_value(args, index, flag, inline, "data migrate")?;
                set_once(&mut database_path, value, flag)?;
                index = next;
            }
            "--source" => {
                let (value, next) = flag_value(args, index, flag, inline, "data migrate")?;
                set_once(&mut data_source_ref, value, flag)?;
                index = next;
            }
            "--backup" => {
                let (value, next) = flag_value(args, index, flag, inline, "data migrate")?;
                set_once(&mut backup_path, value, flag)?;
                index = next;
            }
            "--json" | "-j" if inline.is_none() => {
                json = true;
                index += 1;
            }
            _ => return Err(format!("unknown data migrate argument {token}")),
        }
    }
    Ok(DataPlan {
        database_path: required(database_path, "--database")?,
        data_source_ref: required(data_source_ref, "--source")?,
        backup_path,
        json,
    })
}

pub fn run_native_data(plan: DataPlan, workspace: &WorkspaceEnv) -> ExitCode {
    match run_data_command(&plan, workspace) {
        Ok(output) => crate::cli_io::write_stdout_code(&output, 0),
        Err(error) if plan.json => crate::cli_io::write_stdout_code(
            &crate::cli_error::json_failure_output(&error.to_string(), "event_store_migration"),
            1,
        ),
        Err(error) => {
            let _ignored = crate::cli_io::write_stderr_code(&format!("runx: {error}\n"));
            ExitCode::from(1)
        }
    }
}

pub fn run_data_command(plan: &DataPlan, workspace: &WorkspaceEnv) -> Result<String, DataCliError> {
    let proof = runx_runtime::migrate_event_store(&EventStoreMigrationRequest {
        workspace_root: workspace.cwd().to_path_buf(),
        database_path: plan.database_path.clone(),
        data_source_ref: plan.data_source_ref.clone(),
        backup_path: plan.backup_path.clone(),
    })?;
    if plan.json {
        serde_json::to_string_pretty(&DataJsonEnvelope {
            status: "success",
            result: &proof,
        })
        .map(|value| format!("{value}\n"))
        .map_err(DataCliError::Serialize)
    } else {
        Ok(render_proof(&proof))
    }
}

#[derive(Debug)]
pub enum DataCliError {
    Runtime(runx_runtime::RuntimeError),
    Serialize(serde_json::Error),
}

impl fmt::Display for DataCliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Runtime(error) => write!(formatter, "event-store migration failed: {error}"),
            Self::Serialize(error) => {
                write!(formatter, "failed to serialize migration proof: {error}")
            }
        }
    }
}

impl std::error::Error for DataCliError {}

impl From<runx_runtime::RuntimeError> for DataCliError {
    fn from(error: runx_runtime::RuntimeError) -> Self {
        Self::Runtime(error)
    }
}

#[derive(Serialize)]
struct DataJsonEnvelope<'a> {
    status: &'static str,
    result: &'a EventStoreMigrationProof,
}

fn render_proof(proof: &EventStoreMigrationProof) -> String {
    format!(
        "event-store migration {:?}\ndatabase: {}\nbackup: {}\nevents: {}\nstreams: {}\nsource digest: {}\nresult digest: {}\nverified: {}\n",
        proof.status,
        proof.database_path,
        proof.backup_path.as_deref().unwrap_or("not required"),
        proof.event_count,
        proof.stream_count,
        proof.source_digest,
        proof.result_digest,
        proof.verified,
    )
}

fn required(value: Option<String>, flag: &str) -> Result<String, String> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("data migrate requires {flag}"))
}

fn set_once(target: &mut Option<String>, value: String, flag: &str) -> Result<(), String> {
    if target.replace(value).is_some() {
        return Err(format!("{flag} may be specified only once"));
    }
    Ok(())
}

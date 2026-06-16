// rust-style-allow: large-file - publish keeps CLI parsing, HTTP request
// construction, and user-facing output together until the public receipt API
// stabilizes.
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use runx_contracts::JsonValue;
use runx_runtime::ConfigError;
use runx_runtime::registry::{
    HttpMethod, HttpRequest, RuntimeHttpError, RuntimeHttpHeader, Transport,
};
use serde::{Deserialize, Serialize};

use crate::cli_args::{flag_value, os_arg, split_flag};

#[derive(Debug, Eq, PartialEq)]
pub struct PublishPlan {
    pub receipt_path: PathBuf,
    pub api_base_url: Option<String>,
    pub token: Option<String>,
    pub allow_local_api: bool,
    pub json: bool,
}

#[derive(Debug)]
pub enum PublishCliError {
    MissingReceipt,
    ExtraReceipt,
    UnknownFlag(String),
    ReadReceipt { path: String, message: String },
    InvalidReceiptJson { path: String, message: String },
    MissingToken,
    TransportInit(RuntimeHttpError),
    Config(ConfigError),
    Publish(PublishError),
    Serialize(String),
}

impl fmt::Display for PublishCliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingReceipt => write!(formatter, "runx publish requires a receipt JSON path"),
            Self::ExtraReceipt => write!(
                formatter,
                "runx publish accepts exactly one receipt JSON path"
            ),
            Self::UnknownFlag(flag) => write!(formatter, "unknown publish flag {flag}"),
            Self::ReadReceipt { path, message } => {
                write!(formatter, "failed to read receipt {path}: {message}")
            }
            Self::InvalidReceiptJson { path, message } => {
                write!(formatter, "receipt {path} is not valid JSON: {message}")
            }
            Self::MissingToken => write!(
                formatter,
                "missing public API token; run `runx login`, pass --token, set RUNX_PUBLIC_API_TOKEN, or set RUNX_CONNECT_ACCESS_TOKEN"
            ),
            Self::TransportInit(error) => {
                write!(formatter, "failed to initialize HTTP transport: {error}")
            }
            Self::Config(error) => write!(formatter, "{error}"),
            Self::Publish(error) => write!(formatter, "{error}"),
            Self::Serialize(message) => {
                write!(formatter, "failed to serialize publish result: {message}")
            }
        }
    }
}

impl std::error::Error for PublishCliError {}

impl From<PublishError> for PublishCliError {
    fn from(error: PublishError) -> Self {
        Self::Publish(error)
    }
}

impl From<ConfigError> for PublishCliError {
    fn from(error: ConfigError) -> Self {
        Self::Config(error)
    }
}

#[derive(Debug)]
pub enum PublishError {
    RuntimeHttp(RuntimeHttpError),
    HttpStatus {
        status: u16,
        body: String,
    },
    InvalidJson(String),
    RunxApi {
        code: String,
        detail: String,
        hint: Option<String>,
        retry_after_seconds: Option<u32>,
    },
}

impl fmt::Display for PublishError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RuntimeHttp(error) => write!(formatter, "{error}"),
            Self::HttpStatus { status, body } => {
                write!(formatter, "runx-api publish returned HTTP {status}: {body}")
            }
            Self::InvalidJson(message) => {
                write!(
                    formatter,
                    "runx-api publish returned invalid JSON: {message}"
                )
            }
            Self::RunxApi { code, detail, .. } => {
                write!(
                    formatter,
                    "runx-api publish returned error [{code}]: {detail}"
                )
            }
        }
    }
}

impl std::error::Error for PublishError {}

impl From<RuntimeHttpError> for PublishError {
    fn from(error: RuntimeHttpError) -> Self {
        Self::RuntimeHttp(error)
    }
}

#[derive(Clone, Debug)]
struct PublishOptions<'a> {
    base_url: &'a str,
    token: &'a str,
    receipt: &'a JsonValue,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ReceiptPublishResponse {
    pub status: String,
    #[serde(default)]
    pub replay_status: Option<String>,
    pub digest: String,
    pub public_hash: String,
    pub mode: String,
    pub published: bool,
    #[serde(default)]
    pub public_url: Option<String>,
    #[serde(default)]
    pub receipt_id: Option<String>,
    #[serde(default)]
    pub verdict: Option<JsonValue>,
}

pub fn parse_publish_plan(args: &[OsString]) -> Result<PublishPlan, String> {
    let mut receipt_path = None;
    let mut api_base_url = None;
    let mut token = None;
    let mut allow_local_api = false;
    let mut json = false;
    let mut index = 1;
    while index < args.len() {
        let arg = os_arg(args, index, "publish")?;
        if !arg.starts_with("--") {
            if receipt_path.is_some() {
                return Err(PublishCliError::ExtraReceipt.to_string());
            }
            receipt_path = Some(PathBuf::from(arg));
            index += 1;
            continue;
        }
        let (flag, inline_value) = split_flag(arg);
        match flag {
            "--json" => {
                if inline_value.is_some() {
                    return Err("--json does not take a value".to_owned());
                }
                json = true;
                index += 1;
            }
            "--api-base-url" | "--apiBaseUrl" => {
                let (value, next_index) = flag_value(args, index, flag, inline_value, "publish")?;
                api_base_url = Some(value);
                index = next_index;
            }
            "--token" => {
                let (value, next_index) = flag_value(args, index, flag, inline_value, "publish")?;
                token = Some(value);
                index = next_index;
            }
            "--allow-local-api" | "--allowLocalApi" => {
                if inline_value.is_some() {
                    return Err("--allow-local-api does not take a value".to_owned());
                }
                allow_local_api = true;
                index += 1;
            }
            _ => return Err(PublishCliError::UnknownFlag(flag.to_owned()).to_string()),
        }
    }
    Ok(PublishPlan {
        receipt_path: receipt_path.ok_or_else(|| PublishCliError::MissingReceipt.to_string())?,
        api_base_url,
        token,
        allow_local_api,
        json,
    })
}

pub fn run_native_publish(plan: PublishPlan) -> ExitCode {
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            let _ignored = crate::cli_io::write_stderr(&format!(
                "runx publish: failed to resolve cwd: {error}\n"
            ));
            return ExitCode::from(1);
        }
    };
    match run_publish_command(&plan, &crate::history::env_map(), &cwd) {
        Ok(output) => crate::cli_io::write_stdout_code(&output, 0),
        Err(error) => {
            if plan.json {
                let body = serde_json::json!({
                    "status": "failure",
                    "error": {
                        "message": error.to_string(),
                        "code": "publish_failed",
                    },
                });
                let serialized = serde_json::to_string_pretty(&body)
                    .unwrap_or_else(|_| "{\"status\":\"failure\"}".to_owned());
                return crate::cli_io::write_stdout_code(&format!("{serialized}\n"), 1);
            }
            let _ignored = crate::cli_io::write_stderr(&format!("runx publish: {error}\n"));
            ExitCode::from(1)
        }
    }
}

fn run_publish_command(
    plan: &PublishPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<String, PublishCliError> {
    let receipt = read_receipt_json(&plan.receipt_path)?;
    let base_url = resolve_public_api_base_url(plan, env);
    let token = resolve_publish_token(plan, env, cwd)?.ok_or(PublishCliError::MissingToken)?;
    let transport = crate::public_api::transport(allow_local_api(plan, env))
        .map_err(PublishCliError::TransportInit)?;
    let response = publish_receipt(
        &transport,
        &PublishOptions {
            base_url: &base_url,
            token: &token,
            receipt: &receipt,
        },
    )?;
    render_publish_result(plan.json, &response)
}

fn allow_local_api(plan: &PublishPlan, env: &BTreeMap<String, String>) -> bool {
    crate::public_api::private_network_allowed(
        plan.allow_local_api,
        env,
        "RUNX_PUBLISH_ALLOW_LOCAL_API",
    )
}

fn read_receipt_json(path: &PathBuf) -> Result<JsonValue, PublishCliError> {
    let text = fs::read_to_string(path).map_err(|error| PublishCliError::ReadReceipt {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    serde_json::from_str(&text).map_err(|error| PublishCliError::InvalidReceiptJson {
        path: path.display().to_string(),
        message: error.to_string(),
    })
}

fn resolve_public_api_base_url(plan: &PublishPlan, env: &BTreeMap<String, String>) -> String {
    crate::public_api::resolve_base_url(plan.api_base_url.as_deref(), env)
}

fn resolve_publish_token(
    plan: &PublishPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<Option<String>, PublishCliError> {
    crate::public_api_token::resolve(plan.token.as_deref(), env, cwd).map_err(PublishCliError::from)
}

fn publish_receipt<T: Transport>(
    transport: &T,
    options: &PublishOptions<'_>,
) -> Result<ReceiptPublishResponse, PublishError> {
    let body = serde_json::json!({
        "publish": true,
        "receipt": options.receipt,
    })
    .to_string();
    let response = transport.send(HttpRequest {
        method: HttpMethod::Post,
        url: format!(
            "{}/v1/receipts/notarize",
            options.base_url.trim_end_matches('/')
        ),
        headers: vec![
            RuntimeHttpHeader::new("authorization", format!("Bearer {}", options.token)),
            RuntimeHttpHeader::new("content-type", "application/json"),
        ],
        body: Some(body),
    })?;
    if !(200..=299).contains(&response.status) {
        if let Some(error) = crate::public_api::parse_error(&response.body) {
            return Err(PublishError::RunxApi {
                code: error.code,
                detail: error.detail,
                hint: error.hint,
                retry_after_seconds: error.retry_after_seconds,
            });
        }
        return Err(PublishError::HttpStatus {
            status: response.status,
            body: response.body,
        });
    }
    serde_json::from_str(&response.body)
        .map_err(|error| PublishError::InvalidJson(error.to_string()))
}

fn render_publish_result(
    json: bool,
    response: &ReceiptPublishResponse,
) -> Result<String, PublishCliError> {
    if json {
        return serde_json::to_string_pretty(response)
            .map(|value| format!("{value}\n"))
            .map_err(|error| PublishCliError::Serialize(error.to_string()));
    }
    let mut out = String::new();
    let verb = if response.published {
        "published"
    } else {
        "notarized"
    };
    out.push_str(&format!(
        "{verb} receipt {} ({})\n",
        response.digest, response.mode
    ));
    out.push_str(&format!("  status:      {}\n", response.status));
    out.push_str(&format!("  published:   {}\n", response.published));
    out.push_str(&format!("  public hash: {}\n", response.public_hash));
    if let Some(receipt_id) = &response.receipt_id {
        out.push_str(&format!("  receipt id:  {receipt_id}\n"));
    }
    if let Some(url) = &response.public_url {
        out.push_str(&format!("  public url:  {url}\n"));
    }
    if let Some(replay_status) = &response.replay_status {
        out.push_str(&format!("  replay:      {replay_status}\n"));
    }
    if let Some(verdict) = &response.verdict {
        out.push_str(&format!(
            "  verdict:     {}\n",
            compact_json(verdict).map_err(|error| PublishCliError::Serialize(error.to_string()))?
        ));
    }
    Ok(out)
}

fn compact_json(value: &JsonValue) -> Result<String, serde_json::Error> {
    serde_json::to_string(value)
}

#[cfg(test)]
#[path = "publish_tests.rs"]
mod publish_tests;

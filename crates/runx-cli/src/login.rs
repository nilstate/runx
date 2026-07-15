// rust-style-allow: large-file - public API login keeps parse, HTTP exchange,
// encrypted-token storage, and focused tests together while the public auth API
// is still small.
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::path::Path;
use std::process::{Command, ExitCode};
use std::thread;
use std::time::{Duration, Instant};

use runx_runtime::registry::{
    HttpMethod, HttpRequest, RuntimeHttpError, RuntimeHttpHeader, Transport,
};
use serde::Deserialize;

use crate::cli_args::{flag_value, os_arg, split_flag};

const DEFAULT_LOGIN_TIMEOUT_SECONDS: u64 = 180;

#[derive(Debug, Eq, PartialEq)]
pub struct LoginPlan {
    pub api_base_url: Option<String>,
    pub provider: Option<String>,
    pub purpose: Option<String>,
    pub from_gh: bool,
    pub allow_local_api: bool,
    pub json: bool,
}

#[derive(Debug)]
pub enum LoginCliError {
    UnknownFlag(String),
    TransportInit(RuntimeHttpError),
    Http(LoginHttpError),
    MissingSigninUrl,
    LoginTimedOut,
    MissingToken,
    MissingPrincipal,
    InvalidFromGhProvider,
    GithubCliUnavailable(std::io::Error),
    GithubCliFailed,
    MissingGithubCliToken,
    Environment(String),
    Serialize(serde_json::Error),
}

impl fmt::Display for LoginCliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownFlag(flag) => write!(formatter, "unknown login flag {flag}"),
            Self::TransportInit(error) => {
                write!(formatter, "failed to initialize HTTP transport: {error}")
            }
            Self::Http(error) => write!(formatter, "{error}"),
            Self::MissingSigninUrl => write!(
                formatter,
                "public API login response did not include a browser sign-in URL"
            ),
            Self::LoginTimedOut => {
                write!(formatter, "public API login timed out before completion")
            }
            Self::MissingToken => {
                write!(formatter, "public API login completed without an API token")
            }
            Self::MissingPrincipal => {
                write!(
                    formatter,
                    "public API login completed without a principal identity"
                )
            }
            Self::InvalidFromGhProvider => {
                write!(formatter, "--from-gh is only valid with --provider github")
            }
            Self::GithubCliUnavailable(error) => write!(
                formatter,
                "failed to run `gh auth token`: {error}; install GitHub CLI and run `gh auth login`"
            ),
            Self::GithubCliFailed => write!(
                formatter,
                "`gh auth token` failed; run `gh auth login` and retry"
            ),
            Self::MissingGithubCliToken => write!(
                formatter,
                "`gh auth token` returned no credential; run `gh auth login` and retry"
            ),
            Self::Environment(error) => write!(formatter, "{error}"),
            Self::Serialize(error) => {
                write!(formatter, "failed to serialize login result: {error}")
            }
        }
    }
}

impl std::error::Error for LoginCliError {}

impl From<crate::public_api::ApiEnvironmentError> for LoginCliError {
    fn from(error: crate::public_api::ApiEnvironmentError) -> Self {
        Self::Environment(error.to_string())
    }
}

impl From<LoginHttpError> for LoginCliError {
    fn from(error: LoginHttpError) -> Self {
        Self::Http(error)
    }
}

impl From<serde_json::Error> for LoginCliError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialize(error)
    }
}

#[derive(Debug)]
pub enum LoginHttpError {
    RuntimeHttp(RuntimeHttpError),
    HttpStatus { status: u16, body: String },
    InvalidJson(String),
    RunxApi { code: String, detail: String },
}

impl fmt::Display for LoginHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RuntimeHttp(error) => write!(formatter, "{error}"),
            Self::HttpStatus { status, body } => {
                write!(formatter, "runx-api login returned HTTP {status}: {body}")
            }
            Self::InvalidJson(message) => {
                write!(formatter, "runx-api login returned invalid JSON: {message}")
            }
            Self::RunxApi { code, detail } => {
                write!(
                    formatter,
                    "runx-api login returned error [{code}]: {detail}"
                )
            }
        }
    }
}

impl std::error::Error for LoginHttpError {}

impl From<RuntimeHttpError> for LoginHttpError {
    fn from(error: RuntimeHttpError) -> Self {
        Self::RuntimeHttp(error)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct LoginStartResponse {
    status: String,
    session_id: String,
    login_token: String,
    #[serde(default)]
    authorization_url: Option<String>,
    #[serde(default)]
    poll_after_ms: Option<u64>,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
struct LoginStartRequest<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    purpose: Option<&'a str>,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
struct LoginCompleteRequest<'a> {
    login_token: &'a str,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct LoginCompleteResponse {
    status: String,
    session_id: String,
    #[serde(default)]
    principal_id: Option<String>,
    #[serde(default)]
    credential_id: Option<String>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    poll_after_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct ProviderTokenLoginResponse {
    status: String,
    principal_id: String,
    credential_id: String,
    token: String,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
struct LoginResult {
    status: &'static str,
    principal_id: String,
    credential_id: String,
}

// rust-style-allow: long-function -- login flag parsing stays in one linear pass
// so every accepted spelling and value rule is visible together.
pub fn parse_login_plan(args: &[OsString]) -> Result<LoginPlan, String> {
    let mut api_base_url = None;
    let mut provider = None;
    let mut purpose = None;
    let mut from_gh = false;
    let mut allow_local_api = false;
    let mut json = false;
    let mut index = 1;
    while index < args.len() {
        let arg = os_arg(args, index, "login")?;
        if !arg.starts_with('-') {
            return Err(format!("unexpected login argument {arg}"));
        }
        let (flag, inline_value) = split_flag(arg);
        match flag {
            "--json" | "-j" => {
                if inline_value.is_some() {
                    return Err("--json does not take a value".to_owned());
                }
                json = true;
                index += 1;
            }
            "--api-base-url" => {
                let (value, next_index) = flag_value(args, index, flag, inline_value, "login")?;
                api_base_url = Some(value);
                index = next_index;
            }
            "--provider" => {
                let (value, next_index) = flag_value(args, index, flag, inline_value, "login")?;
                provider = Some(value);
                index = next_index;
            }
            "--for" | "--purpose" => {
                let (value, next_index) = flag_value(args, index, flag, inline_value, "login")?;
                purpose = Some(value);
                index = next_index;
            }
            "--allow-local-api" => {
                if inline_value.is_some() {
                    return Err("--allow-local-api does not take a value".to_owned());
                }
                allow_local_api = true;
                index += 1;
            }
            "--from-gh" => {
                if inline_value.is_some() {
                    return Err("--from-gh does not take a value".to_owned());
                }
                from_gh = true;
                index += 1;
            }
            _ => return Err(LoginCliError::UnknownFlag(flag.to_owned()).to_string()),
        }
    }
    Ok(LoginPlan {
        api_base_url,
        provider,
        purpose,
        from_gh,
        allow_local_api,
        json,
    })
}

pub fn run_native_login(plan: LoginPlan) -> ExitCode {
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            let _ignored = crate::cli_io::write_stderr(&format!(
                "runx login: failed to resolve cwd: {error}\n"
            ));
            return ExitCode::from(1);
        }
    };
    match run_login_command(&plan, &crate::history::env_map(), &cwd) {
        Ok(output) => crate::cli_io::write_stdout_code(&output, 0),
        Err(error) => {
            if plan.json {
                let body = serde_json::json!({
                    "status": "failure",
                    "error": {
                        "message": error.to_string(),
                        "code": "login_failed",
                    },
                });
                let serialized = serde_json::to_string_pretty(&body)
                    .unwrap_or_else(|_| "{\"status\":\"failure\"}".to_owned());
                return crate::cli_io::write_stdout_code(&format!("{serialized}\n"), 1);
            }
            let _ignored = crate::cli_io::write_stderr(&format!("runx login: {error}\n"));
            ExitCode::from(1)
        }
    }
}

pub fn run_login_command(
    plan: &LoginPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<String, LoginCliError> {
    let transport = crate::public_api::transport(allow_local_api(plan, env))
        .map_err(LoginCliError::TransportInit)?;
    if plan.from_gh {
        validate_from_gh_provider(plan)?;
        let github_token = github_cli_token()?;
        return run_provider_token_login_with_transport(plan, env, cwd, &transport, &github_token);
    }
    run_login_command_with_transport(plan, env, cwd, &transport, thread::sleep)
}

fn run_provider_token_login_with_transport<T: Transport>(
    plan: &LoginPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
    transport: &T,
    github_token: &str,
) -> Result<String, LoginCliError> {
    validate_from_gh_provider(plan)?;
    let environment = crate::public_api::ApiEnvironment::resolve_unauthenticated(
        plan.api_base_url.as_deref(),
        env,
        cwd,
    )?;
    let base_url = environment.base_url();
    let completed = exchange_provider_token(
        transport,
        base_url,
        plan.provider.as_deref().unwrap_or("github"),
        plan.purpose.as_deref(),
        github_token,
    )?;
    if completed.status != "success" || completed.token.trim().is_empty() {
        return Err(LoginCliError::MissingToken);
    }
    let principal_id = completed.principal_id.trim();
    if principal_id.is_empty() {
        return Err(LoginCliError::MissingPrincipal);
    }
    crate::public_api::store_authenticated_environment(
        env,
        cwd,
        base_url,
        principal_id,
        &completed.token,
    )?;
    render_login_result(
        plan.json,
        &LoginResult {
            status: "success",
            principal_id: principal_id.to_owned(),
            credential_id: completed.credential_id,
        },
    )
}

fn validate_from_gh_provider(plan: &LoginPlan) -> Result<(), LoginCliError> {
    if plan
        .provider
        .as_deref()
        .is_some_and(|provider| provider != "github")
    {
        return Err(LoginCliError::InvalidFromGhProvider);
    }
    Ok(())
}

fn github_cli_token() -> Result<String, LoginCliError> {
    let output = Command::new("gh")
        .args(["auth", "token"])
        .output()
        .map_err(LoginCliError::GithubCliUnavailable)?;
    if !output.status.success() {
        return Err(LoginCliError::GithubCliFailed);
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if token.is_empty() || token.chars().any(char::is_whitespace) {
        return Err(LoginCliError::MissingGithubCliToken);
    }
    Ok(token)
}

fn run_login_command_with_transport<T: Transport>(
    plan: &LoginPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
    transport: &T,
    sleep: impl Fn(Duration),
) -> Result<String, LoginCliError> {
    let environment = crate::public_api::ApiEnvironment::resolve_unauthenticated(
        plan.api_base_url.as_deref(),
        env,
        cwd,
    )?;
    let base_url = environment.base_url();
    let started = start_login_session(
        transport,
        base_url,
        plan.provider.as_deref(),
        plan.purpose.as_deref(),
    )?;
    let signin_url = started
        .authorization_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or(LoginCliError::MissingSigninUrl)?;
    if !plan.json {
        let _ignored = crate::cli_io::write_stderr(&format!(
            "Open this URL to sign in to runx:\n{signin_url}\n\nWaiting for public API login...\n"
        ));
    }
    let completed = wait_for_login_completion(transport, base_url, &started, &sleep)?;
    let token = completed
        .token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or(LoginCliError::MissingToken)?;
    let principal_id = completed
        .principal_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or(LoginCliError::MissingPrincipal)?;
    crate::public_api::store_authenticated_environment(env, cwd, base_url, principal_id, token)?;
    render_login_result(
        plan.json,
        &LoginResult {
            status: "success",
            principal_id: principal_id.to_owned(),
            credential_id: completed.credential_id.unwrap_or_default(),
        },
    )
}

fn wait_for_login_completion<T: Transport>(
    transport: &T,
    base_url: &str,
    started: &LoginStartResponse,
    sleep: &impl Fn(Duration),
) -> Result<LoginCompleteResponse, LoginCliError> {
    let deadline = Instant::now() + Duration::from_secs(DEFAULT_LOGIN_TIMEOUT_SECONDS);
    let mut poll_after = Duration::from_millis(started.poll_after_ms.unwrap_or(1000));
    loop {
        let completed = complete_login_session(
            transport,
            base_url,
            &started.session_id,
            &started.login_token,
        )?;
        if completed.status == "success" {
            return Ok(completed);
        }
        if Instant::now() >= deadline {
            return Err(LoginCliError::LoginTimedOut);
        }
        if let Some(next_poll_after) = completed.poll_after_ms {
            poll_after = Duration::from_millis(next_poll_after);
        }
        sleep(poll_after);
    }
}

fn allow_local_api(plan: &LoginPlan, env: &BTreeMap<String, String>) -> bool {
    crate::public_api::private_network_allowed(plan.allow_local_api, env)
}

fn start_login_session<T: Transport>(
    transport: &T,
    base_url: &str,
    provider: Option<&str>,
    purpose: Option<&str>,
) -> Result<LoginStartResponse, LoginHttpError> {
    let request = LoginStartRequest {
        provider: provider.map(str::trim).filter(|value| !value.is_empty()),
        purpose: purpose.map(str::trim).filter(|value| !value.is_empty()),
    };
    let response = transport.send(HttpRequest {
        method: HttpMethod::Post,
        url: format!("{}/v1/login/sessions", base_url.trim_end_matches('/')),
        headers: vec![RuntimeHttpHeader::new("content-type", "application/json")],
        body: Some(
            serde_json::to_string(&request)
                .map_err(|error| LoginHttpError::InvalidJson(error.to_string()))?,
        ),
    })?;
    json_response(response.status, &response.body)
}

fn complete_login_session<T: Transport>(
    transport: &T,
    base_url: &str,
    session_id: &str,
    login_token: &str,
) -> Result<LoginCompleteResponse, LoginHttpError> {
    let body = serde_json::to_string(&LoginCompleteRequest { login_token })
        .map_err(|error| LoginHttpError::InvalidJson(error.to_string()))?;
    let response = transport.send(HttpRequest {
        method: HttpMethod::Post,
        url: format!(
            "{}/v1/login/sessions/{}/complete",
            base_url.trim_end_matches('/'),
            session_id
        ),
        headers: vec![RuntimeHttpHeader::new("content-type", "application/json")],
        body: Some(body),
    })?;
    json_response(response.status, &response.body)
}

fn exchange_provider_token<T: Transport>(
    transport: &T,
    base_url: &str,
    provider: &str,
    purpose: Option<&str>,
    github_token: &str,
) -> Result<ProviderTokenLoginResponse, LoginHttpError> {
    let request = LoginStartRequest {
        provider: Some(provider),
        purpose: purpose.map(str::trim).filter(|value| !value.is_empty()),
    };
    let response = transport.send(HttpRequest {
        method: HttpMethod::Post,
        url: format!("{}/v1/login/provider-token", base_url.trim_end_matches('/')),
        headers: vec![
            RuntimeHttpHeader::new("content-type", "application/json"),
            RuntimeHttpHeader::new("authorization", format!("Bearer {github_token}")),
        ],
        body: Some(
            serde_json::to_string(&request)
                .map_err(|error| LoginHttpError::InvalidJson(error.to_string()))?,
        ),
    })?;
    json_response(response.status, &response.body)
}

fn json_response<T: for<'de> Deserialize<'de>>(
    status: u16,
    body: &str,
) -> Result<T, LoginHttpError> {
    if !(200..=299).contains(&status) {
        if let Some(error) = crate::public_api::parse_error(body) {
            return Err(LoginHttpError::RunxApi {
                code: error.code,
                detail: error.detail,
            });
        }
        return Err(LoginHttpError::HttpStatus {
            status,
            body: body.to_owned(),
        });
    }
    serde_json::from_str(body).map_err(|error| LoginHttpError::InvalidJson(error.to_string()))
}

fn render_login_result(json: bool, result: &LoginResult) -> Result<String, LoginCliError> {
    if json {
        return serde_json::to_string_pretty(result)
            .map(|value| format!("{value}\n"))
            .map_err(LoginCliError::Serialize);
    }
    Ok(format!(
        "\n  ✓  login  success\n  principal     {}\n  credential    {}\n\n",
        result.principal_id, result.credential_id
    ))
}

#[cfg(test)]
#[path = "login_tests.rs"]
mod login_tests;

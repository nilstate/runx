use std::ffi::OsString;

use serde_json::{Map, Value};

use crate::cli_args::{flag_value, os_arg, split_flag};

#[derive(Clone, Debug, PartialEq)]
pub struct ConnectPlan {
    pub action: ConnectAction,
    pub api_base_url: Option<String>,
    pub token: Option<String>,
    pub allow_local_api: bool,
    pub json: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ConnectAction {
    List,
    Start(ConnectStartPlan),
    Status { session_id: String },
    Revoke { grant_id: String },
    Invoke(ConnectInvokePlan),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectStartPlan {
    pub provider: String,
    pub scopes: Vec<String>,
    pub scope_family: Option<String>,
    pub authority_kind: Option<String>,
    pub target_repo: Option<String>,
    pub target_locator: Option<String>,
    pub binding_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConnectInvokePlan {
    pub grant_id: String,
    pub operation: String,
    pub input: Map<String, Value>,
}

#[derive(Default)]
struct ParsedConnectArgs {
    api_base_url: Option<String>,
    token: Option<String>,
    allow_local_api: bool,
    json: bool,
    scopes: Vec<String>,
    scope_family: Option<String>,
    authority_kind: Option<String>,
    target_repo: Option<String>,
    target_locator: Option<String>,
    binding_id: Option<String>,
    grant_id: Option<String>,
    operation: Option<String>,
    input: Option<Map<String, Value>>,
    positional: Vec<String>,
}

pub fn parse_connect_plan(args: &[OsString]) -> Result<ConnectPlan, String> {
    let subcommand = args
        .get(1)
        .and_then(|value| value.to_str())
        .ok_or_else(|| "runx connect requires list, start, status, invoke, or revoke".to_owned())?;
    let mut parsed = parse_args(args)?;
    let action = connect_action(subcommand, &mut parsed)?;
    Ok(ConnectPlan {
        action,
        api_base_url: parsed.api_base_url,
        token: parsed.token,
        allow_local_api: parsed.allow_local_api,
        json: parsed.json,
    })
}

fn parse_args(args: &[OsString]) -> Result<ParsedConnectArgs, String> {
    let mut parsed = ParsedConnectArgs::default();
    let mut index = 2;
    while index < args.len() {
        let arg = os_arg(args, index, "connect")?;
        if !arg.starts_with('-') {
            parsed.positional.push(arg.to_owned());
            index += 1;
            continue;
        }
        let (flag, inline_value) = split_flag(arg);
        if apply_switch(&mut parsed, flag, inline_value)? {
            index += 1;
            continue;
        }
        if !takes_value(flag) {
            return Err(format!("unknown connect flag {flag}"));
        }
        let (value, next) = flag_value(args, index, flag, inline_value, "connect")?;
        apply_value(&mut parsed, flag, value)?;
        index = next;
    }
    Ok(parsed)
}

fn apply_switch(
    parsed: &mut ParsedConnectArgs,
    flag: &str,
    inline_value: Option<&str>,
) -> Result<bool, String> {
    let target = match flag {
        "--json" | "-j" => Some(&mut parsed.json),
        "--allow-local-api" => Some(&mut parsed.allow_local_api),
        _ => None,
    };
    let Some(target) = target else {
        return Ok(false);
    };
    if inline_value.is_some() {
        return Err(format!("{flag} does not take a value"));
    }
    *target = true;
    Ok(true)
}

fn takes_value(flag: &str) -> bool {
    matches!(
        flag,
        "--api-base-url"
            | "--token"
            | "--scope"
            | "--scope-family"
            | "--authority-kind"
            | "--target-repo"
            | "--target-locator"
            | "--binding"
            | "--grant"
            | "--operation"
            | "--input"
    )
}

fn apply_value(parsed: &mut ParsedConnectArgs, flag: &str, value: String) -> Result<(), String> {
    match flag {
        "--api-base-url" => parsed.api_base_url = Some(value),
        "--token" => parsed.token = Some(value),
        "--scope" if !parsed.scopes.contains(&value) => parsed.scopes.push(value),
        "--scope" => {}
        "--scope-family" => parsed.scope_family = Some(value),
        "--authority-kind" => parsed.authority_kind = Some(value),
        "--target-repo" => parsed.target_repo = Some(value),
        "--target-locator" => parsed.target_locator = Some(value),
        "--binding" => parsed.binding_id = Some(value),
        "--grant" => parsed.grant_id = Some(value),
        "--operation" => parsed.operation = Some(value),
        "--input" => parsed.input = Some(parse_input(&value)?),
        _ => return Err(format!("unknown connect flag {flag}")),
    }
    Ok(())
}

fn parse_input(value: &str) -> Result<Map<String, Value>, String> {
    let parsed = serde_json::from_str::<Value>(value)
        .map_err(|error| format!("--input must be valid JSON: {error}"))?;
    let Value::Object(object) = parsed else {
        return Err("--input must be a JSON object".to_owned());
    };
    Ok(object)
}

fn connect_action(
    subcommand: &str,
    parsed: &mut ParsedConnectArgs,
) -> Result<ConnectAction, String> {
    match subcommand {
        "list" if parsed.positional.is_empty() => Ok(ConnectAction::List),
        "start" if parsed.positional.len() == 1 => start_action(parsed),
        "status" if parsed.positional.len() == 1 => Ok(ConnectAction::Status {
            session_id: path_identifier("session id", parsed.positional.remove(0))?,
        }),
        "revoke" if parsed.positional.len() == 1 => Ok(ConnectAction::Revoke {
            grant_id: path_identifier("grant id", parsed.positional.remove(0))?,
        }),
        "invoke" if parsed.positional.is_empty() => invoke_action(parsed),
        "list" | "start" | "status" | "revoke" | "invoke" => {
            Err(format!("invalid arguments for runx connect {subcommand}"))
        }
        _ => Err(format!("unknown connect subcommand {subcommand}")),
    }
}

fn start_action(parsed: &mut ParsedConnectArgs) -> Result<ConnectAction, String> {
    if parsed.scopes.is_empty() {
        return Err("runx connect start requires at least one --scope capability".to_owned());
    }
    Ok(ConnectAction::Start(ConnectStartPlan {
        provider: parsed.positional.remove(0),
        scopes: std::mem::take(&mut parsed.scopes),
        scope_family: parsed.scope_family.take(),
        authority_kind: parsed.authority_kind.take(),
        target_repo: parsed.target_repo.take(),
        target_locator: parsed.target_locator.take(),
        binding_id: parsed.binding_id.take(),
    }))
}

fn invoke_action(parsed: &mut ParsedConnectArgs) -> Result<ConnectAction, String> {
    let grant_id = parsed
        .grant_id
        .take()
        .ok_or_else(|| "runx connect invoke requires --grant".to_owned())?;
    let operation = parsed
        .operation
        .take()
        .ok_or_else(|| "runx connect invoke requires --operation".to_owned())?;
    Ok(ConnectAction::Invoke(ConnectInvokePlan {
        grant_id: path_identifier("grant id", grant_id)?,
        operation: provider_operation(operation)?,
        input: parsed.input.take().unwrap_or_default(),
    }))
}

fn path_identifier(label: &str, value: String) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 200
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '?' | '#'))
    {
        return Err(format!(
            "runx connect {label} must be a safe, non-empty URL path identifier"
        ));
    }
    Ok(value.to_owned())
}

fn provider_operation(value: String) -> Result<String, String> {
    let value = value.trim();
    let mut segments = value.split('.');
    let first = segments.next().unwrap_or_default();
    if value.len() > 100
        || !valid_operation_segment(first)
        || !segments.next().is_some_and(valid_operation_segment)
        || !segments.all(valid_operation_segment)
    {
        return Err(
            "runx connect operation must use a dotted lowercase capability such as thread.reply"
                .to_owned(),
        );
    }
    Ok(value.to_owned())
}

fn valid_operation_segment(segment: &str) -> bool {
    let mut characters = segment.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_lowercase())
        && characters.all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
}

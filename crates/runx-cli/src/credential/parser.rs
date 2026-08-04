use std::ffi::OsString;

use crate::cli_args::{os_arg, split_flag};

use super::{CredentialAction, CredentialBindingTarget, CredentialPlan};

pub fn parse_credential_plan(args: &[OsString]) -> Result<CredentialPlan, String> {
    if os_arg(args, 0, "credential")? != "credential" {
        return Err("credential parser requires the credential command".to_owned());
    }
    let subcommand = args
        .get(1)
        .and_then(|value| value.to_str())
        .ok_or_else(|| "runx credential requires set, list, remove, or bind".to_owned())?;
    match subcommand {
        "set" => parse_set(args),
        "list" => parse_list(args),
        "remove" => parse_remove(args),
        "bind" => parse_bind(args),
        _ => Err(format!("unknown credential subcommand {subcommand}")),
    }
}

fn parse_set(args: &[OsString]) -> Result<CredentialPlan, String> {
    let provider = positional(args, 2, "runx credential set requires <provider>")?;
    let mut profile = None;
    let mut auth_mode = "api_key".to_owned();
    let mut audience = None;
    let mut from_stdin = false;
    let mut json = false;
    let mut index = 3;
    while index < args.len() {
        let token = os_arg(args, index, "credential")?;
        if !token.starts_with('-') {
            return Err(
                "credential secret material must be provided through --from-stdin".to_owned(),
            );
        }
        let (flag, inline) = split_flag(token);
        match flag {
            "--profile" => profile = Some(flag_value(args, &mut index, flag, inline)?),
            "--auth-mode" => auth_mode = flag_value(args, &mut index, flag, inline)?,
            "--audience" => audience = Some(flag_value(args, &mut index, flag, inline)?),
            "--from-stdin" => {
                reject_inline(flag, inline)?;
                from_stdin = true;
            }
            "--json" | "-j" => {
                reject_inline(flag, inline)?;
                json = true;
            }
            _ => return Err(format!("unknown credential set flag {flag}")),
        }
        index += 1;
    }
    if !from_stdin {
        return Err("runx credential set requires --from-stdin".to_owned());
    }
    Ok(CredentialPlan {
        action: CredentialAction::Set {
            profile: profile.unwrap_or_else(|| provider.clone()),
            provider,
            auth_mode,
            audience,
            from_stdin,
        },
        json,
    })
}

fn parse_list(args: &[OsString]) -> Result<CredentialPlan, String> {
    let json = parse_json_only(args, 2, "credential list")?;
    Ok(CredentialPlan {
        action: CredentialAction::List,
        json,
    })
}

fn parse_remove(args: &[OsString]) -> Result<CredentialPlan, String> {
    let profile = positional(args, 2, "runx credential remove requires <profile>")?;
    let json = parse_json_only(args, 3, "credential remove")?;
    Ok(CredentialPlan {
        action: CredentialAction::Remove { profile },
        json,
    })
}

fn parse_bind(args: &[OsString]) -> Result<CredentialPlan, String> {
    let profile = positional(args, 2, "runx credential bind requires <profile>")?;
    let mut provider = None;
    let mut skill = None;
    let mut credential = None;
    let mut json = false;
    let mut index = 3;
    while index < args.len() {
        let token = os_arg(args, index, "credential")?;
        let (flag, inline) = split_flag(token);
        match flag {
            "--provider" => provider = Some(flag_value(args, &mut index, flag, inline)?),
            "--skill" => skill = Some(flag_value(args, &mut index, flag, inline)?),
            "--credential" => credential = Some(flag_value(args, &mut index, flag, inline)?),
            "--json" | "-j" => {
                reject_inline(flag, inline)?;
                json = true;
            }
            _ => return Err(format!("unknown credential bind flag {flag}")),
        }
        index += 1;
    }
    let target = match (provider, skill, credential) {
        (Some(provider), None, None) => CredentialBindingTarget::Provider(provider),
        (None, Some(skill), Some(credential)) => {
            CredentialBindingTarget::Skill { skill, credential }
        }
        _ => {
            return Err(
                "runx credential bind requires either --provider <provider> or --skill <skill> --credential <name>"
                    .to_owned(),
            );
        }
    };
    Ok(CredentialPlan {
        action: CredentialAction::Bind { profile, target },
        json,
    })
}

fn positional(args: &[OsString], index: usize, message: &str) -> Result<String, String> {
    args.get(index)
        .and_then(|value| value.to_str())
        .filter(|value| !value.starts_with('-') && !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| message.to_owned())
}

fn flag_value(
    args: &[OsString],
    index: &mut usize,
    flag: &str,
    inline: Option<&str>,
) -> Result<String, String> {
    let value = if let Some(value) = inline {
        value.to_owned()
    } else {
        *index += 1;
        os_arg(args, *index, "credential")?.to_owned()
    };
    if value.trim().is_empty() {
        return Err(format!("{flag} requires a non-empty value"));
    }
    Ok(value)
}

fn reject_inline(flag: &str, inline: Option<&str>) -> Result<(), String> {
    if inline.is_some() {
        return Err(format!("{flag} does not take a value"));
    }
    Ok(())
}

fn parse_json_only(args: &[OsString], start: usize, command: &str) -> Result<bool, String> {
    let mut json = false;
    for index in start..args.len() {
        match os_arg(args, index, "credential")? {
            "--json" | "-j" => json = true,
            token => return Err(format!("runx {command} does not accept {token}")),
        }
    }
    Ok(json)
}

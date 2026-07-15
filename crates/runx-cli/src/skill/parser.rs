// rust-style-allow: large-file - skill CLI parsing keeps shared state and
// option finalization in one module until the native parser surface stabilizes.
use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::JsonValue;
use runx_runtime::orchestrator::LocalCredentialDescriptor;
use runx_runtime::{resolve_path_from_user_input, resolve_runx_home_dir};
use serde::Deserialize;

use super::inputs::{parse_direct_input_arg, parse_input_arg, parse_json_input_arg};
use super::{SkillAction, SkillPlan};

pub fn parse_skill_plan(args: &[OsString]) -> Result<SkillPlan, String> {
    let mut state = SkillParseState::default();
    let mut index = 1;

    while index < args.len() {
        index = parse_skill_arg(args, index, &mut state)?;
        index += 1;
    }

    let env = env::vars().collect();
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let local_credential = finalize_local_credential(&state, &env, &cwd)?;

    let Some(skill_path) = state.skill_path.as_ref() else {
        return Err("runx skill requires a skill package path".to_owned());
    };
    reject_resolver_flags_for_skill_management_action(skill_path, &state)?;
    let skill_path = skill_path.clone();
    let action = if state.inspect {
        SkillAction::Inspect
    } else {
        SkillAction::Run
    };

    Ok(SkillPlan {
        action,
        skill_path,
        runner: state.runner,
        receipt_dir: state.receipt_dir,
        run_id: state.run_id,
        answers: state.answers,
        registry: state.registry,
        expected_digest: state.expected_digest,
        json: state.json,
        non_interactive: state.non_interactive,
        skip_operator_context: state.skip_operator_context,
        full_operator_context: state.full_operator_context,
        approve_operator_context: state.approve_operator_context,
        inputs: state.inputs,
        local_credential,
    })
}

#[derive(Default)]
struct SkillParseState {
    skill_path: Option<PathBuf>,
    runner: Option<String>,
    receipt_dir: Option<PathBuf>,
    run_id: Option<String>,
    answers: Option<PathBuf>,
    registry: Option<String>,
    expected_digest: Option<String>,
    json: bool,
    non_interactive: bool,
    skip_operator_context: bool,
    full_operator_context: bool,
    approve_operator_context: Option<String>,
    inspect: bool,
    force_run: bool,
    inputs: BTreeMap<String, JsonValue>,
    credential: Option<CredentialBinding>,
    credential_scopes: Vec<String>,
    credential_profile: Option<String>,
    secret_env: Option<(String, String)>,
}

struct CredentialBinding {
    provider: String,
    auth_mode: String,
    material_ref: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialProfilesFile {
    profiles: BTreeMap<String, CredentialProfile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialProfile {
    credential: String,
    secret_env: String,
    scopes: Vec<String>,
}

fn parse_credential_binding(value: &str) -> Result<CredentialBinding, String> {
    let (provider, rest) = value.split_once(':').ok_or_else(credential_usage_error)?;
    let provider = non_empty_credential_part(provider)?;
    let (auth_mode, rest) = rest.split_once(':').ok_or_else(credential_usage_error)?;
    let auth_mode = non_empty_credential_part(auth_mode)?;
    let material_ref = non_empty_credential_part(rest)?;
    Ok(CredentialBinding {
        provider: provider.to_owned(),
        auth_mode: auth_mode.to_owned(),
        material_ref: material_ref.to_owned(),
    })
}

fn parse_credential_scope(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("runx skill --credential-scope requires a non-empty scope".to_owned());
    }
    Ok(value.to_owned())
}

fn normalized_credential_scopes(scopes: &[String]) -> Result<Vec<String>, String> {
    if scopes.is_empty() {
        return Err(
            "runx skill credential binding requires at least one --credential-scope <scope>"
                .to_owned(),
        );
    }
    let mut normalized = scopes
        .iter()
        .map(|scope| parse_credential_scope(scope))
        .collect::<Result<Vec<_>, _>>()?;
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

fn non_empty_credential_part(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(credential_usage_error());
    }
    Ok(value)
}

fn credential_usage_error() -> String {
    "runx skill --credential requires <provider>:<auth_mode>:<material_ref>".to_owned()
}

fn parse_secret_env(value: &str) -> Result<(String, String), String> {
    parse_secret_env_from(value, |name| env::var(name).ok())
}

fn parse_secret_env_from(
    value: &str,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<(String, String), String> {
    if value.contains('=') {
        return Err(
            "runx skill --secret-env accepts an environment variable name, not an inline value"
                .to_owned(),
        );
    }
    let name = value.trim();
    if name.is_empty() {
        return Err("runx skill --secret-env requires a non-empty env var name".to_owned());
    }
    let secret = lookup(name)
        .ok_or_else(|| format!("runx skill --secret-env env var '{name}' is not set"))?;
    if secret.trim().is_empty() {
        return Err("runx skill --secret-env requires a non-empty secret value".to_owned());
    }
    Ok((name.to_owned(), secret.to_owned()))
}

fn finalize_local_credential(
    state: &SkillParseState,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<Option<LocalCredentialDescriptor>, String> {
    if let Some(profile_name) = state.credential_profile.as_ref() {
        if state.credential.is_some()
            || state.secret_env.is_some()
            || !state.credential_scopes.is_empty()
        {
            return Err(
                "runx skill --credential-profile cannot be combined with --credential, --credential-scope, or --secret-env"
                    .to_owned(),
            );
        }
        let profile = load_credential_profile(profile_name, env, cwd)?;
        let credential = parse_credential_binding(&profile.credential)?;
        let scopes = normalized_credential_scopes(&profile.scopes).map_err(|error| {
            format!("runx skill credential profile '{profile_name}' is invalid: {error}")
        })?;
        let secret_env = parse_secret_env_from(&profile.secret_env, |name| env.get(name).cloned())?;
        return Ok(Some(local_credential_descriptor(
            &credential,
            &scopes,
            &secret_env,
        )));
    }
    let Some(binding) = state.credential.as_ref() else {
        if !state.credential_scopes.is_empty() {
            return Err("runx skill --credential-scope requires --credential".to_owned());
        }
        return match &state.secret_env {
            None => Ok(None),
            Some(_) => Err(
                "runx skill --secret-env requires --credential <provider>:<auth_mode>:<material_ref>"
                    .to_owned(),
            ),
        };
    };
    let Some((env_var, secret)) = state.secret_env.as_ref() else {
        return Err("runx skill --credential requires --secret-env <ENV_VAR>".to_owned());
    };
    let scopes = normalized_credential_scopes(&state.credential_scopes)?;
    Ok(Some(local_credential_descriptor(
        binding,
        &scopes,
        &(env_var.clone(), secret.clone()),
    )))
}

fn local_credential_descriptor(
    binding: &CredentialBinding,
    scopes: &[String],
    secret_env: &(String, String),
) -> LocalCredentialDescriptor {
    LocalCredentialDescriptor {
        provider: binding.provider.clone(),
        auth_mode: binding.auth_mode.clone(),
        env_var: secret_env.0.clone(),
        material_ref: binding.material_ref.clone(),
        scopes: scopes.to_vec(),
        secret: secret_env.1.clone(),
    }
}

fn load_credential_profile(
    profile_name: &str,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<CredentialProfile, String> {
    let profile_name = profile_name.trim();
    if profile_name.is_empty() {
        return Err("runx skill --credential-profile requires a non-empty name".to_owned());
    }
    let paths = credential_profile_paths(env, cwd);
    for path in &paths {
        let contents = match fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "runx skill could not read credential profile file {}: {error}",
                    path.display()
                ));
            }
        };
        let parsed: CredentialProfilesFile = serde_json::from_str(&contents).map_err(|error| {
            format!(
                "runx skill credential profile file {} is invalid JSON: {error}",
                path.display()
            )
        })?;
        if let Some(profile) = parsed.profiles.into_iter().find_map(|(name, profile)| {
            if name == profile_name {
                Some(profile)
            } else {
                None
            }
        }) {
            return Ok(profile);
        }
    }
    let searched = paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "runx skill credential profile '{profile_name}' was not found; searched {searched}"
    ))
}

fn credential_profile_paths(env: &BTreeMap<String, String>, cwd: &Path) -> Vec<PathBuf> {
    if let Some(path) = env
        .get("RUNX_CREDENTIAL_PROFILES")
        .filter(|value| !value.trim().is_empty())
    {
        return vec![resolve_path_from_user_input(path, env, cwd, true)];
    }
    let mut paths = Vec::new();
    if let Some(project_dir) = env
        .get("RUNX_PROJECT_DIR")
        .filter(|value| !value.trim().is_empty())
        .map(|value| resolve_path_from_user_input(value, env, cwd, true))
        .or_else(|| nearest_project_runx_dir(cwd))
    {
        paths.push(project_dir.join("credentials.json"));
    }
    paths.push(resolve_runx_home_dir(env, cwd).join("credentials.json"));
    paths.dedup();
    paths
}

fn nearest_project_runx_dir(cwd: &Path) -> Option<PathBuf> {
    cwd.ancestors()
        .map(|ancestor| ancestor.join(".runx"))
        .find(|candidate| candidate.is_dir())
}

fn reject_resolver_flags_for_skill_management_action(
    skill_path: &Path,
    state: &SkillParseState,
) -> Result<(), String> {
    if state.registry.is_none() && state.expected_digest.is_none() {
        return Ok(());
    }
    if !is_skill_management_action(skill_path) {
        return Ok(());
    }
    Err("runx skill --registry and --digest are only supported when running a skill ref".to_owned())
}

fn is_skill_management_action(skill_path: &Path) -> bool {
    if skill_path.components().count() != 1 {
        return false;
    }
    matches!(
        skill_path.to_str(),
        Some("add" | "inspect" | "publish" | "search" | "validate")
    )
}

// rust-style-allow: long-function because this is the single skill-flag dispatch
// match (--receipt-dir/--json/--credential and positionals); splitting the
// arms would scatter the CLI parse contract.
fn parse_skill_arg(
    args: &[OsString],
    mut index: usize,
    state: &mut SkillParseState,
) -> Result<usize, String> {
    let token = string_arg(args, index)?;
    if is_retired_skill_option(&token) {
        return Err(
            "retired runx skill receipt option is not supported; use --receipt-dir".to_owned(),
        );
    }
    match token.as_str() {
        value if value.starts_with("--receipt-dir=") => {
            state.receipt_dir = Some(PathBuf::from(value.trim_start_matches("--receipt-dir=")));
        }
        value if value.starts_with("-R=") => {
            state.receipt_dir = Some(PathBuf::from(value.trim_start_matches("-R=")));
        }
        value if value.starts_with("--receipts=") => {
            state.receipt_dir = Some(PathBuf::from(value.trim_start_matches("--receipts=")));
        }
        "--receipt-dir" => {
            index += 1;
            state.receipt_dir = Some(PathBuf::from(string_arg(args, index)?));
        }
        "--receipts" => {
            index += 1;
            state.receipt_dir = Some(PathBuf::from(string_arg(args, index)?));
        }
        "-R" => {
            index += 1;
            state.receipt_dir = Some(PathBuf::from(string_arg(args, index)?));
        }
        value if value.starts_with("--run-id=") || value == "--run-id" => {
            return Err(skill_resume_flag_error());
        }
        value if value.starts_with("--answers=") || value == "--answers" => {
            return Err(skill_resume_flag_error());
        }
        value if value.starts_with("--runner=") || value == "--runner" => {
            return Err(
                "runx skill --runner is no longer supported; use `runx skill <skill> <runner>`"
                    .to_owned(),
            );
        }
        value if value.starts_with("--registry=") => {
            state.registry = Some(non_empty_flag_value(
                "--registry",
                value.trim_start_matches("--registry="),
            )?);
        }
        "--registry" => {
            index += 1;
            state.registry = Some(non_empty_flag_value(
                "--registry",
                &string_arg(args, index)?,
            )?);
        }
        value if value.starts_with("--digest=") => {
            state.expected_digest = Some(non_empty_flag_value(
                "--digest",
                value.trim_start_matches("--digest="),
            )?);
        }
        "--digest" => {
            index += 1;
            state.expected_digest =
                Some(non_empty_flag_value("--digest", &string_arg(args, index)?)?);
        }
        value if value.starts_with("--input=") => {
            index = parse_input_arg(
                args,
                index,
                Some(value.trim_start_matches("--input=")),
                &mut state.inputs,
            )?;
        }
        value if value.starts_with("--input-json=") => {
            index = parse_json_input_arg(
                args,
                index,
                Some(value.trim_start_matches("--input-json=")),
                &mut state.inputs,
            )?;
        }
        value if value.starts_with("-i=") => {
            index = parse_input_arg(
                args,
                index,
                Some(value.trim_start_matches("-i=")),
                &mut state.inputs,
            )?;
        }
        "--input" => index = parse_input_arg(args, index, None, &mut state.inputs)?,
        "--input-json" => index = parse_json_input_arg(args, index, None, &mut state.inputs)?,
        "-i" => index = parse_input_arg(args, index, None, &mut state.inputs)?,
        "--run" => state.force_run = true,
        value if value.starts_with("--credential=") => {
            state.credential = Some(parse_credential_binding(
                value.trim_start_matches("--credential="),
            )?);
        }
        "--credential" => {
            index += 1;
            state.credential = Some(parse_credential_binding(&string_arg(args, index)?)?);
        }
        value if value.starts_with("--credential-scope=") => {
            state.credential_scopes.push(parse_credential_scope(
                value.trim_start_matches("--credential-scope="),
            )?);
        }
        "--credential-scope" => {
            index += 1;
            state
                .credential_scopes
                .push(parse_credential_scope(&string_arg(args, index)?)?);
        }
        value if value.starts_with("--credential-profile=") => {
            state.credential_profile = Some(non_empty_flag_value(
                "--credential-profile",
                value.trim_start_matches("--credential-profile="),
            )?);
        }
        value if value.starts_with("--profile=") => {
            state.credential_profile = Some(non_empty_flag_value(
                "--profile",
                value.trim_start_matches("--profile="),
            )?);
        }
        "--credential-profile" => {
            index += 1;
            state.credential_profile = Some(non_empty_flag_value(
                "--credential-profile",
                &string_arg(args, index)?,
            )?);
        }
        "--profile" | "-p" => {
            index += 1;
            state.credential_profile = Some(non_empty_flag_value(
                "--profile",
                &string_arg(args, index)?,
            )?);
        }
        value if value.starts_with("--secret-env=") => {
            state.secret_env = Some(parse_secret_env(value.trim_start_matches("--secret-env="))?);
        }
        "--secret-env" => {
            index += 1;
            state.secret_env = Some(parse_secret_env(&string_arg(args, index)?)?);
        }
        "--json" | "-j" => state.json = true,
        value if value.starts_with("--approve-operator-context=") => {
            state.approve_operator_context = Some(non_empty_flag_value(
                "--approve-operator-context",
                value.trim_start_matches("--approve-operator-context="),
            )?);
        }
        "--approve-operator-context" => {
            index += 1;
            state.approve_operator_context = Some(non_empty_flag_value(
                "--approve-operator-context",
                &string_arg(args, index)?,
            )?);
        }
        value if value.starts_with("--skip-operator-context=") => {
            state.skip_operator_context = parse_boolean_flag(
                "--skip-operator-context",
                value.trim_start_matches("--skip-operator-context="),
            )?;
        }
        value if value.starts_with("--no-operator-context=") => {
            state.skip_operator_context = parse_boolean_flag(
                "--no-operator-context",
                value.trim_start_matches("--no-operator-context="),
            )?;
        }
        "--skip-operator-context" | "--no-operator-context" => {
            state.skip_operator_context = true;
        }
        value if value.starts_with("--full-operator-context=") => {
            state.full_operator_context = parse_boolean_flag(
                "--full-operator-context",
                value.trim_start_matches("--full-operator-context="),
            )?;
        }
        "--full-operator-context" => state.full_operator_context = true,
        "--non-interactive" => state.non_interactive = true,
        value if value.starts_with("--") => {
            index = parse_direct_input_arg(args, index, value, &mut state.inputs)?;
        }
        value => {
            if state.skill_path.is_none() && value == "inspect" {
                state.inspect = true;
            } else if state.skill_path.is_none() {
                state.skill_path = Some(PathBuf::from(value));
            } else if state.runner.is_none() {
                state.runner = Some(value.to_owned());
            } else {
                return Err(format!("unexpected runx skill argument {value}"));
            }
        }
    }
    Ok(index)
}

fn non_empty_flag_value(flag: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("runx skill {flag} requires a non-empty value"));
    }
    Ok(value.to_owned())
}

fn parse_boolean_flag(flag: &str, value: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err(format!("runx skill {flag} expects true or false")),
    }
}

fn skill_resume_flag_error() -> String {
    "runx skill continuation flags are no longer supported; use `runx resume <run-id> <answers.json>`".to_owned()
}

fn is_retired_skill_option(token: &str) -> bool {
    let Some(flag) = token.strip_prefix("--") else {
        return false;
    };
    let name = flag.split_once('=').map_or(flag, |(name, _value)| name);
    name == "receipt" || name == retired_receipt_dir_option_name()
}

fn retired_receipt_dir_option_name() -> String {
    ["receipt", "Dir"].concat()
}

fn string_arg(args: &[OsString], index: usize) -> Result<String, String> {
    let value = args
        .get(index)
        .ok_or_else(|| "missing value for runx skill argument".to_owned())?;
    value
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "runx skill arguments must be UTF-8".to_owned())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        SkillAction, SkillParseState, finalize_local_credential, parse_credential_binding,
    };

    #[test]
    fn credential_profile_resolves_project_descriptor_and_env_secret() -> Result<(), String> {
        let root = unique_temp_dir("runx-credential-profile")?;
        let runx_dir = root.join(".runx");
        fs::create_dir_all(&runx_dir).map_err(|error| error.to_string())?;
        fs::write(
            runx_dir.join("credentials.json"),
            r#"{
  "profiles": {
    "example": {
      "credential": "example:bearer:local://example/internal",
      "secret_env": "INTERNAL_SYNC_SECRET",
      "scopes": ["example:review"]
    }
  }
}
"#,
        )
        .map_err(|error| error.to_string())?;

        let state = SkillParseState {
            credential_profile: Some("example".to_owned()),
            ..Default::default()
        };
        let env = [
            (
                "RUNX_PROJECT_DIR".to_owned(),
                runx_dir.to_string_lossy().into_owned(),
            ),
            ("INTERNAL_SYNC_SECRET".to_owned(), "secret-value".to_owned()),
        ]
        .into_iter()
        .collect();
        let credential = finalize_local_credential(&state, &env, &root)?
            .ok_or_else(|| "credential profile did not resolve".to_owned())?;

        assert_eq!(credential.provider, "example");
        assert_eq!(credential.auth_mode, "bearer");
        assert_eq!(credential.material_ref, "local://example/internal");
        assert_eq!(credential.env_var, "INTERNAL_SYNC_SECRET");
        assert_eq!(credential.secret, "secret-value");
        assert_eq!(credential.scopes, vec!["example:review"]);

        fs::remove_dir_all(root).map_err(|error| error.to_string())?;
        Ok(())
    }

    #[test]
    fn credential_descriptor_preserves_colons_and_scopes_are_explicit() -> Result<(), String> {
        let binding = parse_credential_binding("twitter:oauth1_user:ref:twitter:primary")?;
        let state = SkillParseState {
            credential: Some(binding),
            credential_scopes: vec![
                "twitter:write".to_owned(),
                "twitter:read".to_owned(),
                "twitter:read".to_owned(),
            ],
            secret_env: Some(("TWITTER_TOKEN".to_owned(), "secret-value".to_owned())),
            ..Default::default()
        };

        let credential =
            finalize_local_credential(&state, &Default::default(), &std::env::temp_dir())?
                .ok_or_else(|| "credential did not resolve".to_owned())?;

        assert_eq!(credential.material_ref, "ref:twitter:primary");
        assert_eq!(credential.scopes, vec!["twitter:read", "twitter:write"]);
        Ok(())
    }

    #[test]
    fn credential_descriptor_does_not_infer_a_trailing_scope() -> Result<(), String> {
        let binding = parse_credential_binding("twitter:oauth1_user:ref:twitter:read")?;
        let state = SkillParseState {
            credential: Some(binding),
            secret_env: Some(("TWITTER_TOKEN".to_owned(), "secret-value".to_owned())),
            ..Default::default()
        };

        let error = finalize_local_credential(&state, &Default::default(), &std::env::temp_dir())
            .err()
            .ok_or_else(|| "descriptor-embedded scope unexpectedly resolved".to_owned())?;

        assert!(error.contains("--credential-scope"));
        Ok(())
    }

    #[test]
    fn credential_profile_rejects_manual_credential_flags() -> Result<(), String> {
        let state = SkillParseState {
            credential_profile: Some("example".to_owned()),
            secret_env: Some(("TOKEN".to_owned(), "secret".to_owned())),
            ..Default::default()
        };
        let error = finalize_local_credential(&state, &Default::default(), &std::env::temp_dir())
            .err()
            .ok_or_else(|| "profile unexpectedly combined with manual flags".to_owned())?;
        assert!(error.contains("cannot be combined"));
        Ok(())
    }

    #[test]
    fn short_human_flags_parse_for_skill_runs() -> Result<(), String> {
        let args = [
            "skill",
            "-p",
            "operator",
            "-i",
            "claim=abc",
            "-R",
            "receipts",
            "-j",
        ]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
        let mut state = SkillParseState::default();
        let mut index = 1;
        while index < args.len() {
            index = super::parse_skill_arg(&args, index, &mut state)?;
            index += 1;
        }
        assert_eq!(state.credential_profile.as_deref(), Some("operator"));
        assert_eq!(
            state.inputs.get("claim"),
            Some(&runx_contracts::JsonValue::String("abc".to_owned()))
        );
        assert_eq!(
            state.receipt_dir.as_deref(),
            Some(std::path::Path::new("receipts"))
        );
        assert!(state.json);
        Ok(())
    }

    #[test]
    fn input_json_parses_strict_json_values() -> Result<(), String> {
        let args = [
            "skill",
            "skills/data-store",
            "--input-json",
            "event",
            r#"{"type":"posting.claimed","payload":{"actor":"agent-9"}}"#,
            "--input-json=limits={\"rows\":10}",
        ]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
        let plan = super::parse_skill_plan(&args)?;
        assert_eq!(plan.action, SkillAction::Run);

        assert_eq!(
            plan.inputs
                .get("event")
                .and_then(runx_contracts::JsonValue::as_object)
                .and_then(|event| event.get("type"))
                .and_then(runx_contracts::JsonValue::as_str),
            Some("posting.claimed")
        );
        let rows = plan
            .inputs
            .get("limits")
            .and_then(runx_contracts::JsonValue::as_object)
            .and_then(|limits| limits.get("rows"))
            .and_then(|rows| match rows {
                runx_contracts::JsonValue::Number(number) => number.as_f64(),
                _ => None,
            });
        assert_eq!(rows, Some(10.0));
        Ok(())
    }

    #[test]
    fn skill_without_inputs_executes_default_runner() -> Result<(), String> {
        let args = ["skill", "skills/messageboard"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        let plan = super::parse_skill_plan(&args)?;

        assert_eq!(plan.action, SkillAction::Run);
        assert_eq!(
            plan.skill_path,
            std::path::PathBuf::from("skills/messageboard")
        );
        assert_eq!(plan.runner, None);
        Ok(())
    }

    #[test]
    fn positional_runner_without_inputs_executes_runner() -> Result<(), String> {
        let args = ["skill", "skills/messageboard", "post_and_append"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        let plan = super::parse_skill_plan(&args)?;

        assert_eq!(plan.action, SkillAction::Run);
        assert_eq!(plan.runner.as_deref(), Some("post_and_append"));
        Ok(())
    }

    #[test]
    fn explicit_inspect_returns_skill_card() -> Result<(), String> {
        let args = ["skill", "inspect", "skills/messageboard", "post_and_append"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        let plan = super::parse_skill_plan(&args)?;

        assert_eq!(plan.action, SkillAction::Inspect);
        assert_eq!(
            plan.skill_path,
            std::path::PathBuf::from("skills/messageboard")
        );
        assert_eq!(plan.runner.as_deref(), Some("post_and_append"));
        Ok(())
    }

    #[test]
    fn positional_runner_with_inputs_executes_runner() -> Result<(), String> {
        let args = [
            "skill",
            "skills/messageboard",
            "post_and_append",
            "-i",
            "title=hello",
        ]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
        let plan = super::parse_skill_plan(&args)?;

        assert_eq!(plan.action, SkillAction::Run);
        assert_eq!(plan.runner.as_deref(), Some("post_and_append"));
        assert_eq!(
            plan.inputs.get("title"),
            Some(&runx_contracts::JsonValue::String("hello".to_owned()))
        );
        Ok(())
    }

    #[test]
    fn skip_operator_context_flag_is_not_a_skill_input() -> Result<(), String> {
        let args = [
            "skill",
            "skills/messageboard",
            "--skip-operator-context",
            "--input",
            "title=hello",
        ]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
        let plan = super::parse_skill_plan(&args)?;

        assert!(plan.skip_operator_context);
        assert_eq!(plan.inputs.len(), 1);
        assert_eq!(
            plan.inputs.get("title"),
            Some(&runx_contracts::JsonValue::String("hello".to_owned()))
        );
        Ok(())
    }

    #[test]
    fn approve_operator_context_flag_is_not_a_skill_input() -> Result<(), String> {
        let args = [
            "skill",
            "skills/messageboard",
            "--approve-operator-context",
            "sha256:abc123",
            "--non-interactive",
            "--input",
            "title=hello",
        ]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
        let plan = super::parse_skill_plan(&args)?;

        assert_eq!(
            plan.approve_operator_context.as_deref(),
            Some("sha256:abc123")
        );
        assert!(plan.non_interactive);
        assert_eq!(plan.inputs.len(), 1);
        assert!(plan.inputs.contains_key("title"));
        Ok(())
    }

    #[test]
    fn full_operator_context_flag_is_not_a_skill_input() -> Result<(), String> {
        let args = [
            "skill",
            "skills/messageboard",
            "--full-operator-context",
            "--input",
            "title=hello",
        ]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
        let plan = super::parse_skill_plan(&args)?;

        assert!(plan.full_operator_context);
        assert_eq!(plan.inputs.len(), 1);
        assert!(plan.inputs.contains_key("title"));
        Ok(())
    }

    #[test]
    fn inline_operator_context_flags_are_not_skill_inputs() -> Result<(), String> {
        let args = [
            "skill",
            "skills/messageboard",
            "--full-operator-context=true",
            "--skip-operator-context=false",
            "--input",
            "title=hello",
        ]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
        let plan = super::parse_skill_plan(&args)?;

        assert!(plan.full_operator_context);
        assert!(!plan.skip_operator_context);
        assert_eq!(plan.inputs.len(), 1);
        assert!(plan.inputs.contains_key("title"));
        Ok(())
    }

    #[test]
    fn run_flag_executes_zero_input_runner() -> Result<(), String> {
        let args = ["skill", "skills/ops-desk", "refresh", "--run"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        let plan = super::parse_skill_plan(&args)?;

        assert_eq!(plan.action, SkillAction::Run);
        assert_eq!(plan.runner.as_deref(), Some("refresh"));
        Ok(())
    }

    #[test]
    fn input_json_rejects_non_json_values() -> Result<(), String> {
        let args = [
            "skill",
            "skills/data-store",
            "--input-json",
            "event",
            "plain text",
        ]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
        let Err(error) = super::parse_skill_plan(&args) else {
            return Err("invalid json input should fail".to_owned());
        };

        assert!(error.contains("--input-json event is invalid JSON"));
        Ok(())
    }

    #[test]
    fn credential_parser_keeps_uri_material_ref_intact() -> Result<(), String> {
        let binding =
            super::parse_credential_binding("frantic:bearer:local://frantic/internal:primary")?;
        assert_eq!(binding.provider, "frantic");
        assert_eq!(binding.auth_mode, "bearer");
        assert_eq!(binding.material_ref, "local://frantic/internal:primary");
        Ok(())
    }

    fn unique_temp_dir(name: &str) -> Result<std::path::PathBuf, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        Ok(path)
    }
}

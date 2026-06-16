// rust-style-allow: large-file because the native config slice keeps parse,
// execute, render, and parity tests together for one audited CLI surface.
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::path::Path;

use crate::cli_args::{os_arg, split_flag};
use runx_runtime::{
    ConfigError, RunxConfigFile, load_runx_config_file, lookup_runx_config_value,
    mask_runx_config_file, parse_config_key, resolve_runx_home_dir, update_runx_config_value,
    write_runx_config_file,
};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigAction {
    Set,
    Get,
    List,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigPlan {
    pub action: ConfigAction,
    pub key: Option<String>,
    pub value: Option<String>,
    pub json: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ConfigResult {
    Set {
        action: ConfigAction,
        key: String,
        value: Option<String>,
    },
    Get {
        action: ConfigAction,
        key: String,
        value: Option<String>,
    },
    List {
        action: ConfigAction,
        values: RunxConfigFile,
    },
}

#[derive(Debug)]
pub enum ConfigCliError {
    InvalidArgs(String),
    Config(ConfigError),
    Serialize(serde_json::Error),
}

impl fmt::Display for ConfigCliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArgs(message) => formatter.write_str(message),
            Self::Config(error) => write!(formatter, "{error}"),
            Self::Serialize(error) => write!(formatter, "failed to serialize config: {error}"),
        }
    }
}

impl std::error::Error for ConfigCliError {}

impl From<ConfigError> for ConfigCliError {
    fn from(error: ConfigError) -> Self {
        Self::Config(error)
    }
}

impl From<serde_json::Error> for ConfigCliError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialize(error)
    }
}

// rust-style-allow: long-function because config set/get/list share one small
// flag grammar and keeping it adjacent avoids divergent command parsing.
pub fn parse_config_plan(args: &[OsString]) -> Result<ConfigPlan, String> {
    let command = os_arg(args, 0, "config")?;
    if command != "config" {
        return Err("config parser requires the config command".to_owned());
    }

    let Some(subcommand) = args.get(1).and_then(|arg| arg.to_str()) else {
        return Err("runx config requires set, get, or list".to_owned());
    };
    let action = match subcommand {
        "set" => ConfigAction::Set,
        "get" => ConfigAction::Get,
        "list" => ConfigAction::List,
        _ => return Err(format!("unknown config subcommand {subcommand}")),
    };

    let mut json = false;
    let mut positionals = Vec::new();
    let mut index = 2;
    while index < args.len() {
        let token = os_arg(args, index, "config")?;
        if !token.starts_with("--") {
            positionals.push(token.to_owned());
            index += 1;
            continue;
        }

        let (flag, inline_value) = split_flag(token);
        match flag {
            "--json" => {
                if inline_value.is_some() {
                    return Err("--json does not take a value".to_owned());
                }
                json = true;
                index += 1;
            }
            _ => return Err(format!("unknown config flag {flag}")),
        }
    }

    match action {
        ConfigAction::List => {
            if !positionals.is_empty() {
                return Err("runx config list does not accept extra arguments".to_owned());
            }
            Ok(ConfigPlan {
                action,
                key: None,
                value: None,
                json,
            })
        }
        ConfigAction::Get => {
            let [key] = positionals.as_slice() else {
                return Err("runx config get requires exactly one key".to_owned());
            };
            Ok(ConfigPlan {
                action,
                key: Some(key.clone()),
                value: None,
                json,
            })
        }
        ConfigAction::Set => {
            let [key, values @ ..] = positionals.as_slice() else {
                return Err("runx config set requires a key and value".to_owned());
            };
            if values.is_empty() {
                return Err("runx config set requires a value".to_owned());
            }
            Ok(ConfigPlan {
                action,
                key: Some(key.clone()),
                value: Some(values.join(" ")),
                json,
            })
        }
    }
}

pub fn run_config_command(
    plan: &ConfigPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<String, ConfigCliError> {
    let result = execute_config_plan(plan, env, cwd)?;
    if plan.json {
        return Ok(format!(
            "{}\n",
            serde_json::to_string_pretty(&ConfigJsonResult {
                status: "success",
                config: &result,
            })?
        ));
    }
    Ok(render_config_result(&result))
}

fn execute_config_plan(
    plan: &ConfigPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<ConfigResult, ConfigCliError> {
    let config_dir = resolve_runx_home_dir(env, cwd);
    let config_path = config_dir.join("config.json");
    let config = load_runx_config_file(&config_path)?;

    match plan.action {
        ConfigAction::List => Ok(ConfigResult::List {
            action: ConfigAction::List,
            values: mask_runx_config_file(&config),
        }),
        ConfigAction::Get => {
            let key = required_key(plan)?;
            let parsed_key = parse_config_key(key)?;
            Ok(ConfigResult::Get {
                action: ConfigAction::Get,
                key: key.to_owned(),
                value: lookup_runx_config_value(&config, parsed_key),
            })
        }
        ConfigAction::Set => {
            let key = required_key(plan)?;
            let value = plan.value.as_deref().ok_or_else(|| {
                ConfigCliError::InvalidArgs("config value is required.".to_owned())
            })?;
            let parsed_key = parse_config_key(key)?;
            let next = update_runx_config_value(config, parsed_key, value, &config_dir)?;
            write_runx_config_file(&config_path, &next)?;
            Ok(ConfigResult::Set {
                action: ConfigAction::Set,
                key: key.to_owned(),
                value: lookup_runx_config_value(&mask_runx_config_file(&next), parsed_key),
            })
        }
    }
}

fn required_key(plan: &ConfigPlan) -> Result<&str, ConfigCliError> {
    plan.key
        .as_deref()
        .ok_or_else(|| ConfigCliError::InvalidArgs("config key is required.".to_owned()))
}

fn render_config_result(result: &ConfigResult) -> String {
    match result {
        ConfigResult::List { values, .. } => {
            let entries = flatten_config(values);
            if entries.is_empty() {
                return "\n  No config values set.\n\n".to_owned();
            }
            let rows = entries
                .iter()
                .map(|(key, value)| (*key, Some(*value)))
                .collect::<Vec<_>>();
            render_key_value("config", "success", &rows)
        }
        ConfigResult::Get { key, value, .. } | ConfigResult::Set { key, value, .. } => {
            render_key_value("config", "success", &[(key.as_str(), value.as_deref())])
        }
    }
}

fn flatten_config(config: &RunxConfigFile) -> Vec<(&'static str, &str)> {
    let mut rows = Vec::new();
    if let Some(agent) = config.agent.as_ref() {
        if let Some(provider) = agent.provider.as_deref() {
            rows.push(("agent.provider", provider));
        }
        if let Some(model) = agent.model.as_deref() {
            rows.push(("agent.model", model));
        }
        if let Some(api_key_ref) = agent.api_key_ref.as_deref() {
            rows.push(("agent.api_key", api_key_ref));
        }
    }
    if let Some(public) = config.public.as_ref()
        && let Some(api_token_ref) = public.api_token_ref.as_deref()
    {
        rows.push(("public.api_token", api_token_ref));
    }
    rows
}

fn render_key_value(title: &str, status: &str, rows: &[(&str, Option<&str>)]) -> String {
    let visible = rows
        .iter()
        .filter(|(_label, value)| value.is_some_and(|value| !value.is_empty()))
        .collect::<Vec<_>>();
    let width = visible
        .iter()
        .map(|(label, _value)| label.len())
        .max()
        .unwrap_or(0);
    let mut lines = vec![String::new(), format!("  ✓  {title}  {status}")];
    lines.extend(
        visible
            .into_iter()
            .map(|(label, value)| format!("  {label:<width$}  {}", value.unwrap_or_default())),
    );
    lines.push(String::new());
    lines.join("\n")
}

#[derive(Serialize)]
struct ConfigJsonResult<'a> {
    status: &'static str,
    config: &'a ConfigResult,
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn parses_config_set_with_multi_word_value() {
        assert_eq!(
            parse_config_plan(&[
                "config".into(),
                "set".into(),
                "agent.model".into(),
                "gpt".into(),
                "test".into(),
                "--json".into(),
            ]),
            Ok(ConfigPlan {
                action: ConfigAction::Set,
                key: Some("agent.model".to_owned()),
                value: Some("gpt test".to_owned()),
                json: true,
            })
        );
    }

    #[test]
    // rust-style-allow: long-function because one temp config lifecycle proves
    // set/get/list masking against the same encrypted local state.
    fn config_set_get_list_masks_api_key() -> Result<(), ConfigTestError> {
        let temp = tempfile_dir()?;
        let runx_home = temp.join(".runx");
        let env = BTreeMap::from([(
            "RUNX_HOME".to_owned(),
            runx_home.to_string_lossy().to_string(),
        )]);

        let set_provider = ConfigPlan {
            action: ConfigAction::Set,
            key: Some("agent.provider".to_owned()),
            value: Some("openai".to_owned()),
            json: true,
        };
        let set_key = ConfigPlan {
            action: ConfigAction::Set,
            key: Some("agent.api_key".to_owned()),
            value: Some("sk-secret-test".to_owned()),
            json: true,
        };
        let set_public_token = ConfigPlan {
            action: ConfigAction::Set,
            key: Some("public.api_token".to_owned()),
            value: Some("rxk-secret-test".to_owned()),
            json: true,
        };
        run_config_command(&set_provider, &env, &temp)?;
        let key_output = run_config_command(&set_key, &env, &temp)?;
        let public_output = run_config_command(&set_public_token, &env, &temp)?;
        assert!(key_output.contains("\"value\": \"[encrypted]\""));
        assert!(public_output.contains("\"value\": \"[encrypted]\""));
        assert!(!key_output.contains("sk-secret-test"));
        assert!(!public_output.contains("rxk-secret-test"));

        let get_output = run_config_command(
            &ConfigPlan {
                action: ConfigAction::Get,
                key: Some("agent.api_key".to_owned()),
                value: None,
                json: false,
            },
            &env,
            &temp,
        )?;
        assert!(get_output.contains("agent.api_key"));
        assert!(get_output.contains("[encrypted]"));
        assert!(!get_output.contains("sk-secret-test"));

        let list_output = run_config_command(
            &ConfigPlan {
                action: ConfigAction::List,
                key: None,
                value: None,
                json: false,
            },
            &env,
            &temp,
        )?;
        assert!(list_output.contains("agent.provider"));
        assert!(list_output.contains("openai"));
        assert!(list_output.contains("agent.api_key"));
        assert!(list_output.contains("public.api_token"));
        assert!(list_output.contains("[encrypted]"));
        assert!(!list_output.contains("sk-secret-test"));
        assert!(!list_output.contains("rxk-secret-test"));

        let config_contents = fs::read_to_string(runx_home.join("config.json"))?;
        assert!(config_contents.contains("api_key_ref"));
        assert!(config_contents.contains("api_token_ref"));
        assert!(!config_contents.contains("sk-secret-test"));
        assert!(!config_contents.contains("rxk-secret-test"));
        fs::remove_dir_all(temp)?;
        Ok(())
    }

    #[derive(Debug)]
    enum ConfigTestError {
        Io(io::Error),
        Cli(ConfigCliError),
    }

    impl std::fmt::Display for ConfigTestError {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::Io(error) => write!(formatter, "{error}"),
                Self::Cli(error) => write!(formatter, "{error}"),
            }
        }
    }

    impl std::error::Error for ConfigTestError {}

    impl From<io::Error> for ConfigTestError {
        fn from(error: io::Error) -> Self {
            Self::Io(error)
        }
    }

    impl From<ConfigCliError> for ConfigTestError {
        fn from(error: ConfigCliError) -> Self {
            Self::Cli(error)
        }
    }

    fn tempfile_dir() -> Result<PathBuf, io::Error> {
        let path = std::env::temp_dir().join(format!(
            "runx-cli-config-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&path)?;
        Ok(path)
    }
}

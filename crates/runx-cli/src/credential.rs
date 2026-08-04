use std::io::{self, Read};
use std::path::PathBuf;
use std::process::ExitCode;

use runx_runtime::{
    WorkspaceEnv, bind_project_credential, list_local_credential_profiles,
    remove_local_credential_profile, set_local_credential_profile,
};
use serde::Serialize;

mod parser;

pub use parser::parse_credential_plan;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialPlan {
    pub action: CredentialAction,
    pub json: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CredentialAction {
    Set {
        provider: String,
        profile: String,
        auth_mode: String,
        audience: Option<String>,
        from_stdin: bool,
    },
    List,
    Remove {
        profile: String,
    },
    Bind {
        profile: String,
        target: CredentialBindingTarget,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CredentialBindingTarget {
    Provider(String),
    Skill { skill: String, credential: String },
}

pub fn run_native_credential_with_workspace(
    plan: CredentialPlan,
    workspace: &WorkspaceEnv,
) -> ExitCode {
    match execute(&plan, workspace) {
        Ok(output) => crate::cli_io::write_stdout_code(&output, 0),
        Err(error) => fail(&plan, &error),
    }
}

fn execute(plan: &CredentialPlan, workspace: &WorkspaceEnv) -> Result<String, String> {
    let result = match &plan.action {
        CredentialAction::Set {
            provider,
            profile,
            auth_mode,
            audience,
            from_stdin,
        } => {
            if !from_stdin {
                return Err("credential secret input must come from stdin".to_owned());
            }
            let secret = read_secret_stdin()?;
            let profile = set_local_credential_profile(
                workspace,
                profile,
                provider,
                auth_mode,
                audience.as_deref(),
                &secret,
            )
            .map_err(|error| error.to_string())?;
            CredentialResult::Set { profile }
        }
        CredentialAction::List => CredentialResult::List {
            profiles: list_local_credential_profiles(workspace)
                .map_err(|error| error.to_string())?,
        },
        CredentialAction::Remove { profile } => CredentialResult::Remove {
            profile: profile.clone(),
            removed: remove_local_credential_profile(workspace, profile)
                .map_err(|error| error.to_string())?,
        },
        CredentialAction::Bind { profile, target } => {
            let target = target.binding_key();
            let path = bind_project_credential(workspace, &target, profile)
                .map_err(|error| error.to_string())?;
            CredentialResult::Bind {
                profile: profile.clone(),
                target,
                path,
            }
        }
    };
    if plan.json {
        serde_json::to_string_pretty(&CredentialJsonOutput {
            status: "success",
            credential: &result,
        })
        .map(|value| format!("{value}\n"))
        .map_err(|error| error.to_string())
    } else {
        Ok(render_text(&result))
    }
}

impl CredentialBindingTarget {
    fn binding_key(&self) -> String {
        match self {
            Self::Provider(provider) => format!("provider:{provider}"),
            Self::Skill { skill, credential } => format!("skill:{skill}:{credential}"),
        }
    }
}

fn read_secret_stdin() -> Result<String, String> {
    let mut secret = String::new();
    io::stdin()
        .read_to_string(&mut secret)
        .map_err(|error| format!("failed to read credential from stdin: {error}"))?;
    while secret.ends_with(['\r', '\n']) {
        secret.pop();
    }
    if secret.is_empty() {
        return Err("credential secret from stdin must not be empty".to_owned());
    }
    Ok(secret)
}

#[derive(Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum CredentialResult {
    Set {
        profile: runx_runtime::CredentialProfileSummary,
    },
    List {
        profiles: Vec<runx_runtime::CredentialProfileSummary>,
    },
    Remove {
        profile: String,
        removed: bool,
    },
    Bind {
        profile: String,
        target: String,
        path: PathBuf,
    },
}

#[derive(Serialize)]
struct CredentialJsonOutput<'a> {
    status: &'static str,
    credential: &'a CredentialResult,
}

fn render_text(result: &CredentialResult) -> String {
    match result {
        CredentialResult::Set { profile } => {
            let audience = profile
                .audience
                .as_deref()
                .map_or(String::new(), |value| format!(" for {value}"));
            format!(
                "credential profile '{}' stored for {} ({}){audience} and set as default\n",
                profile.name, profile.provider, profile.auth_mode
            )
        }
        CredentialResult::List { profiles } if profiles.is_empty() => {
            "no credential profiles configured\n".to_owned()
        }
        CredentialResult::List { profiles } => profiles
            .iter()
            .map(|profile| {
                let audience = profile
                    .audience
                    .as_deref()
                    .map_or(String::new(), |value| format!("  audience={value}"));
                format!(
                    "{}  {}  {}{audience}{}\n",
                    profile.name,
                    profile.provider,
                    profile.auth_mode,
                    if profile.is_default { "  default" } else { "" }
                )
            })
            .collect(),
        CredentialResult::Remove { profile, removed } => format!(
            "credential profile '{profile}' {}\n",
            if *removed { "removed" } else { "not found" }
        ),
        CredentialResult::Bind {
            profile,
            target,
            path,
        } => format!(
            "credential profile '{profile}' bound to {target} in {}\n",
            path.display()
        ),
    }
}

fn fail(plan: &CredentialPlan, message: &str) -> ExitCode {
    if plan.json {
        return crate::cli_io::write_stdout_code(
            &crate::router::json_failure_output(message, "credential_error"),
            1,
        );
    }
    let _ignored = crate::cli_io::write_stderr(&format!("runx credential: {message}\n"));
    ExitCode::from(1)
}

#[cfg(test)]
mod tests {
    use super::{CredentialAction, CredentialBindingTarget, CredentialPlan, parse_credential_plan};

    #[test]
    fn parses_stdin_profile_setup() {
        let args = [
            "credential",
            "set",
            "nitrosend",
            "--profile",
            "account-one",
            "--from-stdin",
            "--json",
        ]
        .map(Into::into);
        assert_eq!(
            parse_credential_plan(&args),
            Ok(CredentialPlan {
                action: CredentialAction::Set {
                    provider: "nitrosend".to_owned(),
                    profile: "account-one".to_owned(),
                    auth_mode: "api_key".to_owned(),
                    audience: None,
                    from_stdin: true,
                },
                json: true,
            })
        );
    }

    #[test]
    fn parses_skill_binding() {
        let args = [
            "credential",
            "bind",
            "account-one",
            "--skill",
            "nitrosend/support",
            "--credential",
            "nitrosend",
        ]
        .map(Into::into);
        assert_eq!(
            parse_credential_plan(&args),
            Ok(CredentialPlan {
                action: CredentialAction::Bind {
                    profile: "account-one".to_owned(),
                    target: CredentialBindingTarget::Skill {
                        skill: "nitrosend/support".to_owned(),
                        credential: "nitrosend".to_owned(),
                    },
                },
                json: false,
            })
        );
    }

    #[test]
    fn parses_profile_audience_binding() {
        let args = [
            "credential",
            "set",
            "n8n",
            "--profile",
            "workflow",
            "--auth-mode",
            "bearer",
            "--audience",
            "https://n8n.example.com",
            "--from-stdin",
        ]
        .map(Into::into);
        assert_eq!(
            parse_credential_plan(&args),
            Ok(CredentialPlan {
                action: CredentialAction::Set {
                    provider: "n8n".to_owned(),
                    profile: "workflow".to_owned(),
                    auth_mode: "bearer".to_owned(),
                    audience: Some("https://n8n.example.com".to_owned()),
                    from_stdin: true,
                },
                json: false,
            })
        );
    }
}

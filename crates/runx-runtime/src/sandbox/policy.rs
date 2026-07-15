use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::JsonObject;
use runx_core::policy::{CwdPolicy, SandboxProfile};
use runx_parser::{SkillSandbox, SkillSource};

use crate::RuntimeError;
use crate::receipts::paths::{INIT_CWD_ENV, RUNX_CWD_ENV};

use super::template::{has_unresolved_template, resolve_template};

pub(super) fn resolve_cwd(
    source: &SkillSource,
    sandbox: Option<&SkillSandbox>,
    skill_directory: &Path,
    workspace_cwd: Option<&Path>,
) -> Result<PathBuf, RuntimeError> {
    resolve_cwd_value(
        source.cwd.as_deref(),
        sandbox,
        skill_directory,
        workspace_cwd,
    )
}

pub(super) fn resolve_cwd_value(
    source_cwd: Option<&str>,
    sandbox: Option<&SkillSandbox>,
    skill_directory: &Path,
    workspace_cwd: Option<&Path>,
) -> Result<PathBuf, RuntimeError> {
    let policy = sandbox
        .and_then(|sandbox| sandbox.cwd_policy.as_ref().map(CwdPolicy::as_str))
        .unwrap_or("skill-directory");
    let profile = sandbox
        .map(|sandbox| sandbox.profile.as_str())
        .unwrap_or("readonly");
    let cwd = match (policy, source_cwd) {
        ("custom", Some(cwd)) => Ok(resolve_path(skill_directory, cwd)),
        ("workspace", Some(cwd)) => Ok(resolve_path(skill_directory, cwd)),
        ("workspace", None) => workspace_cwd.map(Path::to_path_buf).map_or_else(
            || {
                std::env::current_dir()
                    .map_err(|source| RuntimeError::io("resolving workspace cwd", source))
            },
            Ok,
        ),
        (_, Some(cwd)) => Ok(resolve_path(skill_directory, cwd)),
        _ => Ok(skill_directory.to_path_buf()),
    }?;
    validate_cwd_policy(policy, profile, &cwd, skill_directory, workspace_cwd)?;
    Ok(normalize_path(&cwd))
}

pub(super) fn workspace_cwd(
    env: &BTreeMap<String, String>,
) -> Result<Option<PathBuf>, RuntimeError> {
    if !env.contains_key(RUNX_CWD_ENV) && !env.contains_key(INIT_CWD_ENV) {
        return Ok(None);
    }
    let cwd = std::env::current_dir()
        .map_err(|source| RuntimeError::io("resolving workspace cwd", source))?;
    Ok(Some(crate::config::resolve_runx_workspace_base(env, &cwd)))
}

pub(super) fn resolve_path(base: &Path, path: &str) -> PathBuf {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        candidate
    } else {
        base.join(candidate)
    }
}

fn validate_cwd_policy(
    policy: &str,
    profile: &str,
    cwd: &Path,
    skill_directory: &Path,
    workspace_cwd: Option<&Path>,
) -> Result<(), RuntimeError> {
    if profile == "unrestricted-local-dev" {
        return Ok(());
    }
    let cwd = containment_path(cwd, "resolving sandbox cwd")?;
    let skill_directory = containment_path(skill_directory, "resolving sandbox skill directory")?;
    let workspace_root = match workspace_cwd {
        Some(workspace_cwd) => containment_path(workspace_cwd, "resolving sandbox workspace")?,
        None => containment_path(
            &std::env::current_dir().map_err(|source| {
                RuntimeError::io("resolving workspace cwd for sandbox policy", source)
            })?,
            "resolving sandbox workspace",
        )?,
    };
    match policy {
        "unrestricted-local-dev" => Ok(()),
        "custom"
            if is_within_path(&cwd, &skill_directory) || is_within_path(&cwd, &workspace_root) =>
        {
            Ok(())
        }
        "custom" => Err(sandbox_violation(format!(
            "sandbox custom cwd '{}' is outside skill directory '{}' and workspace '{}'",
            cwd.display(),
            skill_directory.display(),
            workspace_root.display()
        ))),
        "skill-directory" if is_within_path(&cwd, &skill_directory) => Ok(()),
        "skill-directory" => Err(sandbox_violation(format!(
            "sandbox cwd '{}' is outside skill directory '{}'",
            cwd.display(),
            skill_directory.display()
        ))),
        "workspace" if is_within_path(&cwd, &workspace_root) => Ok(()),
        "workspace" => Err(sandbox_violation(format!(
            "sandbox cwd '{}' is outside workspace '{}'",
            cwd.display(),
            workspace_root.display()
        ))),
        _ => Ok(()),
    }
}

fn is_within_path(candidate: &Path, root: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

pub(super) fn normalize_path(path: &Path) -> PathBuf {
    crate::path_util::lexical_normalize(path)
}

pub(super) fn validate_sandbox(sandbox: Option<&SkillSandbox>) -> Result<(), RuntimeError> {
    let Some(sandbox) = sandbox else {
        return Ok(());
    };
    match sandbox.profile.as_str() {
        "readonly" => validate_readonly_sandbox(sandbox),
        "workspace-write" | "network" => Ok(()),
        "unrestricted-local-dev" => validate_unrestricted_sandbox(sandbox),
        profile => Err(sandbox_violation(format!(
            "unsupported sandbox profile '{profile}'"
        ))),
    }
}

pub(super) fn resolved_writable_paths(
    sandbox: Option<&SkillSandbox>,
    inputs: &JsonObject,
    base_env: &BTreeMap<String, String>,
) -> Vec<String> {
    sandbox.map_or_else(Vec::new, |sandbox| {
        sandbox
            .writable_paths
            .iter()
            .map(|path| resolve_template(path, inputs, base_env))
            .filter(|path| !path.trim().is_empty() && !has_unresolved_template(path))
            .collect()
    })
}

pub(super) fn validated_writable_paths(
    sandbox: Option<&SkillSandbox>,
    writable_paths: &[String],
    cwd: &Path,
    workspace_cwd: Option<&Path>,
) -> Result<Vec<PathBuf>, RuntimeError> {
    let Some(sandbox) = sandbox else {
        return Ok(Vec::new());
    };
    if sandbox.profile != SandboxProfile::WorkspaceWrite {
        return Ok(Vec::new());
    }
    let workspace_root = match workspace_cwd {
        Some(workspace_cwd) => {
            containment_path(workspace_cwd, "resolving sandbox writable workspace")?
        }
        None => containment_path(
            &std::env::current_dir().map_err(|source| {
                RuntimeError::io("resolving workspace cwd for sandbox writable paths", source)
            })?,
            "resolving sandbox writable workspace",
        )?,
    };
    let resolved = writable_paths
        .iter()
        .map(|path| validate_writable_path_literal(path).map(|()| path))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|path| containment_path(&resolve_path(cwd, path), "resolving sandbox writable path"))
        .collect::<Result<Vec<_>, _>>()?;
    let escaped = resolved
        .iter()
        .filter(|path| !is_within_path(path, &workspace_root))
        .cloned()
        .collect::<Vec<_>>();
    if !escaped.is_empty() {
        return Err(sandbox_violation(format!(
            "workspace-write sandbox has writable path(s) outside workspace: {}",
            escaped
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    Ok(resolved)
}

fn validate_writable_path_literal(path: &str) -> Result<(), RuntimeError> {
    if path.chars().any(|character| {
        character.is_control() || matches!(character, '(' | ')' | '"' | '\\' | ';')
    }) {
        return Err(sandbox_violation(
            "workspace-write sandbox writable path contains unsupported profile metacharacters",
        ));
    }
    Ok(())
}

fn containment_path(path: &Path, operation: &'static str) -> Result<PathBuf, RuntimeError> {
    if path.exists() {
        return fs::canonicalize(path).map_err(|source| RuntimeError::io(operation, source));
    }
    let normalized = normalize_path(path);
    let mut ancestor = normalized.as_path();
    let mut missing_tail = Vec::new();

    loop {
        if ancestor.exists() {
            let mut resolved =
                fs::canonicalize(ancestor).map_err(|source| RuntimeError::io(operation, source))?;
            for component in missing_tail.iter().rev() {
                resolved.push(component);
            }
            return Ok(resolved);
        }

        let Some(file_name) = ancestor.file_name() else {
            return Ok(normalized);
        };
        missing_tail.push(PathBuf::from(file_name));

        let Some(parent) = ancestor
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        else {
            return Ok(normalized);
        };
        ancestor = parent;
    }
}

fn validate_readonly_sandbox(sandbox: &SkillSandbox) -> Result<(), RuntimeError> {
    if sandbox.network == Some(true) {
        return Err(sandbox_violation("readonly sandbox cannot request network"));
    }
    if !sandbox.writable_paths.is_empty() {
        return Err(sandbox_violation(
            "readonly sandbox cannot declare writable paths",
        ));
    }
    Ok(())
}

fn validate_unrestricted_sandbox(sandbox: &SkillSandbox) -> Result<(), RuntimeError> {
    if sandbox.approved_escalation == Some(true) {
        Ok(())
    } else {
        Err(sandbox_violation(
            "unrestricted-local-dev requires approved escalation",
        ))
    }
}

pub(super) fn sandbox_violation(message: impl Into<String>) -> RuntimeError {
    RuntimeError::SandboxViolation {
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::normalize_path;

    #[test]
    fn normalize_path_preserves_current_directory() {
        assert_eq!(normalize_path(Path::new(".")), PathBuf::from("."));
        assert_eq!(normalize_path(Path::new("skill/..")), PathBuf::from("."));
    }
}

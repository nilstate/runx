use std::collections::BTreeMap;
use std::path::PathBuf;

use runx_core::policy::SandboxProfile;
use runx_parser::SkillSandbox;

use super::RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV;
use super::policy::sandbox_violation;
use crate::RuntimeError;

#[derive(Clone, Debug, PartialEq)]
pub(super) enum SandboxRuntime {
    Direct,
    DeclaredPolicyOnly {
        reason: String,
    },
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Bubblewrap {
        path: PathBuf,
    },
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    SandboxExec {
        path: PathBuf,
    },
}

impl SandboxRuntime {
    pub(super) fn enforces(&self) -> bool {
        matches!(self, Self::Bubblewrap { .. } | Self::SandboxExec { .. })
    }
}

pub(super) fn resolve_sandbox_runtime(
    sandbox: Option<&SkillSandbox>,
    base_env: &BTreeMap<String, String>,
) -> Result<Option<SandboxRuntime>, RuntimeError> {
    let Some(sandbox) = sandbox else {
        return Ok(None);
    };
    if sandbox.profile == SandboxProfile::UnrestrictedLocalDev {
        if sandbox.require_enforcement == Some(true) {
            return Err(sandbox_violation(
                "unrestricted-local-dev cannot satisfy required sandbox enforcement",
            ));
        }
        return Ok(Some(SandboxRuntime::Direct));
    }

    let runtime = platform_sandbox_runtime(sandbox.profile.as_str());
    if runtime.enforces() {
        return Ok(Some(runtime));
    }
    let reason = match &runtime {
        SandboxRuntime::DeclaredPolicyOnly { reason } => reason.clone(),
        SandboxRuntime::Direct => {
            "direct execution does not enforce sandbox declarations".to_owned()
        }
        SandboxRuntime::Bubblewrap { .. } | SandboxRuntime::SandboxExec { .. } => {
            return Ok(Some(runtime));
        }
    };
    if sandbox.require_enforcement == Some(true) {
        return Err(sandbox_violation(reason));
    }
    if declared_policy_only_degradation_allowed(base_env) {
        return Ok(Some(runtime));
    }
    Err(sandbox_violation(declared_policy_only_denied_reason(
        &reason,
    )))
}

fn declared_policy_only_degradation_allowed(base_env: &BTreeMap<String, String>) -> bool {
    operator_allows_declared_policy_only(base_env)
}

fn operator_allows_declared_policy_only(base_env: &BTreeMap<String, String>) -> bool {
    base_env
        .get(RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV)
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("local"))
}

fn declared_policy_only_denied_reason(reason: &str) -> String {
    format!(
        "{reason}; set {RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV}=local only for scoped local development runs that may proceed without OS sandbox enforcement"
    )
}

fn platform_sandbox_runtime(profile: &str) -> SandboxRuntime {
    #[cfg(target_os = "linux")]
    {
        if let Some(path) = find_trusted_executable("bwrap") {
            SandboxRuntime::Bubblewrap { path }
        } else {
            SandboxRuntime::DeclaredPolicyOnly {
                reason: missing_sandbox_backend_reason(profile),
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(path) = find_usable_sandbox_exec() {
            return SandboxRuntime::SandboxExec { path };
        }
        SandboxRuntime::DeclaredPolicyOnly {
            reason: missing_sandbox_backend_reason(profile),
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        SandboxRuntime::DeclaredPolicyOnly {
            reason: missing_sandbox_backend_reason(profile),
        }
    }
}

fn missing_sandbox_backend_reason(profile: &str) -> String {
    format!(
        "local sandbox profile '{profile}' requires Linux bubblewrap or macOS sandbox-exec for filesystem and network enforcement"
    )
}

#[cfg(target_os = "macos")]
fn find_usable_sandbox_exec() -> Option<PathBuf> {
    let path = find_trusted_executable("sandbox-exec")?;
    let status = std::process::Command::new(&path)
        .args(["-p", "(version 1)\n(allow default)", "/usr/bin/true"])
        .status()
        .ok()?;
    if !status.success() {
        return None;
    }
    sandbox_exec_denies_default(&path).then_some(path)
}

#[cfg(target_os = "macos")]
fn sandbox_exec_denies_default(path: &std::path::Path) -> bool {
    std::process::Command::new(path)
        .args([
            "-p",
            "(version 1)\n(deny default)\n(allow process*)",
            "/bin/cat",
            "/etc/passwd",
        ])
        .status()
        .is_ok_and(|status| !status.success())
}

pub(super) fn find_trusted_executable(command: &str) -> Option<PathBuf> {
    default_executable_search_paths(command)
        .into_iter()
        .map(|dir| dir.join(command))
        .find(|candidate| candidate.is_file())
}

fn default_executable_search_paths(command: &str) -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("/usr/bin"), PathBuf::from("/bin")];
    if command == "sandbox-exec" {
        paths.push(PathBuf::from("/usr/sbin"));
        paths.push(PathBuf::from("/sbin"));
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::{
        RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV, declared_policy_only_degradation_allowed,
    };
    use std::collections::BTreeMap;

    #[test]
    fn declared_policy_only_requires_operator_override() {
        let mut env = BTreeMap::new();

        assert!(!declared_policy_only_degradation_allowed(&env));

        env.insert(
            RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV.to_owned(),
            "local".to_owned(),
        );
        assert!(declared_policy_only_degradation_allowed(&env));
    }
}

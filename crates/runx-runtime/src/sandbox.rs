// rust-style-allow: large-file because the sandbox root owns orchestration
// tests that exercise the split backend, command, env, metadata, and policy
// modules together.
mod backend;
mod command;
mod env;
mod metadata;
mod policy;
mod template;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use runx_contracts::JsonObject;
use runx_parser::{SkillMcpServer, SkillSource};

use crate::RuntimeError;

use self::backend::resolve_sandbox_runtime;
use self::command::{SandboxSpawnCommand, sandbox_network_enabled, sandbox_spawn_command};
use self::env::{
    child_base_env, child_env, cleanup_paths_quietly, prepare_sandbox_tmp_env,
    sandbox_private_tmp_enabled,
};
use self::metadata::sandbox_metadata_with_runtime;
use self::policy::{
    resolve_cwd, resolve_cwd_value, resolved_writable_paths, validate_sandbox,
    validated_writable_paths, workspace_cwd,
};
use self::template::resolve_template;

pub use self::metadata::sandbox_metadata;

pub(crate) const RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV: &str =
    "RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY";

#[derive(Clone, Debug, PartialEq)]
pub struct SandboxPlan {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub metadata: JsonObject,
    pub cleanup_paths: Vec<PathBuf>,
}

#[cfg(feature = "cli-tool")]
pub(crate) struct SandboxProcessPlan {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) metadata: JsonObject,
    pub(crate) cleanup_paths: Vec<PathBuf>,
}

impl SandboxPlan {
    #[cfg(feature = "cli-tool")]
    pub(crate) fn into_process_plan(mut self) -> SandboxProcessPlan {
        SandboxProcessPlan {
            command: std::mem::take(&mut self.command),
            args: std::mem::take(&mut self.args),
            cwd: std::mem::take(&mut self.cwd),
            env: std::mem::take(&mut self.env),
            metadata: std::mem::take(&mut self.metadata),
            cleanup_paths: std::mem::take(&mut self.cleanup_paths),
        }
    }
}

impl Drop for SandboxPlan {
    fn drop(&mut self) {
        cleanup_paths_quietly(&self.cleanup_paths);
    }
}

pub fn prepare_process_sandbox(
    source: &SkillSource,
    skill_directory: &Path,
    inputs: &JsonObject,
    base_env: &BTreeMap<String, String>,
) -> Result<SandboxPlan, RuntimeError> {
    let command = source.command.clone().ok_or(RuntimeError::MissingCommand)?;
    let sandbox = source.sandbox.as_ref();
    validate_sandbox(sandbox)?;
    let workspace_cwd = workspace_cwd(base_env)?;
    let cwd = resolve_cwd(source, sandbox, skill_directory, workspace_cwd.as_deref())?;
    let args = source
        .args
        .iter()
        .map(|arg| resolve_template(arg, inputs, base_env))
        .collect();
    let writable_paths = resolved_writable_paths(sandbox, inputs, base_env);
    let validated_writable_paths =
        validated_writable_paths(sandbox, &writable_paths, &cwd, workspace_cwd.as_deref())?;
    let runtime = resolve_sandbox_runtime(sandbox, base_env)?;
    let private_tmp_enabled = sandbox_private_tmp_enabled(sandbox, runtime.as_ref());
    let mut cleanup_paths = Vec::new();
    let mut sandbox_base_env = base_env.clone();
    prepare_sandbox_tmp_env(sandbox, &runtime, &mut sandbox_base_env, &mut cleanup_paths)?;
    let env = match child_env(sandbox, &sandbox_base_env, inputs, &mut cleanup_paths) {
        Ok(env) => env,
        Err(error) => {
            cleanup_paths_quietly(&cleanup_paths);
            return Err(error);
        }
    };
    let (command, args) = sandbox_spawn_command(SandboxSpawnCommand {
        runtime: runtime.as_ref(),
        command,
        args,
        cwd: &cwd,
        skill_directory,
        workspace_cwd: workspace_cwd.as_deref(),
        writable_paths: &validated_writable_paths,
        network: sandbox_network_enabled(sandbox),
        private_tmp: cleanup_paths.first().map(PathBuf::as_path),
    });
    Ok(SandboxPlan {
        command,
        args,
        cwd,
        env,
        metadata: sandbox_metadata_with_runtime(
            sandbox,
            &writable_paths,
            runtime.as_ref(),
            private_tmp_enabled,
        ),
        cleanup_paths,
    })
}

pub fn prepare_mcp_process_sandbox(
    source: &SkillSource,
    server: &SkillMcpServer,
    skill_directory: &Path,
    base_env: &BTreeMap<String, String>,
) -> Result<SandboxPlan, RuntimeError> {
    let sandbox = source.sandbox.as_ref();
    validate_sandbox(sandbox)?;
    let workspace_cwd = workspace_cwd(base_env)?;
    let cwd = resolve_cwd_value(
        server.cwd.as_deref(),
        sandbox,
        skill_directory,
        workspace_cwd.as_deref(),
    )?;
    let writable_paths = resolved_writable_paths(sandbox, &JsonObject::new(), base_env);
    let validated_writable_paths =
        validated_writable_paths(sandbox, &writable_paths, &cwd, workspace_cwd.as_deref())?;
    let runtime = resolve_sandbox_runtime(sandbox, base_env)?;
    let private_tmp_enabled = sandbox_private_tmp_enabled(sandbox, runtime.as_ref());
    let mut cleanup_paths = Vec::new();
    let mut sandbox_base_env = base_env.clone();
    prepare_sandbox_tmp_env(sandbox, &runtime, &mut sandbox_base_env, &mut cleanup_paths)?;
    let env = match child_base_env(sandbox, &sandbox_base_env) {
        Ok(env) => env,
        Err(error) => {
            cleanup_paths_quietly(&cleanup_paths);
            return Err(error);
        }
    };
    let (command, args) = sandbox_spawn_command(SandboxSpawnCommand {
        runtime: runtime.as_ref(),
        command: server.command.clone(),
        args: server.args.clone(),
        cwd: &cwd,
        skill_directory,
        workspace_cwd: workspace_cwd.as_deref(),
        writable_paths: &validated_writable_paths,
        network: sandbox_network_enabled(sandbox),
        private_tmp: cleanup_paths.first().map(PathBuf::as_path),
    });
    Ok(SandboxPlan {
        command,
        args,
        cwd,
        env,
        metadata: sandbox_metadata_with_runtime(
            sandbox,
            &writable_paths,
            runtime.as_ref(),
            private_tmp_enabled,
        ),
        cleanup_paths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    use runx_contracts::{JsonObject, JsonValue};
    use runx_core::policy::SandboxProfile;
    use runx_parser::{SkillSandbox, SourceKind};

    use super::backend::{SandboxRuntime, find_trusted_executable};
    use super::command::{
        sandbox_exec_path_filter_path, sandbox_exec_profile, sandbox_profile_string,
    };
    use super::env::{cleanup_paths_quietly, prepare_sandbox_tmp_env};
    use super::policy::{resolved_writable_paths, validated_writable_paths};

    #[test]
    fn writable_paths_omit_unresolved_optional_templates() {
        let sandbox = SkillSandbox {
            profile: SandboxProfile::WorkspaceWrite,
            cwd_policy: None,
            env_allowlist: None,
            network: None,
            writable_paths: vec![
                "{{workspace_path}}".to_owned(),
                "{{ fixture }}".to_owned(),
                "{{ env.RUNX_EFFECT_COUNT_PATH }}".to_owned(),
                "logs".to_owned(),
            ],
            require_enforcement: None,
            approved_escalation: None,
            raw: JsonObject::new(),
        };
        let inputs = [(
            "fixture".to_owned(),
            JsonValue::String("/tmp/runx-fixture".to_owned()),
        )]
        .into_iter()
        .collect();
        let env = [(
            "RUNX_EFFECT_COUNT_PATH".to_owned(),
            "/tmp/runx-effect-count.txt".to_owned(),
        )]
        .into_iter()
        .collect();

        assert_eq!(
            resolved_writable_paths(Some(&sandbox), &inputs, &env),
            vec![
                "/tmp/runx-fixture".to_owned(),
                "/tmp/runx-effect-count.txt".to_owned(),
                "logs".to_owned()
            ]
        );
    }

    #[test]
    fn trusted_enforcer_lookup_ignores_caller_path() {
        let trusted = find_trusted_executable("runx-test-enforcer-that-should-not-exist");
        assert!(trusted.is_none());
    }

    #[test]
    fn sandbox_exec_runtime_gets_private_writable_tmp_env() -> Result<(), String> {
        let sandbox = readonly_sandbox();
        let runtime = Some(SandboxRuntime::SandboxExec {
            path: PathBuf::from("/usr/bin/sandbox-exec"),
        });
        let mut env = BTreeMap::new();
        let mut cleanup_paths = Vec::new();
        prepare_sandbox_tmp_env(Some(&sandbox), &runtime, &mut env, &mut cleanup_paths)
            .map_err(|source| source.to_string())?;

        let tmpdir = env
            .get("TMPDIR")
            .ok_or_else(|| "TMPDIR was not set".to_owned())?;
        assert_eq!(env.get("TMP"), Some(tmpdir));
        assert_eq!(env.get("TEMP"), Some(tmpdir));
        assert_eq!(cleanup_paths, vec![PathBuf::from(tmpdir)]);
        assert!(Path::new(tmpdir).is_dir());

        let profile =
            sandbox_exec_profile(Path::new("/workspace"), &[], true, Some(Path::new(tmpdir)));
        assert!(profile.contains("(allow file-write* (literal \"/dev/null\"))"));
        assert!(profile.contains("(allow mach-lookup)"));
        let tmp_filter_path = sandbox_exec_path_filter_path(Path::new(tmpdir));
        assert!(profile.contains(&format!(
            "(subpath \"{}\")",
            sandbox_profile_string(&tmp_filter_path)
        )));
        cleanup_paths_quietly(&cleanup_paths);
        Ok(())
    }

    #[test]
    fn sandbox_exec_profile_keeps_legitimate_writable_path() {
        let profile = sandbox_exec_profile(
            Path::new("/workspace"),
            &[PathBuf::from("/workspace/logs/output")],
            false,
            None,
        );

        assert!(profile.contains("(allow file-write* (literal \"/workspace/logs/output\"))"));
        assert!(!profile.contains("(allow network*)"));
    }

    #[test]
    fn sandbox_exec_profile_sanitizes_metacharacters_if_validation_is_bypassed() {
        let profile = sandbox_exec_profile(
            Path::new("/workspace"),
            &[PathBuf::from("safe\")) (allow network*)")],
            false,
            None,
        );

        assert!(!profile.contains("(allow network*)"));
        assert!(!profile.contains("(subpath \"/\""));
    }

    #[test]
    fn declared_policy_runtime_gets_private_tmp_env() -> Result<(), String> {
        let sandbox = readonly_sandbox();
        let runtime = Some(SandboxRuntime::DeclaredPolicyOnly {
            reason: "missing test backend".to_owned(),
        });
        let mut env = BTreeMap::new();
        let mut cleanup_paths = Vec::new();
        prepare_sandbox_tmp_env(Some(&sandbox), &runtime, &mut env, &mut cleanup_paths)
            .map_err(|source| source.to_string())?;

        let tmpdir = env
            .get("TMPDIR")
            .ok_or_else(|| "TMPDIR was not set".to_owned())?;
        assert_eq!(env.get("TMP"), Some(tmpdir));
        assert_eq!(env.get("TEMP"), Some(tmpdir));
        assert_eq!(cleanup_paths, vec![PathBuf::from(tmpdir)]);
        assert!(Path::new(tmpdir).is_dir());

        cleanup_paths_quietly(&cleanup_paths);
        Ok(())
    }

    #[test]
    fn process_child_env_strips_receipt_signing_env() -> Result<(), String> {
        let temp = tempfile::tempdir().map_err(|source| source.to_string())?;
        let source = source_for_child_env(SourceKind::CliTool);
        let base_env = signing_env(temp.path());

        let plan = prepare_process_sandbox(&source, temp.path(), &JsonObject::new(), &base_env)
            .map_err(|source| source.to_string())?;

        assert_child_env_has_no_receipt_signing_env(&plan.env);
        Ok(())
    }

    #[test]
    fn mcp_process_child_env_strips_receipt_signing_env() -> Result<(), String> {
        let temp = tempfile::tempdir().map_err(|source| source.to_string())?;
        let source = source_for_child_env(SourceKind::Mcp);
        let server = SkillMcpServer {
            command: "node".to_owned(),
            args: vec!["server.mjs".to_owned()],
            cwd: Some(temp.path().to_string_lossy().into_owned()),
        };
        let base_env = signing_env(temp.path());

        let plan = prepare_mcp_process_sandbox(&source, &server, temp.path(), &base_env)
            .map_err(|source| source.to_string())?;

        assert_child_env_has_no_receipt_signing_env(&plan.env);
        Ok(())
    }

    fn readonly_sandbox() -> SkillSandbox {
        SkillSandbox {
            profile: SandboxProfile::Readonly,
            cwd_policy: None,
            env_allowlist: None,
            network: None,
            writable_paths: Vec::new(),
            require_enforcement: None,
            approved_escalation: None,
            raw: JsonObject::new(),
        }
    }

    fn source_for_child_env(source_type: SourceKind) -> SkillSource {
        SkillSource {
            act: None,
            source_type,
            command: Some("node".to_owned()),
            args: vec!["script.mjs".to_owned()],
            cwd: None,
            timeout_seconds: None,
            input_mode: None,
            sandbox: None,
            server: None,
            catalog_ref: None,
            tool: None,
            arguments: None,
            agent_card_url: None,
            agent_identity: None,
            agent: None,
            task: None,
            hook: None,
            outputs: None,
            graph: None,
            http: None,
            raw: JsonObject::new(),
        }
    }

    fn signing_env(workspace: &Path) -> BTreeMap<String, String> {
        [
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            (
                crate::receipts::RUNX_RECEIPT_SIGN_KID_ENV.to_owned(),
                "kid_prod".to_owned(),
            ),
            (
                crate::receipts::RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV.to_owned(),
                "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=".to_owned(),
            ),
            (
                crate::receipts::RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV.to_owned(),
                "hosted".to_owned(),
            ),
            (
                crate::receipts::paths::RUNX_CWD_ENV.to_owned(),
                workspace.to_string_lossy().into_owned(),
            ),
        ]
        .into_iter()
        .collect()
    }

    fn assert_child_env_has_no_receipt_signing_env(env: &BTreeMap<String, String>) {
        assert!(!env.contains_key(crate::receipts::RUNX_RECEIPT_SIGN_KID_ENV));
        assert!(!env.contains_key(crate::receipts::RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV));
        assert!(!env.contains_key(crate::receipts::RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV));
        assert_eq!(env.get("PATH"), Some(&"/usr/bin".to_owned()));
    }

    #[test]
    fn writable_path_rejects_sexpr_metacharacters() -> Result<(), String> {
        let temp = tempfile::tempdir().map_err(|source| source.to_string())?;
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).map_err(|source| source.to_string())?;
        let sandbox = SkillSandbox {
            profile: SandboxProfile::WorkspaceWrite,
            cwd_policy: None,
            env_allowlist: None,
            network: None,
            writable_paths: Vec::new(),
            require_enforcement: None,
            approved_escalation: None,
            raw: JsonObject::new(),
        };

        let error = validated_writable_paths(
            Some(&sandbox),
            &["safe\")) (allow network*)".to_owned()],
            &workspace,
            Some(&workspace),
        )
        .err()
        .ok_or_else(|| "sexpr metacharacter path unexpectedly passed".to_owned())?;

        assert!(
            error.to_string().contains("profile metacharacters"),
            "unexpected error: {error}"
        );
        Ok(())
    }

    #[test]
    fn workspace_write_allows_uncreated_nested_workspace_path() -> Result<(), String> {
        let temp = tempfile::tempdir().map_err(|source| source.to_string())?;
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).map_err(|source| source.to_string())?;
        let sandbox = SkillSandbox {
            profile: SandboxProfile::WorkspaceWrite,
            cwd_policy: None,
            env_allowlist: None,
            network: None,
            writable_paths: Vec::new(),
            require_enforcement: None,
            approved_escalation: None,
            raw: JsonObject::new(),
        };

        validated_writable_paths(
            Some(&sandbox),
            &["dist/cache/output.json".to_owned()],
            &workspace,
            Some(&workspace),
        )
        .map(|_| ())
        .map_err(|source| source.to_string())
    }

    #[test]
    #[cfg(unix)]
    fn workspace_write_rejects_symlink_escape() -> Result<(), String> {
        let temp = tempfile::tempdir().map_err(|source| source.to_string())?;
        let workspace = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&workspace).map_err(|source| source.to_string())?;
        fs::create_dir_all(&outside).map_err(|source| source.to_string())?;
        std::os::unix::fs::symlink(&outside, workspace.join("link"))
            .map_err(|source| source.to_string())?;
        let sandbox = SkillSandbox {
            profile: SandboxProfile::WorkspaceWrite,
            cwd_policy: None,
            env_allowlist: None,
            network: None,
            writable_paths: Vec::new(),
            require_enforcement: None,
            approved_escalation: None,
            raw: JsonObject::new(),
        };

        let error = validated_writable_paths(
            Some(&sandbox),
            &["link/escape.txt".to_owned()],
            &workspace,
            Some(&workspace),
        )
        .err()
        .ok_or_else(|| "symlink escape unexpectedly passed".to_owned())?;

        assert!(
            error.to_string().contains("outside workspace"),
            "unexpected error: {error}"
        );
        Ok(())
    }
}

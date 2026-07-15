use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use runx_contracts::{JsonObject, JsonValue};
use runx_core::policy::CwdPolicy;
use runx_parser::SkillSandbox;

use crate::RuntimeError;
use crate::sandbox::SandboxPlan;

const DEFAULT_SANDBOX_ENV_ALLOWLIST: [&str; 9] = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
];

pub(super) fn mcp_process_sandbox_metadata(
    sandbox: Option<&SkillSandbox>,
    plan: &SandboxPlan,
    env: &BTreeMap<String, String>,
) -> Result<JsonObject, RuntimeError> {
    let config = mcp_sandbox_metadata_config(sandbox);
    let mut metadata = mcp_sandbox_location_metadata(&config, plan, env)?;
    metadata.insert(
        "env".to_owned(),
        JsonValue::Object(mcp_sandbox_env_metadata(
            config.env_allowlist,
            config.inherited_ambient,
        )),
    );
    metadata.insert(
        "network".to_owned(),
        JsonValue::Object(mcp_sandbox_network_metadata(config.profile, config.network)),
    );
    metadata.insert(
        "writable_paths".to_owned(),
        mcp_sandbox_writable_paths_metadata(config.writable_paths),
    );
    metadata.insert(
        "require_enforcement".to_owned(),
        JsonValue::Bool(config.require_enforcement),
    );
    metadata.insert(
        "filesystem".to_owned(),
        JsonValue::Object(mcp_sandbox_filesystem_metadata(config.profile)),
    );
    metadata.insert(
        "approval".to_owned(),
        JsonValue::Object(mcp_sandbox_approval_metadata(&config)),
    );
    metadata.insert(
        "runtime".to_owned(),
        JsonValue::Object(mcp_sandbox_runtime_metadata(config.profile)),
    );
    Ok(metadata)
}

struct McpSandboxMetadataConfig<'a> {
    profile: &'a str,
    cwd_policy: &'a str,
    env_allowlist: Option<&'a Vec<String>>,
    approved_escalation: bool,
    require_enforcement: bool,
    network: bool,
    writable_paths: &'a [String],
    inherited_ambient: bool,
}

fn mcp_sandbox_metadata_config(sandbox: Option<&SkillSandbox>) -> McpSandboxMetadataConfig<'_> {
    let profile = sandbox
        .map(|sandbox| sandbox.profile.as_str())
        .unwrap_or("readonly");
    let approved_escalation = sandbox
        .and_then(|sandbox| sandbox.approved_escalation)
        .unwrap_or(false);
    let env_allowlist = sandbox.and_then(|sandbox| sandbox.env_allowlist.as_ref());
    McpSandboxMetadataConfig {
        profile,
        cwd_policy: sandbox
            .and_then(|sandbox| sandbox.cwd_policy.as_ref().map(CwdPolicy::as_str))
            .unwrap_or("skill-directory"),
        env_allowlist,
        approved_escalation,
        require_enforcement: sandbox
            .and_then(|sandbox| sandbox.require_enforcement)
            .unwrap_or(false),
        network: sandbox.and_then(|sandbox| sandbox.network).unwrap_or(false),
        writable_paths: sandbox
            .map(|sandbox| sandbox.writable_paths.as_slice())
            .unwrap_or(&[]),
        inherited_ambient: env_allowlist.is_none()
            && profile == "unrestricted-local-dev"
            && approved_escalation,
    }
}

fn mcp_sandbox_location_metadata(
    config: &McpSandboxMetadataConfig<'_>,
    plan: &SandboxPlan,
    env: &BTreeMap<String, String>,
) -> Result<JsonObject, RuntimeError> {
    let mut metadata = JsonObject::new();
    metadata.insert(
        "profile".to_owned(),
        JsonValue::String(config.profile.to_owned()),
    );
    metadata.insert("cwd".to_owned(), JsonValue::String(path_string(&plan.cwd)));
    metadata.insert(
        "workspace_root".to_owned(),
        JsonValue::String(path_string(&workspace_root(env)?)),
    );
    metadata.insert(
        "cwd_policy".to_owned(),
        JsonValue::String(config.cwd_policy.to_owned()),
    );
    Ok(metadata)
}

fn mcp_sandbox_writable_paths_metadata(writable_paths: &[String]) -> JsonValue {
    JsonValue::Array(
        writable_paths
            .iter()
            .cloned()
            .map(JsonValue::String)
            .collect(),
    )
}

fn mcp_sandbox_approval_metadata(config: &McpSandboxMetadataConfig<'_>) -> JsonObject {
    [
        (
            "required".to_owned(),
            JsonValue::Bool(config.profile == "unrestricted-local-dev"),
        ),
        (
            "approved".to_owned(),
            JsonValue::Bool(config.approved_escalation),
        ),
    ]
    .into()
}

fn mcp_sandbox_env_metadata(
    env_allowlist: Option<&Vec<String>>,
    inherited_ambient: bool,
) -> JsonObject {
    if inherited_ambient {
        return [(
            "mode".to_owned(),
            JsonValue::String("ambient-inherited".to_owned()),
        )]
        .into();
    }

    let allowlist = env_allowlist
        .cloned()
        .unwrap_or_else(|| {
            DEFAULT_SANDBOX_ENV_ALLOWLIST
                .into_iter()
                .map(str::to_owned)
                .collect()
        })
        .into_iter()
        .map(JsonValue::String)
        .collect();
    [
        (
            "mode".to_owned(),
            JsonValue::String(if env_allowlist.is_some() {
                "allowlist".to_owned()
            } else {
                "default-allowlist".to_owned()
            }),
        ),
        ("allowlist".to_owned(), JsonValue::Array(allowlist)),
    ]
    .into()
}

fn mcp_sandbox_network_metadata(profile: &str, network: bool) -> JsonObject {
    [
        ("declared".to_owned(), JsonValue::Bool(network)),
        (
            "enforcement".to_owned(),
            JsonValue::String(if profile == "unrestricted-local-dev" {
                "host-ambient".to_owned()
            } else {
                "not-enforced-local".to_owned()
            }),
        ),
    ]
    .into()
}

fn mcp_sandbox_filesystem_metadata(profile: &str) -> JsonObject {
    [
        (
            "enforcement".to_owned(),
            JsonValue::String(if profile == "unrestricted-local-dev" {
                "host-ambient".to_owned()
            } else {
                "not-enforced-local".to_owned()
            }),
        ),
        (
            "readonly_paths".to_owned(),
            JsonValue::Bool(profile != "unrestricted-local-dev"),
        ),
        ("writable_paths_enforced".to_owned(), JsonValue::Bool(false)),
        ("private_tmp".to_owned(), JsonValue::Bool(false)),
    ]
    .into()
}

fn mcp_sandbox_runtime_metadata(profile: &str) -> JsonObject {
    if profile == "unrestricted-local-dev" {
        return [(
            "enforcer".to_owned(),
            JsonValue::String("direct".to_owned()),
        )]
        .into();
    }
    [
        (
            "enforcer".to_owned(),
            JsonValue::String("declared-policy-only".to_owned()),
        ),
        (
            "reason".to_owned(),
            JsonValue::String(format!(
                "local sandbox profile '{profile}' requires Linux bubblewrap or macOS sandbox-exec for filesystem and network enforcement"
            )),
        ),
    ]
    .into()
}

fn workspace_root(env: &BTreeMap<String, String>) -> Result<PathBuf, RuntimeError> {
    let cwd = std::env::current_dir()
        .map_err(|source| RuntimeError::io("resolving workspace cwd", source))?;
    Ok(crate::config::resolve_runx_workspace_base(env, &cwd))
}

fn path_string(path: &Path) -> String {
    path.components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .replace('\\', "/")
}

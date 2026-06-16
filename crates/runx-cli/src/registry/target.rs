use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use runx_runtime::registry::RegistryManifestSourceAuthority;

use super::RegistryPlan;

#[derive(Clone, Debug)]
pub(crate) enum RegistryTarget {
    Remote {
        registry_url: String,
    },
    Local {
        registry_path: PathBuf,
        registry_url: Option<String>,
        source_kind: LocalRegistrySourceKind,
    },
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum LocalRegistrySourceKind {
    Local,
    File,
}

impl RegistryTarget {
    pub(crate) fn label(&self) -> &'static str {
        match self {
            Self::Remote { .. } => "remote",
            Self::Local { source_kind, .. } => match source_kind {
                LocalRegistrySourceKind::Local => "local",
                LocalRegistrySourceKind::File => "file",
            },
        }
    }

    pub(crate) fn fingerprint_source(&self) -> String {
        match self {
            Self::Remote { registry_url } => {
                format!("remote:{}", canonical_remote_registry_url(registry_url))
            }
            Self::Local {
                registry_path,
                source_kind,
                ..
            } => {
                let absolute =
                    fs::canonicalize(registry_path).unwrap_or_else(|_| registry_path.to_path_buf());
                match source_kind {
                    LocalRegistrySourceKind::Local => format!("local:{}", absolute.display()),
                    LocalRegistrySourceKind::File => format!("file:{}", absolute.display()),
                }
            }
        }
    }

    pub(crate) fn manifest_source_authority(&self) -> RegistryManifestSourceAuthority {
        match self {
            Self::Remote { registry_url } => {
                runx_runtime::registry::registry_manifest_source_authority_from_registry_url(
                    registry_url,
                )
            }
            Self::Local {
                registry_url: Some(registry_url),
                ..
            } if runx_runtime::registry::is_official_runx_registry_url(registry_url) => {
                RegistryManifestSourceAuthority::OfficialRunx
            }
            Self::Local {
                registry_url: Some(registry_url),
                ..
            } => runx_runtime::registry::registry_manifest_source_authority_from_registry_url(
                registry_url,
            ),
            Self::Local { registry_path, .. } => {
                runx_runtime::registry::registry_manifest_source_authority_from_registry_dir(
                    &registry_path.to_string_lossy(),
                )
            }
        }
    }
}

pub(crate) fn resolve_registry_target(
    plan: &RegistryPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> RegistryTarget {
    let configured_registry = plan
        .registry
        .as_deref()
        .or_else(|| env.get("RUNX_REGISTRY_URL").map(String::as_str));
    if let Some(registry) = &plan.registry {
        if is_remote_registry_url(registry) {
            return RegistryTarget::Remote {
                registry_url: registry.clone(),
            };
        }
        return RegistryTarget::Local {
            registry_path: registry_path_from_value(registry, env, cwd),
            registry_url: env
                .get("RUNX_REGISTRY_URL")
                .filter(|value| is_remote_registry_url(value))
                .cloned(),
            source_kind: if registry.starts_with("file://") {
                LocalRegistrySourceKind::File
            } else {
                LocalRegistrySourceKind::Local
            },
        };
    }
    if let Some(registry_dir) = &plan.registry_dir {
        return RegistryTarget::Local {
            registry_path: super::resolve_path(registry_dir, env, cwd, false),
            registry_url: configured_registry
                .filter(|value| is_remote_registry_url(value))
                .map(ToOwned::to_owned),
            source_kind: LocalRegistrySourceKind::Local,
        };
    }
    if let Some(registry_dir) = env.get("RUNX_REGISTRY_DIR") {
        return RegistryTarget::Local {
            registry_path: runx_runtime::resolve_path_from_user_input(
                registry_dir,
                env,
                cwd,
                false,
            ),
            registry_url: configured_registry
                .filter(|value| is_remote_registry_url(value))
                .map(ToOwned::to_owned),
            source_kind: LocalRegistrySourceKind::Local,
        };
    }
    if let Some(registry) = configured_registry.filter(|value| is_remote_registry_url(value)) {
        return RegistryTarget::Remote {
            registry_url: registry.to_owned(),
        };
    }
    RegistryTarget::Local {
        registry_path: runx_runtime::resolve_runx_global_home_dir(env, cwd).join("registry"),
        registry_url: configured_registry.map(ToOwned::to_owned),
        source_kind: LocalRegistrySourceKind::Local,
    }
}

pub(crate) fn destination_root(
    plan: &RegistryPlan,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> PathBuf {
    plan.destination
        .as_ref()
        .map(|path| super::resolve_path(path, env, cwd, false))
        .unwrap_or_else(|| workspace_base(env, cwd).join("skills"))
}

pub(crate) fn official_skills_cache_root(env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    env.get("RUNX_OFFICIAL_SKILLS_DIR")
        .map(|value| runx_runtime::resolve_path_from_user_input(value, env, cwd, false))
        .unwrap_or_else(|| {
            runx_runtime::resolve_runx_global_home_dir(env, cwd).join("official-skills")
        })
}

pub(crate) fn registry_skills_cache_root(env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    runx_runtime::resolve_runx_global_home_dir(env, cwd).join("registry-skills")
}

pub(crate) fn registry_source_description(target: &RegistryTarget) -> String {
    match target {
        RegistryTarget::Remote { registry_url } => {
            format!("remote {}", canonical_remote_registry_url(registry_url))
        }
        RegistryTarget::Local {
            registry_path,
            source_kind,
            ..
        } => match source_kind {
            LocalRegistrySourceKind::Local => format!("local {}", registry_path.display()),
            LocalRegistrySourceKind::File => format!("file {}", registry_path.display()),
        },
    }
}

pub(crate) fn workspace_base(env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    env.get("RUNX_CWD")
        .map(PathBuf::from)
        .or_else(|| find_workspace_root(cwd))
        .or_else(|| env.get("INIT_CWD").map(PathBuf::from))
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn registry_path_from_value(value: &str, env: &BTreeMap<String, String>, cwd: &Path) -> PathBuf {
    if let Some(path) = value.strip_prefix("file://") {
        return PathBuf::from(path);
    }
    runx_runtime::resolve_path_from_user_input(value, env, cwd, false)
}

fn find_workspace_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if current.join("pnpm-workspace.yaml").exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn canonical_remote_registry_url(value: &str) -> String {
    let without_fragment = value.split_once('#').map_or(value, |(prefix, _)| prefix);
    let without_query = without_fragment
        .split_once('?')
        .map_or(without_fragment, |(prefix, _)| prefix);
    let Some((scheme, rest)) = without_query.split_once("://") else {
        return without_query.trim_end_matches('/').to_owned();
    };
    let (authority, path) = rest
        .split_once('/')
        .map_or((rest, ""), |(authority, path)| (authority, path));
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    if path.is_empty() {
        format!("{scheme}://{authority}")
    } else {
        format!("{scheme}://{authority}/{}", path.trim_end_matches('/'))
    }
}

fn is_remote_registry_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

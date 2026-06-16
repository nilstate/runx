use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::receipts::paths::{RUNX_CWD_ENV, RUNX_PROJECT_DIR_ENV};
use crate::services::tool_roots::inferred_tool_roots;

const PROCESS_ENV_KEYS: [&str; 3] = ["PATH", "SystemRoot", "PATHEXT"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceEnv {
    env: BTreeMap<String, String>,
    cwd: PathBuf,
}

impl WorkspaceEnv {
    pub(crate) fn new(env: BTreeMap<String, String>, cwd: PathBuf) -> Self {
        Self { env, cwd }
    }

    pub(crate) fn env(&self) -> &BTreeMap<String, String> {
        &self.env
    }

    pub(crate) fn cwd(&self) -> &Path {
        &self.cwd
    }

    pub(crate) fn graph_env_for_skill(&self, skill_dir: &Path) -> BTreeMap<String, String> {
        let mut env = self.env.clone();
        for key in PROCESS_ENV_KEYS {
            if !env.contains_key(key)
                && let Ok(value) = std::env::var(key)
            {
                env.insert(key.to_owned(), value);
            }
        }
        let cwd = self.cwd.to_string_lossy().into_owned();
        env.entry(RUNX_CWD_ENV.to_owned())
            .or_insert_with(|| cwd.clone());
        env.entry(RUNX_PROJECT_DIR_ENV.to_owned()).or_insert(cwd);
        if let Some(joined) = inferred_tool_roots(skill_dir) {
            env.entry(crate::services::tool_roots::RUNX_TOOL_ROOTS_ENV.to_owned())
                .or_insert(joined);
        }
        env
    }
}

pub(crate) fn process_env_value(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

#[cfg(any(feature = "mcp", feature = "agent"))]
pub(crate) fn process_env_snapshot() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

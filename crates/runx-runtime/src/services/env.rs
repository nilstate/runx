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
        let cwd = crate::config::resolve_runx_workspace_base(&env, &cwd);
        Self { env, cwd }
    }

    pub(crate) fn env(&self) -> &BTreeMap<String, String> {
        &self.env
    }

    pub(crate) fn cwd(&self) -> &Path {
        &self.cwd
    }

    pub(crate) fn skill_env_for_skill(&self, skill_dir: &Path) -> BTreeMap<String, String> {
        let mut env = self.env.clone();
        for key in PROCESS_ENV_KEYS {
            if !env.contains_key(key)
                && let Ok(value) = std::env::var(key)
            {
                env.insert(key.to_owned(), value);
            }
        }
        let cwd = self.cwd.to_string_lossy().into_owned();
        env.insert(RUNX_CWD_ENV.to_owned(), cwd);
        env.entry(RUNX_PROJECT_DIR_ENV.to_owned())
            .or_insert_with(|| self.cwd.join(".runx").to_string_lossy().into_owned());
        merge_inferred_tool_roots(&mut env, skill_dir);
        env
    }
}

pub(crate) fn merge_inferred_tool_roots(env: &mut BTreeMap<String, String>, skill_dir: &Path) {
    if let Some(joined) = inferred_tool_roots(skill_dir) {
        let key = crate::services::tool_roots::RUNX_TOOL_ROOTS_ENV.to_owned();
        env.entry(key)
            .and_modify(|existing| *existing = merge_path_env(existing, &joined))
            .or_insert(joined);
    }
}

fn merge_path_env(existing: &str, addition: &str) -> String {
    let mut paths: Vec<PathBuf> = std::env::split_paths(existing).collect();
    for path in std::env::split_paths(addition) {
        if !paths.iter().any(|existing_path| existing_path == &path) {
            paths.push(path);
        }
    }
    std::env::join_paths(paths)
        .ok()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            if existing.is_empty() {
                addition.to_owned()
            } else if addition.is_empty() {
                existing.to_owned()
            } else {
                let separator = if cfg!(windows) { ';' } else { ':' };
                format!("{existing}{separator}{addition}")
            }
        })
}

pub(crate) fn process_env_value(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

#[cfg(any(feature = "cli-tool", feature = "mcp", feature = "agent"))]
pub(crate) fn process_env_snapshot() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::merge_path_env;

    #[test]
    fn merge_path_env_appends_new_paths_and_deduplicates_existing_paths()
    -> Result<(), std::env::JoinPathsError> {
        let first = PathBuf::from("/runx/tools");
        let second = PathBuf::from("/runx/skills/data-store/tools");
        let existing = path_list_string([first.as_path()])?;
        let addition = path_list_string([second.as_path(), first.as_path()])?;

        let merged = merge_path_env(&existing, &addition);
        let paths = std::env::split_paths(&merged).collect::<Vec<_>>();

        assert_eq!(paths, vec![first, second]);
        Ok(())
    }

    fn path_list_string<'a>(
        paths: impl IntoIterator<Item = &'a std::path::Path>,
    ) -> Result<String, std::env::JoinPathsError> {
        std::env::join_paths(paths).map(|value| value.to_string_lossy().into_owned())
    }
}

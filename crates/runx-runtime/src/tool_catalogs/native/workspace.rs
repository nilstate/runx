use std::path::{Path, PathBuf};

use crate::RuntimeError;

use super::invalid_input;

pub(crate) fn resolve_repo_root_for(
    tool: &str,
    requested: &str,
    env: &std::collections::BTreeMap<String, String>,
    skill_directory: &Path,
) -> Result<PathBuf, RuntimeError> {
    crate::services::resolve_scoped_root(requested, "workspace", env, skill_directory)
        .map_err(|error| invalid_input(tool, error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_filesystem_roots_accept_workspace_relative_paths_and_reject_external_absolute_paths()
    -> Result<(), Box<dyn std::error::Error>> {
        let workspace = tempfile::tempdir()?;
        let external = tempfile::tempdir()?;
        let env = std::collections::BTreeMap::from([(
            crate::receipts::paths::RUNX_CWD_ENV.to_owned(),
            workspace.path().to_string_lossy().into_owned(),
        )]);

        assert_eq!(
            resolve_repo_root_for("fs.read", ".", &env, workspace.path())?,
            workspace.path().canonicalize()?
        );
        let error = resolve_repo_root_for(
            "fs.read",
            &external.path().to_string_lossy(),
            &env,
            workspace.path(),
        )
        .err()
        .ok_or("external absolute root unexpectedly resolved")?;
        assert!(
            error
                .to_string()
                .contains("must be relative to the runtime workspace")
        );
        Ok(())
    }
}

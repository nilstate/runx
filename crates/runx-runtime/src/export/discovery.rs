use std::fs;
use std::path::{Path, PathBuf};

use super::RunxExportLoadError;

pub(super) fn discover_skill_paths(root: &Path) -> Result<Vec<PathBuf>, RunxExportLoadError> {
    let mut paths = crate::skill_package::discover_workspace_skill_package_dirs(root)
        .map_err(|error| RunxExportLoadError::Parse(error.to_string()))?;
    if root.join("SKILL.md").exists() {
        paths.push(root.to_path_buf());
    }
    paths = paths
        .into_iter()
        .map(|path| canonicalize(&path, "canonicalizing skill directory"))
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub(super) fn canonicalize(path: &Path, context: &str) -> Result<PathBuf, RunxExportLoadError> {
    fs::canonicalize(path).map_err(|source| RunxExportLoadError::Io {
        context: format!("{context} {}", display_path(path)),
        source,
    })
}

pub(super) fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

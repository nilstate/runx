use std::fs;
use std::path::{Path, PathBuf};

use super::RunxExportLoadError;
use super::discovery::{canonicalize, display_path};

pub(super) fn resolve_skill_ref(
    root: &Path,
    reference: &str,
    official_roots: &[PathBuf],
) -> Result<PathBuf, RunxExportLoadError> {
    let reference_path = Path::new(reference);
    let candidates = if reference_path.is_absolute() {
        vec![reference_path.to_path_buf()]
    } else {
        vec![
            root.join("skills").join(reference_path),
            root.join(reference_path),
        ]
    };
    for candidate in candidates {
        if let Some(skill_dir) = skill_dir_if_exists(&candidate) {
            return canonicalize(&skill_dir, "canonicalizing skill reference");
        }
    }
    if let Some(skill_dir) = resolve_official_skill_ref(reference, official_roots)? {
        return canonicalize(&skill_dir, "canonicalizing official skill reference");
    }
    Err(RunxExportLoadError::InvalidArgs(format!(
        "skill reference {reference} does not resolve to a SKILL.md package"
    )))
}

fn skill_dir_if_exists(candidate: &Path) -> Option<PathBuf> {
    let skill_dir = if candidate
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
    {
        candidate.parent().map(Path::to_path_buf)
    } else {
        Some(candidate.to_path_buf())
    }?;
    skill_dir.join("SKILL.md").exists().then_some(skill_dir)
}

fn resolve_official_skill_ref(
    reference: &str,
    official_roots: &[PathBuf],
) -> Result<Option<PathBuf>, RunxExportLoadError> {
    let Some(name) = official_skill_name(reference) else {
        return Ok(None);
    };
    for root in official_roots {
        for candidate in [root.join(name), root.join("runx").join(name)] {
            if let Some(skill_dir) = skill_dir_if_exists(&candidate) {
                return Ok(Some(skill_dir));
            }
            let versioned = versioned_skill_dirs(&candidate)?;
            if versioned.len() == 1 {
                return Ok(versioned.into_iter().next());
            }
            if versioned.len() > 1 {
                return Err(RunxExportLoadError::InvalidArgs(format!(
                    "official skill reference {reference} is ambiguous in {}; use an explicit skill path",
                    display_path(&candidate)
                )));
            }
        }
    }
    Ok(None)
}

fn official_skill_name(reference: &str) -> Option<&str> {
    if reference
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Some(reference);
    }
    reference.strip_prefix("runx/").filter(|name| {
        !name.is_empty()
            && name.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })
    })
}

fn versioned_skill_dirs(root: &Path) -> Result<Vec<PathBuf>, RunxExportLoadError> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(RunxExportLoadError::Io {
                context: format!("reading {}", display_path(root)),
                source,
            });
        }
    };
    let mut dirs = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| RunxExportLoadError::Io {
            context: format!("reading {}", display_path(root)),
            source,
        })?;
        if let Some(skill_dir) = skill_dir_if_exists(&entry.path()) {
            dirs.push(skill_dir);
        }
    }
    dirs.sort();
    Ok(dirs)
}

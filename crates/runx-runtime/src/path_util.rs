use std::path::{Component, Path, PathBuf};

use crate::RuntimeError;
use crate::filesystem::read_dir_sorted;

pub(crate) fn count_yaml_files(directory: &Path) -> Result<u64, RuntimeError> {
    let mut count = 0;
    for entry in read_dir_sorted(directory)? {
        if entry.is_file && is_yaml_path(&entry.path) {
            count += 1;
        }
    }
    Ok(count)
}

pub(crate) fn is_yaml_path(path: &Path) -> bool {
    path.extension()
        .map(|extension| {
            let extension = extension.to_string_lossy();
            extension.eq_ignore_ascii_case("yaml") || extension.eq_ignore_ascii_case("yml")
        })
        .unwrap_or(false)
}

pub(crate) fn project_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|component| match component {
            Component::Normal(segment) => Some(segment.to_string_lossy().into_owned()),
            Component::CurDir => Some(".".to_owned()),
            Component::ParentDir => Some("..".to_owned()),
            Component::Prefix(_) | Component::RootDir => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub(crate) fn display_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Prefix(prefix) => Some(prefix.as_os_str().to_string_lossy().into_owned()),
            Component::RootDir => Some(String::new()),
            Component::Normal(segment) => Some(segment.to_string_lossy().into_owned()),
            Component::CurDir => None,
            Component::ParentDir => Some("..".to_owned()),
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub(crate) fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push("..");
                }
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    normalized
}

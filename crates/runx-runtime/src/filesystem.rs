use std::fs;
use std::path::{Path, PathBuf};

use crate::RuntimeError;

#[derive(Clone, Debug)]
pub(crate) struct DirectoryEntry {
    pub(crate) name: String,
    pub(crate) path: PathBuf,
    pub(crate) is_dir: bool,
    pub(crate) is_file: bool,
}

pub(crate) fn read_dir_sorted(directory: &Path) -> Result<Vec<DirectoryEntry>, RuntimeError> {
    match fs::read_dir(directory) {
        Ok(entries) => {
            let mut output = Vec::new();
            for entry in entries {
                let entry = entry.map_err(|source| {
                    RuntimeError::io(format!("reading directory {}", directory.display()), source)
                })?;
                let file_type = entry.file_type().map_err(|source| {
                    RuntimeError::io(
                        format!("reading file type {}", entry.path().display()),
                        source,
                    )
                })?;
                output.push(DirectoryEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: entry.path(),
                    is_dir: file_type.is_dir(),
                    is_file: file_type.is_file(),
                });
            }
            output.sort_by(|left, right| left.name.cmp(&right.name));
            Ok(output)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(source) => Err(RuntimeError::io(
            format!("reading directory {}", directory.display()),
            source,
        )),
    }
}

pub(crate) fn read_to_string(path: &Path) -> Result<String, RuntimeError> {
    fs::read_to_string(path)
        .map_err(|source| RuntimeError::io(format!("reading {}", path.display()), source))
}

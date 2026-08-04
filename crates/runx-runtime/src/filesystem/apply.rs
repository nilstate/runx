use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use runx_contracts::{JsonNumber, JsonObject, JsonValue, sha256_prefixed};

use super::admission::{AdmittedBundle, PriorFile};
use super::invalid_bundle;
use crate::RuntimeError;

pub(super) fn apply_admitted_bundle(bundle: &AdmittedBundle) -> Result<(), RuntimeError> {
    for write in &bundle.writes {
        let parent = write.absolute.parent().ok_or_else(|| {
            invalid_bundle(&bundle.operation, "bundle write has no parent directory")
        })?;
        fs::create_dir_all(parent).map_err(|source| {
            RuntimeError::io(
                format!("creating bundle directory {}", parent.display()),
                source,
            )
        })?;
        let permissions = fs::metadata(&write.absolute)
            .ok()
            .map(|metadata| metadata.permissions());
        replace_file(
            &bundle.operation,
            &write.absolute,
            write.contents.as_bytes(),
            permissions.as_ref(),
        )?;
    }
    for (_, path) in &bundle.deletes {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(RuntimeError::io(
                    format!("deleting bundle file {}", path.display()),
                    source,
                ));
            }
        }
    }
    Ok(())
}

fn replace_file(
    operation: &str,
    path: &Path,
    contents: &[u8],
    permissions: Option<&fs::Permissions>,
) -> Result<(), RuntimeError> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid_bundle(operation, "bundle file has no parent directory"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| invalid_bundle(operation, "bundle file name is not valid UTF-8"))?;
    let (temporary, file) = create_temporary_file(parent, file_name)?;
    if let Err(error) = write_temporary_file(file, &temporary, contents, permissions) {
        let _ignored = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(source) = fs::rename(&temporary, path) {
        let _ignored = fs::remove_file(&temporary);
        return Err(RuntimeError::io(
            format!("committing bundle file {}", path.display()),
            source,
        ));
    }
    Ok(())
}

fn create_temporary_file(
    parent: &Path,
    file_name: &str,
) -> Result<(PathBuf, fs::File), RuntimeError> {
    let mut attempt = 0u32;
    loop {
        let candidate = parent.join(format!(
            ".{file_name}.runx-write-{}-{attempt}",
            std::process::id()
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && attempt < 100 => {
                attempt += 1;
            }
            Err(source) => {
                return Err(RuntimeError::io(
                    format!("creating temporary bundle file {}", candidate.display()),
                    source,
                ));
            }
        }
    }
}

fn write_temporary_file(
    mut file: fs::File,
    path: &Path,
    contents: &[u8],
    permissions: Option<&fs::Permissions>,
) -> Result<(), RuntimeError> {
    use std::io::Write;

    file.write_all(contents)
        .map_err(|source| RuntimeError::io(format!("writing {}", path.display()), source))?;
    if let Some(permissions) = permissions {
        file.set_permissions(permissions.clone())
            .map_err(|source| {
                RuntimeError::io(
                    format!("preserving permissions on {}", path.display()),
                    source,
                )
            })?;
    }
    file.sync_all()
        .map_err(|source| RuntimeError::io(format!("syncing {}", path.display()), source))
}

pub(super) fn rollback_paths(
    operation: &str,
    root: &Path,
    snapshots: &std::collections::BTreeMap<String, PriorFile>,
    created_directories: &[PathBuf],
) -> Result<(), RuntimeError> {
    for (relative, prior) in snapshots.iter().rev() {
        let path = root.join(relative);
        match prior {
            PriorFile::Absent => match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(RuntimeError::io(
                        format!("rolling back {}", path.display()),
                        source,
                    ));
                }
            },
            PriorFile::File {
                contents,
                permissions,
            } => {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|source| {
                        RuntimeError::io(
                            format!("restoring bundle directory {}", parent.display()),
                            source,
                        )
                    })?;
                }
                replace_file(operation, &path, contents, Some(permissions))?;
            }
        }
    }
    for directory in created_directories.iter().rev() {
        match fs::remove_dir(directory) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty
                ) => {}
            Err(source) => {
                return Err(RuntimeError::io(
                    format!("removing rolled-back directory {}", directory.display()),
                    source,
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn bundle_report(
    bundle: &AdmittedBundle,
    snapshots: &std::collections::BTreeMap<String, PriorFile>,
) -> JsonObject {
    let writes = bundle
        .writes
        .iter()
        .map(|write| {
            JsonValue::Object(JsonObject::from([
                ("path".to_owned(), JsonValue::String(write.relative.clone())),
                (
                    "bytes_written".to_owned(),
                    JsonValue::Number(JsonNumber::U64(write.contents.len() as u64)),
                ),
                (
                    "sha256".to_owned(),
                    JsonValue::String(sha256_prefixed(write.contents.as_bytes())),
                ),
            ]))
        })
        .collect();
    let deletes = bundle
        .deletes
        .iter()
        .map(|(relative, _)| {
            let status = match snapshots.get(relative) {
                Some(PriorFile::File { .. }) => "deleted",
                Some(PriorFile::Absent) | None => "already_absent",
            };
            JsonValue::Object(JsonObject::from([
                ("path".to_owned(), JsonValue::String(relative.clone())),
                ("status".to_owned(), JsonValue::String(status.to_owned())),
            ]))
        })
        .collect();
    JsonObject::from([
        (
            "repo_root".to_owned(),
            JsonValue::String(bundle.root.to_string_lossy().into_owned()),
        ),
        (
            "write_count".to_owned(),
            JsonValue::Number(JsonNumber::U64(bundle.writes.len() as u64)),
        ),
        (
            "delete_count".to_owned(),
            JsonValue::Number(JsonNumber::U64(bundle.deletes.len() as u64)),
        ),
        ("writes".to_owned(), JsonValue::Array(writes)),
        ("deletes".to_owned(), JsonValue::Array(deletes)),
    ])
}

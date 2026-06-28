use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::document::EffectStateDocument;
use super::{EFFECT_STATE_SCHEMA_VERSION, EffectStateError};
pub(super) fn load_effect_state(path: &Path) -> Result<EffectStateDocument, EffectStateError> {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|source| EffectStateError::Parse {
                path: path.to_path_buf(),
                source,
            })
            .and_then(|state: EffectStateDocument| {
                if state.schema_version == EFFECT_STATE_SCHEMA_VERSION {
                    Ok(state)
                } else {
                    Err(EffectStateError::UnsupportedSchemaVersion {
                        path: path.to_path_buf(),
                        version: state.schema_version,
                    })
                }
            }),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            Ok(EffectStateDocument::default())
        }
        Err(source) => Err(EffectStateError::Read {
            path: path.to_path_buf(),
            source,
        }),
    }
}

pub(super) fn persist_effect_state(
    path: &Path,
    state: &EffectStateDocument,
) -> Result<(), EffectStateError> {
    let parent = path
        .parent()
        .ok_or_else(|| EffectStateError::MissingParent {
            path: path.to_path_buf(),
        })?;
    fs::create_dir_all(parent).map_err(|source| EffectStateError::CreateDirectory {
        path: parent.to_path_buf(),
        source,
    })?;
    write_json_atomically(path, state)
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), EffectStateError> {
    let parent = path
        .parent()
        .ok_or_else(|| EffectStateError::MissingParent {
            path: path.to_path_buf(),
        })?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("effect-state.json");
    let temp_path = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        monotonicish_nanos()
    ));

    let write_result = (|| {
        let mut file = File::create(&temp_path).map_err(|source| EffectStateError::Write {
            path: temp_path.clone(),
            source,
        })?;
        serde_json::to_writer_pretty(&mut file, value).map_err(|source| {
            EffectStateError::Serialize {
                path: temp_path.clone(),
                source,
            }
        })?;
        file.write_all(b"\n")
            .map_err(|source| EffectStateError::Write {
                path: temp_path.clone(),
                source,
            })?;
        file.sync_all().map_err(|source| EffectStateError::Write {
            path: temp_path.clone(),
            source,
        })?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    fs::rename(&temp_path, path).map_err(|source| {
        let _ = fs::remove_file(&temp_path);
        EffectStateError::Write {
            path: path.to_path_buf(),
            source,
        }
    })
}

fn monotonicish_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

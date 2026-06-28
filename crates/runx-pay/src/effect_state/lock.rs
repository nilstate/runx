use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use super::EffectStateError;

const EFFECT_STATE_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const EFFECT_STATE_LOCK_RETRY: Duration = Duration::from_millis(10);
#[derive(Debug)]
pub(super) struct EffectStateLock {
    path: PathBuf,
    _file: File,
}

impl EffectStateLock {
    pub(super) fn acquire(path: &Path) -> Result<Self, EffectStateError> {
        let parent = path
            .parent()
            .ok_or_else(|| EffectStateError::MissingParent {
                path: path.to_path_buf(),
            })?;
        fs::create_dir_all(parent).map_err(|source| EffectStateError::CreateDirectory {
            path: parent.to_path_buf(),
            source,
        })?;
        let lock_path = effect_state_lock_path(path);
        let started = Instant::now();
        loop {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(file) => {
                    return Ok(Self {
                        path: lock_path,
                        _file: file,
                    });
                }
                Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
                    if started.elapsed() >= EFFECT_STATE_LOCK_TIMEOUT {
                        return Err(EffectStateError::Lock {
                            path: path.to_path_buf(),
                            message: format!("timed out waiting for lock {}", lock_path.display()),
                        });
                    }
                    thread::sleep(EFFECT_STATE_LOCK_RETRY);
                }
                Err(source) => {
                    return Err(EffectStateError::Lock {
                        path: path.to_path_buf(),
                        message: source.to_string(),
                    });
                }
            }
        }
    }
}

impl Drop for EffectStateLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn effect_state_lock_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("effect-state.json");
    path.with_file_name(format!(".{file_name}.lock"))
}

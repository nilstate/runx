use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::file_store::FileBackedEffectStateStore;
use super::hosted_store::{
    HostedEffectStateBackend, HostedEffectStateStore, hosted_transport_missing,
};
use super::{
    EffectStateError, EffectStateStore, HOSTED_EFFECT_STATE_STORE_REF,
    HOSTED_TRANSACTIONAL_BACKEND_KIND, RUNX_EFFECT_STATE_PATH_ENV,
    RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV,
};
pub fn resolve_effect_state_path(env: &BTreeMap<String, String>, cwd: &Path) -> Option<PathBuf> {
    env.get(RUNX_EFFECT_STATE_PATH_ENV)
        .filter(|value| !value.trim().is_empty())
        .map(|value| resolve_path(Path::new(value), cwd))
        .or_else(|| {
            env.get(runx_runtime::RUNX_RECEIPT_DIR_ENV)
                .filter(|value| !value.trim().is_empty())
                .map(|value| resolve_path(Path::new(value), cwd).join("effect-state.json"))
        })
}

pub fn hosted_effect_state_backend_is_supported(
    env: &BTreeMap<String, String>,
) -> Result<bool, EffectStateError> {
    resolve_hosted_effect_state_backend(env).map(|backend| backend.is_some())
}

pub(super) fn open_supported_effect_state_store(
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<Option<Box<dyn EffectStateStore>>, EffectStateError> {
    if let Some(backend) = resolve_hosted_effect_state_backend(env)? {
        return Ok(Some(Box::new(HostedEffectStateStore::open(backend)?)));
    }
    let Some(path) = resolve_effect_state_path(env, cwd) else {
        return Ok(None);
    };
    Ok(Some(Box::new(FileBackedEffectStateStore::open(path)?)))
}

fn resolve_hosted_effect_state_backend(
    env: &BTreeMap<String, String>,
) -> Result<Option<HostedEffectStateBackend>, EffectStateError> {
    let Some(raw) = env
        .get(RUNX_HOSTED_EFFECT_STATE_BACKEND_JSON_ENV)
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };

    let backend: HostedEffectStateBackend =
        serde_json::from_str(raw).map_err(|source| EffectStateError::HostedBackendInvalid {
            message: source.to_string(),
        })?;

    if backend.kind != HOSTED_TRANSACTIONAL_BACKEND_KIND {
        return Err(EffectStateError::HostedBackendInvalid {
            message: format!("unsupported backend kind {}", backend.kind),
        });
    }
    if backend.store_ref != HOSTED_EFFECT_STATE_STORE_REF {
        return Err(EffectStateError::HostedBackendInvalid {
            message: format!("unsupported store_ref {}", backend.store_ref),
        });
    }
    if backend.tenant_id.trim().is_empty() {
        return Err(EffectStateError::HostedBackendInvalid {
            message: "tenant_id is required".to_owned(),
        });
    }
    if backend.endpoint_url.is_none() || backend.bearer_token.is_none() {
        return Err(hosted_transport_missing());
    }
    if backend.allowed_families.is_empty() {
        return Err(EffectStateError::HostedBackendInvalid {
            message: "allowed_families is required for hosted effect-state transport".to_owned(),
        });
    }

    Ok(Some(backend))
}

fn resolve_path(path: &Path, cwd: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

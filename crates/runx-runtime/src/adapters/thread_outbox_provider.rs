//! First-class graph-step adapter for the thread-outbox provider protocol.
//!
//! The process supervisor owns provider publication and readback validation.
//! This adapter is deliberately small: it resolves skill-local manifest/request
//! frames, invokes the supervisor, and projects the accepted observation into the
//! universal graph-step output shape.

use std::path::{Component, Path, PathBuf};

use runx_contracts::{
    JsonValue, ThreadOutboxProviderFetch, ThreadOutboxProviderManifest,
    ThreadOutboxProviderOperation,
};
use serde::de::DeserializeOwned;
use thiserror::Error;

use crate::RuntimeError;
use crate::adapter::{InvocationOutput, SkillAdapter, SkillInvocation};
use crate::outbox_provider::{
    ThreadOutboxProviderProcessSupervisor, ThreadOutboxProviderSupervisorError,
    ThreadOutboxProviderSupervisorOptions,
};

mod dynamic_push;
mod output;
use dynamic_push::{dynamic_push_from_inputs, skipped_dynamic_push_outcome};
use output::skill_output_from_outcome;

const THREAD_OUTBOX_PROVIDER: &str = "thread-outbox-provider";
const MANIFEST_PATH_FIELD: &str = "manifest_path";
const PUSH_PATH_FIELD: &str = "push_path";
const FETCH_PATH_FIELD: &str = "fetch_path";
#[derive(Clone, Debug, Default)]
pub struct ThreadOutboxProviderSkillAdapter {
    supervisor_options: ThreadOutboxProviderSupervisorOptions,
}

impl SkillAdapter for ThreadOutboxProviderSkillAdapter {
    fn adapter_type(&self) -> &'static str {
        THREAD_OUTBOX_PROVIDER
    }

    fn invoke(&self, request: SkillInvocation) -> Result<InvocationOutput, RuntimeError> {
        if request.source.source_type != runx_parser::SourceKind::ThreadOutboxProvider {
            return Err(RuntimeError::UnsupportedAdapter {
                adapter_type: request.source.source_type.as_str().to_owned(),
            });
        }
        let skill_name = request.skill_name.clone();
        invoke_thread_outbox_provider_skill(request, &self.supervisor_options).map_err(|error| {
            RuntimeError::SkillFailed {
                skill_name,
                message: error.to_string(),
            }
        })
    }
}

#[derive(Debug, Error)]
pub enum ThreadOutboxProviderSkillAdapterError {
    #[error("thread-outbox-provider source is missing source.thread_outbox_provider")]
    MissingConfig,
    #[error("thread-outbox-provider source.thread_outbox_provider.{field} is required")]
    MissingConfigField { field: &'static str },
    #[error(
        "thread-outbox-provider {field} must be a relative path below the skill directory: '{path}'"
    )]
    InvalidFramePath { field: &'static str, path: String },
    #[error(
        "thread-outbox-provider {field} '{path}' escapes the skill directory '{skill_directory}'"
    )]
    FramePathEscapesSkillDirectory {
        field: &'static str,
        path: String,
        skill_directory: String,
    },
    #[error("thread-outbox-provider {field} file '{path}' could not be read: {source}")]
    FrameRead {
        field: &'static str,
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("thread-outbox-provider JSON failed while {context}: {source}")]
    Json {
        context: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("thread-outbox-provider dynamic push input '{field}' is required")]
    MissingDynamicInput { field: &'static str },
    #[error("thread-outbox-provider dynamic push input '{field}' must be {expected}")]
    InvalidDynamicInput {
        field: &'static str,
        expected: &'static str,
    },
    #[error(
        "thread-outbox-provider dynamic push input '{field}' must contain a non-empty '{nested}' string"
    )]
    MissingDynamicInputString {
        field: &'static str,
        nested: &'static str,
    },
    #[error(transparent)]
    Supervisor(#[from] ThreadOutboxProviderSupervisorError),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
}

fn invoke_thread_outbox_provider_skill(
    request: SkillInvocation,
    supervisor_options: &ThreadOutboxProviderSupervisorOptions,
) -> Result<InvocationOutput, ThreadOutboxProviderSkillAdapterError> {
    let config = request
        .source
        .thread_outbox_provider
        .as_ref()
        .ok_or(ThreadOutboxProviderSkillAdapterError::MissingConfig)?;
    let manifest: ThreadOutboxProviderManifest = contract_from_skill_file(
        &request.skill_directory,
        MANIFEST_PATH_FIELD,
        &config.manifest_path,
    )?;
    let mut environment = crate::execution_environment::process_baseline_environment(&request.env);
    environment.extend(crate::execution_environment::resolve_declared_environment(
        &request.requirements,
        &request.env,
    )?);
    let supervisor =
        ThreadOutboxProviderProcessSupervisor::new(ThreadOutboxProviderSupervisorOptions {
            cwd: Some(canonical_skill_directory(
                &request.skill_directory,
                MANIFEST_PATH_FIELD,
            )?),
            environment,
            ..supervisor_options.clone()
        });
    let outcome = match config.operation {
        ThreadOutboxProviderOperation::Push => {
            let push = match config.push_path.as_deref() {
                Some(push_path) => {
                    contract_from_skill_file(&request.skill_directory, PUSH_PATH_FIELD, push_path)?
                }
                None => {
                    let Some(push) = dynamic_push_from_inputs(
                        &manifest,
                        &request.inputs,
                        &request.credential_delivery,
                    )?
                    else {
                        return skill_output_from_outcome(skipped_dynamic_push_outcome(
                            &manifest,
                            &request.inputs,
                        )?);
                    };
                    push
                }
            };
            supervisor.invoke_push(&manifest, &push, &request.credential_delivery)?
        }
        ThreadOutboxProviderOperation::Fetch => {
            let fetch_path = config.fetch_path.as_deref().ok_or(
                ThreadOutboxProviderSkillAdapterError::MissingConfigField {
                    field: FETCH_PATH_FIELD,
                },
            )?;
            let fetch: ThreadOutboxProviderFetch =
                contract_from_skill_file(&request.skill_directory, FETCH_PATH_FIELD, fetch_path)?;
            supervisor.invoke_fetch(&manifest, &fetch, &request.credential_delivery)?
        }
    };
    skill_output_from_outcome(outcome)
}

fn contract_from_skill_file<T>(
    skill_directory: &Path,
    field: &'static str,
    relative_path: &str,
) -> Result<T, ThreadOutboxProviderSkillAdapterError>
where
    T: DeserializeOwned,
{
    let path = skill_file_path(skill_directory, field, relative_path)?;
    let bytes = std::fs::read(&path).map_err(|source| {
        ThreadOutboxProviderSkillAdapterError::FrameRead {
            field,
            path: path.to_string_lossy().into_owned(),
            source,
        }
    })?;
    let value: JsonValue = serde_json::from_slice(&bytes).map_err(|source| {
        json_error(
            format!("parsing thread-outbox-provider {field} file"),
            source,
        )
    })?;
    let value = match value {
        JsonValue::Object(mut object) => {
            let expected = object.remove("expected");
            expected.unwrap_or(JsonValue::Object(object))
        }
        other => other,
    };
    let value = serde_json::to_value(&value).map_err(|source| {
        json_error(
            format!("serializing thread-outbox-provider {field} frame"),
            source,
        )
    })?;
    serde_json::from_value(value).map_err(|source| {
        json_error(
            format!("validating thread-outbox-provider {field} frame"),
            source,
        )
    })
}

fn skill_file_path(
    skill_directory: &Path,
    field: &'static str,
    relative_path: &str,
) -> Result<PathBuf, ThreadOutboxProviderSkillAdapterError> {
    validate_relative_path(field, relative_path)?;
    let skill_directory_display = skill_directory.to_string_lossy().into_owned();
    let skill_directory = canonical_skill_directory(skill_directory, field)?;
    let path = skill_directory.join(relative_path);
    let canonical_path =
        path.canonicalize()
            .map_err(|source| ThreadOutboxProviderSkillAdapterError::FrameRead {
                field,
                path: path.to_string_lossy().into_owned(),
                source,
            })?;
    if !canonical_path.starts_with(&skill_directory) {
        return Err(
            ThreadOutboxProviderSkillAdapterError::FramePathEscapesSkillDirectory {
                field,
                path: relative_path.to_owned(),
                skill_directory: skill_directory_display,
            },
        );
    }
    Ok(canonical_path)
}

fn canonical_skill_directory(
    skill_directory: &Path,
    field: &'static str,
) -> Result<PathBuf, ThreadOutboxProviderSkillAdapterError> {
    skill_directory.canonicalize().map_err(|source| {
        ThreadOutboxProviderSkillAdapterError::FrameRead {
            field,
            path: skill_directory.to_string_lossy().into_owned(),
            source,
        }
    })
}

fn validate_relative_path(
    field: &'static str,
    relative_path: &str,
) -> Result<(), ThreadOutboxProviderSkillAdapterError> {
    let path = Path::new(relative_path);
    let valid = !relative_path.trim().is_empty()
        && path.is_relative()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    if valid {
        Ok(())
    } else {
        Err(ThreadOutboxProviderSkillAdapterError::InvalidFramePath {
            field,
            path: relative_path.to_owned(),
        })
    }
}

fn json_error(
    context: impl Into<String>,
    source: serde_json::Error,
) -> ThreadOutboxProviderSkillAdapterError {
    ThreadOutboxProviderSkillAdapterError::Json {
        context: context.into(),
        source,
    }
}

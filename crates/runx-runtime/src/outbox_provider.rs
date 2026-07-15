// rust-style-allow: large-file - the thread-outbox provider supervisor keeps transport, manifest
// validation, secret rejection, and redaction in one module so the provider boundary is reviewed
// as a single trust surface.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use runx_contracts::{
    JsonValue, ThreadOutboxProviderFetch, ThreadOutboxProviderManifest,
    ThreadOutboxProviderObservation, ThreadOutboxProviderObservationStatus,
    ThreadOutboxProviderOperation, ThreadOutboxProviderPush, ThreadOutboxProviderTransportKind,
};
use thiserror::Error;

use crate::credentials::CredentialDelivery;
use crate::process::{ProcessOutcome, ProcessSpec, ProcessStdin, run_process};
use crate::redaction::trim_ascii_whitespace;

const DEFAULT_TIMEOUT_MS: u64 = 5_000;
const DEFAULT_OUTPUT_LIMIT_BYTES: usize = 1_048_576;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadOutboxProviderSupervisorOptions {
    pub timeout_ms: u64,
    pub output_limit_bytes: usize,
    pub cwd: Option<PathBuf>,
}

impl Default for ThreadOutboxProviderSupervisorOptions {
    fn default() -> Self {
        Self {
            timeout_ms: DEFAULT_TIMEOUT_MS,
            output_limit_bytes: DEFAULT_OUTPUT_LIMIT_BYTES,
            cwd: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ThreadOutboxProviderProcessOutcome {
    pub observation: ThreadOutboxProviderObservation,
    pub provider_output: Option<runx_contracts::JsonObject>,
    pub redacted_stderr: String,
    pub process_exit_code: Option<i32>,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Default)]
pub struct ThreadOutboxProviderProcessSupervisor {
    options: ThreadOutboxProviderSupervisorOptions,
}

impl ThreadOutboxProviderProcessSupervisor {
    #[must_use]
    pub fn new(options: ThreadOutboxProviderSupervisorOptions) -> Self {
        Self { options }
    }

    pub fn invoke_push(
        &self,
        manifest: &ThreadOutboxProviderManifest,
        push: &ThreadOutboxProviderPush,
        credential_delivery: &CredentialDelivery,
    ) -> Result<ThreadOutboxProviderProcessOutcome, ThreadOutboxProviderSupervisorError> {
        validate_manifest(manifest, ThreadOutboxProviderOperation::Push)?;
        validate_push(manifest, push)?;
        self.invoke(
            manifest,
            ThreadOutboxProviderRequest::Push(push),
            credential_delivery,
        )
    }

    pub fn invoke_fetch(
        &self,
        manifest: &ThreadOutboxProviderManifest,
        fetch: &ThreadOutboxProviderFetch,
        credential_delivery: &CredentialDelivery,
    ) -> Result<ThreadOutboxProviderProcessOutcome, ThreadOutboxProviderSupervisorError> {
        validate_manifest(manifest, ThreadOutboxProviderOperation::Fetch)?;
        validate_fetch(manifest, fetch)?;
        self.invoke(
            manifest,
            ThreadOutboxProviderRequest::Fetch(fetch),
            credential_delivery,
        )
    }

    fn invoke(
        &self,
        manifest: &ThreadOutboxProviderManifest,
        request: ThreadOutboxProviderRequest<'_>,
        credential_delivery: &CredentialDelivery,
    ) -> Result<ThreadOutboxProviderProcessOutcome, ThreadOutboxProviderSupervisorError> {
        let output = self.run_provider_process(manifest, &request, credential_delivery)?;
        self.interpret_provider_process_output(manifest, &request, credential_delivery, output)
    }

    fn run_provider_process(
        &self,
        manifest: &ThreadOutboxProviderManifest,
        request: &ThreadOutboxProviderRequest<'_>,
        credential_delivery: &CredentialDelivery,
    ) -> Result<ProcessOutcome, ThreadOutboxProviderSupervisorError> {
        let command = process_command(manifest)?;
        run_process(
            ProcessSpec::new(
                "thread-outbox-provider",
                command.to_string_lossy().into_owned(),
                self.options.output_limit_bytes,
            )
            .args(manifest.transport.args.clone().unwrap_or_default())
            .env(provider_process_env(credential_delivery))
            .stdin(Some(ProcessStdin::new(
                request_bytes(request)?,
                "writing thread outbox provider request",
            )))
            .timeout(Some(Duration::from_millis(self.options.timeout_ms)))
            .cwd(self.options.cwd.clone().unwrap_or_else(current_dir)),
        )
        .map_err(|source| ThreadOutboxProviderSupervisorError::Process {
            context: "running thread outbox provider process".to_owned(),
            detail: source.to_string(),
        })
    }

    fn interpret_provider_process_output(
        &self,
        manifest: &ThreadOutboxProviderManifest,
        request: &ThreadOutboxProviderRequest<'_>,
        credential_delivery: &CredentialDelivery,
        output: ProcessOutcome,
    ) -> Result<ThreadOutboxProviderProcessOutcome, ThreadOutboxProviderSupervisorError> {
        if output.timed_out {
            return Err(ThreadOutboxProviderSupervisorError::TimedOut {
                timeout_ms: self.options.timeout_ms,
            });
        }
        if !output.cleanup_errors.is_empty() {
            return Err(ThreadOutboxProviderSupervisorError::Process {
                context: "cleaning thread outbox provider process resources".to_owned(),
                detail: output.cleanup_errors.join("; "),
            });
        }
        let redacted_stderr = credential_delivery
            .redact_bytes_to_string(output.stderr.bytes, self.options.output_limit_bytes);
        if !output.status.success() {
            return Err(ThreadOutboxProviderSupervisorError::ProcessFailed {
                exit_status: output.status.to_string(),
                stderr: redacted_stderr,
            });
        }
        if output.stdout.truncated {
            return Err(ThreadOutboxProviderSupervisorError::ResponseTooLarge {
                limit_bytes: self.options.output_limit_bytes,
            });
        }
        if output.stderr.truncated || redacted_stderr.len() > self.options.output_limit_bytes {
            return Err(ThreadOutboxProviderSupervisorError::StderrTooLarge {
                limit_bytes: self.options.output_limit_bytes,
            });
        }
        let provider_response = parse_provider_response(&output.stdout.bytes, credential_delivery)?;
        let observation = provider_response.observation;
        validate_observation(manifest, request, &observation)?;
        Ok(ThreadOutboxProviderProcessOutcome {
            observation,
            provider_output: provider_response.output,
            redacted_stderr,
            process_exit_code: output.status.code(),
            duration_ms: output.duration_ms,
        })
    }
}

#[derive(Debug, Error)]
pub enum ThreadOutboxProviderSupervisorError {
    #[error("unsupported thread outbox provider manifest schema '{schema}'")]
    UnsupportedManifestSchema { schema: String },
    #[error("unsupported thread outbox provider request schema '{schema}'")]
    UnsupportedRequestSchema { schema: String },
    #[error("unsupported thread outbox provider observation schema '{schema}'")]
    UnsupportedObservationSchema { schema: String },
    #[error("unsupported thread outbox provider protocol '{protocol_version}'")]
    UnsupportedProtocol { protocol_version: String },
    #[error(
        "thread outbox provider adapter id mismatch: manifest '{manifest}', request '{request}'"
    )]
    AdapterIdMismatch { manifest: String, request: String },
    #[error("thread outbox provider provider mismatch: manifest '{manifest}', request '{request}'")]
    ProviderMismatch { manifest: String, request: String },
    #[error("thread outbox provider manifest does not support operation '{operation}'")]
    UnsupportedOperation { operation: String },
    #[error("thread outbox provider v1 only supports process transport")]
    UnsupportedTransport,
    #[error("thread outbox provider process command is missing")]
    MissingProcessCommand,
    #[error("thread outbox provider process command is empty")]
    EmptyProcessCommand,
    #[error("thread outbox provider process timed out after {timeout_ms}ms")]
    TimedOut { timeout_ms: u64 },
    #[error("thread outbox provider process failed with {exit_status}: {stderr}")]
    ProcessFailed { exit_status: String, stderr: String },
    #[error("thread outbox provider response exceeded {limit_bytes} bytes")]
    ResponseTooLarge { limit_bytes: usize },
    #[error("thread outbox provider stderr exceeded {limit_bytes} bytes")]
    StderrTooLarge { limit_bytes: usize },
    #[error("thread outbox provider response was empty")]
    EmptyResponse,
    #[error("thread outbox provider response envelope output must be an object when present")]
    InvalidResponseEnvelopeOutput,
    #[error("thread outbox provider response contained private secret-like field '{field}'")]
    SecretFieldRejected { field: String },
    #[error(
        "thread outbox provider observation adapter id mismatch: expected '{expected}', got '{actual}'"
    )]
    ObservationAdapterMismatch { expected: String, actual: String },
    #[error(
        "thread outbox provider observation provider mismatch: expected '{expected}', got '{actual}'"
    )]
    ObservationProviderMismatch { expected: String, actual: String },
    #[error(
        "thread outbox provider observation operation mismatch: expected '{expected}', got '{actual}'"
    )]
    ObservationOperationMismatch { expected: String, actual: String },
    #[error(
        "thread outbox provider observation request id mismatch: expected '{expected}', got '{actual}'"
    )]
    ObservationRequestMismatch { expected: String, actual: String },
    #[error("accepted thread outbox provider push observation must include provider locator")]
    MissingProviderLocator,
    #[error("{context}: {source}")]
    Json {
        context: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{context}: {detail}")]
    Process { context: String, detail: String },
}

enum ThreadOutboxProviderRequest<'a> {
    Push(&'a ThreadOutboxProviderPush),
    Fetch(&'a ThreadOutboxProviderFetch),
}

impl ThreadOutboxProviderRequest<'_> {
    fn operation(&self) -> ThreadOutboxProviderOperation {
        match self {
            Self::Push(_) => ThreadOutboxProviderOperation::Push,
            Self::Fetch(_) => ThreadOutboxProviderOperation::Fetch,
        }
    }

    fn request_id(&self) -> &str {
        match self {
            Self::Push(push) => &push.push_id,
            Self::Fetch(fetch) => &fetch.fetch_id,
        }
    }
}

fn validate_manifest(
    manifest: &ThreadOutboxProviderManifest,
    operation: ThreadOutboxProviderOperation,
) -> Result<(), ThreadOutboxProviderSupervisorError> {
    // `schema` and `protocol_version` are const-typed contract enums, so the
    // wire decoder already rejects any other value; no runtime re-check needed.
    if !manifest.supported_operations.contains(&operation) {
        return Err(ThreadOutboxProviderSupervisorError::UnsupportedOperation {
            operation: format!("{operation:?}"),
        });
    }
    if manifest.transport.kind != ThreadOutboxProviderTransportKind::Process
        || manifest.transport.endpoint.is_some()
    {
        return Err(ThreadOutboxProviderSupervisorError::UnsupportedTransport);
    }
    let _command = process_command(manifest)?;
    Ok(())
}

fn validate_push(
    manifest: &ThreadOutboxProviderManifest,
    push: &ThreadOutboxProviderPush,
) -> Result<(), ThreadOutboxProviderSupervisorError> {
    // `schema` / `protocol_version` are const-typed enums; the decoder enforces
    // them, so only request identity needs a runtime check.
    validate_request_identity(manifest, push.adapter_id.as_str(), push.provider.as_str())
}

fn validate_fetch(
    manifest: &ThreadOutboxProviderManifest,
    fetch: &ThreadOutboxProviderFetch,
) -> Result<(), ThreadOutboxProviderSupervisorError> {
    // `schema` / `protocol_version` are const-typed enums; the decoder enforces
    // them, so only request identity needs a runtime check.
    validate_request_identity(manifest, fetch.adapter_id.as_str(), fetch.provider.as_str())
}

fn validate_request_identity(
    manifest: &ThreadOutboxProviderManifest,
    adapter_id: &str,
    provider: &str,
) -> Result<(), ThreadOutboxProviderSupervisorError> {
    if manifest.adapter_id != adapter_id {
        return Err(ThreadOutboxProviderSupervisorError::AdapterIdMismatch {
            manifest: manifest.adapter_id.to_string(),
            request: adapter_id.to_owned(),
        });
    }
    if manifest.provider != provider {
        return Err(ThreadOutboxProviderSupervisorError::ProviderMismatch {
            manifest: manifest.provider.to_string(),
            request: provider.to_owned(),
        });
    }
    Ok(())
}

fn process_command(
    manifest: &ThreadOutboxProviderManifest,
) -> Result<PathBuf, ThreadOutboxProviderSupervisorError> {
    let Some(command) = manifest.transport.command.as_deref() else {
        return Err(ThreadOutboxProviderSupervisorError::MissingProcessCommand);
    };
    let command = command.trim();
    if command.is_empty() {
        return Err(ThreadOutboxProviderSupervisorError::EmptyProcessCommand);
    }
    Ok(resolve_process_command(command))
}

fn resolve_process_command(command: &str) -> PathBuf {
    let path = Path::new(command);
    if path.is_absolute() || path.components().count() > 1 {
        return path.to_path_buf();
    }

    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(command);
            if candidate.is_file() {
                return candidate;
            }
            #[cfg(windows)]
            {
                if candidate.extension().is_some() {
                    continue;
                }
                if let Some(exts) = std::env::var_os("PATHEXT") {
                    for ext in std::env::split_paths(&exts) {
                        let ext = ext.to_string_lossy();
                        let candidate = dir.join(format!("{command}{ext}"));
                        if candidate.is_file() {
                            return candidate;
                        }
                    }
                }
            }
        }
    }

    PathBuf::from(command)
}

fn request_bytes(
    request: &ThreadOutboxProviderRequest<'_>,
) -> Result<Vec<u8>, ThreadOutboxProviderSupervisorError> {
    let mut bytes = Vec::new();
    match request {
        ThreadOutboxProviderRequest::Push(push) => serde_json::to_writer(&mut bytes, push),
        ThreadOutboxProviderRequest::Fetch(fetch) => serde_json::to_writer(&mut bytes, fetch),
    }
    .map_err(|source| json_error("serializing thread outbox provider request", source))?;
    bytes.push(b'\n');
    Ok(bytes)
}

struct ThreadOutboxProviderProviderResponse {
    observation: ThreadOutboxProviderObservation,
    output: Option<runx_contracts::JsonObject>,
}

fn parse_provider_response(
    bytes: &[u8],
    credential_delivery: &CredentialDelivery,
) -> Result<ThreadOutboxProviderProviderResponse, ThreadOutboxProviderSupervisorError> {
    let bytes = trim_ascii_whitespace(bytes);
    if bytes.is_empty() {
        return Err(ThreadOutboxProviderSupervisorError::EmptyResponse);
    }
    let mut value: JsonValue = serde_json::from_slice(bytes)
        .map_err(|source| json_error("parsing thread outbox provider observation", source))?;
    reject_secret_like_fields(&value, "$")?;
    redact_json_value(&mut value, credential_delivery);
    let (observation_value, output) = provider_response_parts(value)?;
    let redacted = serde_json::to_vec(&observation_value).map_err(|source| {
        json_error(
            "serializing redacted thread outbox provider observation",
            source,
        )
    })?;
    let mut observation: ThreadOutboxProviderObservation = serde_json::from_slice(&redacted)
        .map_err(|source| json_error("validating thread outbox provider observation", source))?;
    if observation.delivery_observations.is_none() {
        if let Some(delivery_observation) = credential_delivery.public_observation() {
            observation.delivery_observations = Some(vec![delivery_observation.clone()]);
        }
    }
    Ok(ThreadOutboxProviderProviderResponse {
        observation,
        output,
    })
}

fn provider_response_parts(
    value: JsonValue,
) -> Result<(JsonValue, Option<runx_contracts::JsonObject>), ThreadOutboxProviderSupervisorError> {
    match value {
        JsonValue::Object(object) => {
            let Some(observation_value) = object.get("observation") else {
                return Ok((JsonValue::Object(object), None));
            };
            let output = match object.get("output") {
                Some(JsonValue::Object(output)) => Some(output.clone()),
                Some(JsonValue::Null) | None => None,
                Some(_) => {
                    return Err(ThreadOutboxProviderSupervisorError::InvalidResponseEnvelopeOutput);
                }
            };
            Ok((observation_value.clone(), output))
        }
        other => Ok((other, None)),
    }
}

fn validate_observation(
    manifest: &ThreadOutboxProviderManifest,
    request: &ThreadOutboxProviderRequest<'_>,
    observation: &ThreadOutboxProviderObservation,
) -> Result<(), ThreadOutboxProviderSupervisorError> {
    // `schema` / `protocol_version` are const-typed enums enforced by the
    // decoder; only cross-field identity needs runtime validation.
    if observation.adapter_id != manifest.adapter_id {
        return Err(
            ThreadOutboxProviderSupervisorError::ObservationAdapterMismatch {
                expected: manifest.adapter_id.to_string(),
                actual: observation.adapter_id.to_string(),
            },
        );
    }
    if observation.provider != manifest.provider {
        return Err(
            ThreadOutboxProviderSupervisorError::ObservationProviderMismatch {
                expected: manifest.provider.to_string(),
                actual: observation.provider.to_string(),
            },
        );
    }
    let expected_operation = request.operation();
    if observation.operation != expected_operation {
        return Err(
            ThreadOutboxProviderSupervisorError::ObservationOperationMismatch {
                expected: format!("{expected_operation:?}"),
                actual: format!("{:?}", observation.operation),
            },
        );
    }
    if observation.request_id != request.request_id() {
        return Err(
            ThreadOutboxProviderSupervisorError::ObservationRequestMismatch {
                expected: request.request_id().to_owned(),
                actual: observation.request_id.to_string(),
            },
        );
    }
    if request.operation() == ThreadOutboxProviderOperation::Push
        && observation.status == ThreadOutboxProviderObservationStatus::Accepted
        && observation.provider_locator.is_none()
    {
        return Err(ThreadOutboxProviderSupervisorError::MissingProviderLocator);
    }
    Ok(())
}

fn reject_secret_like_fields(
    value: &JsonValue,
    path: &str,
) -> Result<(), ThreadOutboxProviderSupervisorError> {
    match value {
        JsonValue::Object(object) => {
            for (key, child) in object {
                let child_path = format!("{path}.{key}");
                if secret_like_key(key) {
                    return Err(ThreadOutboxProviderSupervisorError::SecretFieldRejected {
                        field: child_path,
                    });
                }
                reject_secret_like_fields(child, &child_path)?;
            }
        }
        JsonValue::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                reject_secret_like_fields(child, &format!("{path}[{index}]"))?;
            }
        }
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_) => {}
    }
    Ok(())
}

fn secret_like_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|ch| *ch != '_' && *ch != '-' && *ch != '.')
        .flat_map(char::to_lowercase)
        .collect();
    const SECRET_KEYS: &[&str] = &[
        "token",
        "accesstoken",
        "apikey",
        "secret",
        "password",
        "authorization",
    ];
    SECRET_KEYS.contains(&normalized.as_str())
}

fn redact_json_value(value: &mut JsonValue, credential_delivery: &CredentialDelivery) {
    match value {
        JsonValue::String(text) => {
            *text = credential_delivery.redact_text(std::mem::take(text));
        }
        JsonValue::Array(values) => {
            for child in values {
                redact_json_value(child, credential_delivery);
            }
        }
        JsonValue::Object(object) => {
            for child in object.values_mut() {
                redact_json_value(child, credential_delivery);
            }
        }
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => {}
    }
}

fn current_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn provider_process_env(
    credential_delivery: &CredentialDelivery,
) -> std::collections::BTreeMap<String, String> {
    provider_process_env_from(credential_delivery, |key| std::env::var(key).ok())
}

fn provider_process_env_from(
    credential_delivery: &CredentialDelivery,
    mut value_for_key: impl FnMut(&str) -> Option<String>,
) -> std::collections::BTreeMap<String, String> {
    let mut env = [
        "PATH",
        "SystemRoot",
        "PATHEXT",
        "HOME",
        "TMPDIR",
        "TMP",
        "TEMP",
    ]
    .into_iter()
    .filter_map(|key| value_for_key(key).map(|value| (key.to_owned(), value)))
    .collect::<std::collections::BTreeMap<_, _>>();
    env.extend(
        credential_delivery
            .secret_env()
            .iter()
            .map(|(key, value)| (key.to_owned(), value.to_owned())),
    );
    env
}

fn json_error(
    context: impl Into<String>,
    source: serde_json::Error,
) -> ThreadOutboxProviderSupervisorError {
    ThreadOutboxProviderSupervisorError::Json {
        context: context.into(),
        source,
    }
}

#[must_use]
pub fn thread_outbox_provider_forbidden_secret_fields() -> BTreeSet<&'static str> {
    BTreeSet::from([
        "token",
        "access_token",
        "api_key",
        "secret",
        "password",
        "authorization",
    ])
}

#[cfg(test)]
mod tests {
    use super::provider_process_env_from;
    use crate::credentials::CredentialDelivery;

    #[test]
    fn provider_process_env_preserves_host_paths_without_leaking_ambient_secrets() {
        let env = provider_process_env_from(&CredentialDelivery::none(), |key| match key {
            "PATH" => Some("/opt/runx/bin:/usr/bin".to_owned()),
            "HOME" => Some("/private/operator-home".to_owned()),
            "TMPDIR" => Some("/private/operator-tmp".to_owned()),
            "AWS_SECRET_ACCESS_KEY" => Some("must-not-cross-boundary".to_owned()),
            _ => None,
        });

        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/opt/runx/bin:/usr/bin")
        );
        assert_eq!(
            env.get("HOME").map(String::as_str),
            Some("/private/operator-home")
        );
        assert_eq!(
            env.get("TMPDIR").map(String::as_str),
            Some("/private/operator-tmp")
        );
        assert!(!env.contains_key("AWS_SECRET_ACCESS_KEY"));
    }
}

// rust-style-allow: large-file - the thread-outbox provider supervisor keeps transport, manifest
// validation, secret rejection, and redaction in one module so the provider boundary is reviewed
// as a single trust surface.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use runx_contracts::{
    JsonValue, ThreadOutboxProviderFetch, ThreadOutboxProviderManifest,
    ThreadOutboxProviderObservation, ThreadOutboxProviderObservationStatus,
    ThreadOutboxProviderOperation, ThreadOutboxProviderPush, ThreadOutboxProviderTransportKind,
};
use thiserror::Error;

use crate::credentials::CredentialDelivery;
use crate::process::{ProcessSignal, configure_process_group, signal_process_group_id};
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
        let started = Instant::now();
        let command = process_command(manifest)?;
        let mut child = Command::new(command);
        if let Some(args) = manifest.transport.args.as_ref() {
            child.args(args);
        }
        if let Some(cwd) = self.options.cwd.as_ref() {
            child.current_dir(cwd);
        }
        child
            .env_clear()
            .envs(credential_delivery.secret_env().iter())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut child);
        let mut child = child
            .spawn()
            .map_err(|source| io_error("spawning thread outbox provider process", source))?;
        write_request(&mut child, &request)?;
        let timeout = Duration::from_millis(self.options.timeout_ms);
        let output = wait_for_output(child, timeout)?;
        let redacted_stderr = credential_delivery
            .redact_bytes_to_string(output.stderr, self.options.output_limit_bytes);
        if !output.status.success() {
            return Err(ThreadOutboxProviderSupervisorError::ProcessFailed {
                exit_status: output.status.to_string(),
                stderr: redacted_stderr,
            });
        }
        if output.stdout.len() > self.options.output_limit_bytes {
            return Err(ThreadOutboxProviderSupervisorError::ResponseTooLarge {
                limit_bytes: self.options.output_limit_bytes,
            });
        }
        if redacted_stderr.len() > self.options.output_limit_bytes {
            return Err(ThreadOutboxProviderSupervisorError::StderrTooLarge {
                limit_bytes: self.options.output_limit_bytes,
            });
        }
        let provider_response = parse_provider_response(&output.stdout, credential_delivery)?;
        let observation = provider_response.observation;
        validate_observation(manifest, &request, &observation)?;
        Ok(ThreadOutboxProviderProcessOutcome {
            observation,
            provider_output: provider_response.output,
            redacted_stderr,
            process_exit_code: output.status.code(),
            duration_ms: duration_ms(started),
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

struct ProviderOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
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

fn write_request(
    child: &mut std::process::Child,
    request: &ThreadOutboxProviderRequest<'_>,
) -> Result<(), ThreadOutboxProviderSupervisorError> {
    let Some(mut stdin) = child.stdin.take() else {
        return Ok(());
    };
    match request {
        ThreadOutboxProviderRequest::Push(push) => serde_json::to_writer(&mut stdin, push),
        ThreadOutboxProviderRequest::Fetch(fetch) => serde_json::to_writer(&mut stdin, fetch),
    }
    .map_err(|source| json_error("serializing thread outbox provider request", source))?;
    use std::io::Write as _;
    stdin
        .write_all(b"\n")
        .map_err(|source| io_error("writing thread outbox provider request", source))?;
    Ok(())
}

fn wait_for_output(
    mut child: std::process::Child,
    timeout: Duration,
) -> Result<ProviderOutput, ThreadOutboxProviderSupervisorError> {
    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|source| io_error("polling thread outbox provider process", source))?
            .is_some()
        {
            let output = child
                .wait_with_output()
                .map_err(|source| io_error("collecting thread outbox provider output", source))?;
            return Ok(ProviderOutput {
                status: output.status,
                stdout: output.stdout,
                stderr: output.stderr,
            });
        }
        if started.elapsed() >= timeout {
            let _kill_result = kill_process_group(&mut child);
            return Err(ThreadOutboxProviderSupervisorError::TimedOut {
                timeout_ms: timeout.as_millis() as u64,
            });
        }
        std::thread::sleep(Duration::from_millis(10));
    }
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

#[cfg(unix)]
fn kill_process_group(
    child: &mut std::process::Child,
) -> Result<(), ThreadOutboxProviderSupervisorError> {
    if signal_process_group_id(child.id(), ProcessSignal::Force) {
        return Ok(());
    }
    child
        .kill()
        .map_err(|source| io_error("killing timed out thread outbox provider process", source))
}

#[cfg(not(unix))]
fn kill_process_group(
    child: &mut std::process::Child,
) -> Result<(), ThreadOutboxProviderSupervisorError> {
    child
        .kill()
        .map_err(|source| io_error("killing timed out thread outbox provider process", source))
}

fn duration_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
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

fn io_error(
    context: impl Into<String>,
    source: std::io::Error,
) -> ThreadOutboxProviderSupervisorError {
    ThreadOutboxProviderSupervisorError::Io {
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

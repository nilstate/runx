// Module rationale: the thread-outbox provider supervisor keeps transport, manifest
// validation, secret rejection, and redaction in one module so the provider boundary is reviewed
// as a single trust surface.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use runx_contracts::{
    ExecutionBoundaryKind, JsonObject, JsonValue, ThreadOutboxProviderFetch,
    ThreadOutboxProviderManifest, ThreadOutboxProviderObservation,
    ThreadOutboxProviderObservationStatus, ThreadOutboxProviderOperation, ThreadOutboxProviderPush,
    ThreadOutboxProviderTransportKind,
};
use thiserror::Error;

use crate::bytes::trim_ascii_whitespace;
use crate::credentials::CredentialDelivery;
use crate::process::{
    ProcessOutcome, ProcessSpec, ProcessStdin, STANDARD_PROCESS_OUTPUT_BYTES, run_process,
};
use crate::receipts::paths::RUNX_CWD_ENV;

const DEFAULT_OUTBOX_PROVIDER_TIMEOUT_MS: u64 = 5_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadOutboxProviderSupervisorOptions {
    pub timeout_ms: u64,
    pub output_limit_bytes: usize,
    pub cwd: Option<PathBuf>,
    /// Exact non-secret process environment admitted by the owning runtime.
    /// Credential material is added separately through `CredentialDelivery`.
    pub environment: BTreeMap<String, String>,
}

impl Default for ThreadOutboxProviderSupervisorOptions {
    fn default() -> Self {
        Self {
            timeout_ms: DEFAULT_OUTBOX_PROVIDER_TIMEOUT_MS,
            output_limit_bytes: STANDARD_PROCESS_OUTPUT_BYTES,
            cwd: None,
            environment: BTreeMap::new(),
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
    pub execution_boundary: Option<JsonObject>,
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
        let (output, execution_boundary) =
            self.run_provider_process(manifest, &request, credential_delivery)?;
        self.interpret_provider_process_output(
            manifest,
            &request,
            credential_delivery,
            output,
            execution_boundary,
        )
    }

    fn run_provider_process(
        &self,
        manifest: &ThreadOutboxProviderManifest,
        request: &ThreadOutboxProviderRequest<'_>,
        credential_delivery: &CredentialDelivery,
    ) -> Result<(ProcessOutcome, JsonObject), ThreadOutboxProviderSupervisorError> {
        let cwd = provider_process_cwd(&self.options)?;
        let command = process_command(manifest, &self.options.environment)?;
        let mut process = crate::process_invocation::prepare_exact_process_invocation(
            command.to_string_lossy().into_owned(),
            manifest.transport.args.clone().unwrap_or_default(),
            cwd,
            self.options.environment.clone(),
            Vec::new(),
            ExecutionBoundaryKind::TrustedHostProcess,
        )
        .map_err(|source| ThreadOutboxProviderSupervisorError::Process {
            context: "preparing thread outbox provider process".to_owned(),
            detail: source.to_string(),
        })?
        .into_execution_plan();
        credential_delivery
            .ensure_environment_disjoint(&process.env)
            .map_err(|source| ThreadOutboxProviderSupervisorError::Process {
                context: "preparing thread outbox provider credential delivery".to_owned(),
                detail: source.to_string(),
            })?;
        for (name, value) in credential_delivery.secret_env().iter() {
            process.env.insert(name.to_owned(), value.to_owned());
        }
        let execution_boundary = process.metadata.clone();
        let output = run_process(
            ProcessSpec::new(
                "thread-outbox-provider",
                process.command,
                self.options.output_limit_bytes,
            )
            .args(process.args)
            .env(process.env)
            .stdin(Some(ProcessStdin::new(
                request_bytes(request)?,
                "writing thread outbox provider request",
            )))
            .timeout(Some(Duration::from_millis(self.options.timeout_ms)))
            .cwd(process.cwd),
        )
        .map_err(|source| ThreadOutboxProviderSupervisorError::Process {
            context: "running thread outbox provider process".to_owned(),
            detail: source.to_string(),
        })?;
        Ok((output, execution_boundary))
    }

    fn interpret_provider_process_output(
        &self,
        manifest: &ThreadOutboxProviderManifest,
        request: &ThreadOutboxProviderRequest<'_>,
        credential_delivery: &CredentialDelivery,
        output: ProcessOutcome,
        execution_boundary: JsonObject,
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
            execution_boundary: Some(execution_boundary),
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
    #[error("thread outbox provider process requires an explicit cwd or absolute RUNX_CWD")]
    MissingWorkingDirectory,
    #[error("thread outbox provider process working directory must be absolute, got '{path}'")]
    RelativeWorkingDirectory { path: String },
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
    let _command = declared_process_command(manifest)?;
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
    environment: &BTreeMap<String, String>,
) -> Result<PathBuf, ThreadOutboxProviderSupervisorError> {
    Ok(resolve_process_command(
        declared_process_command(manifest)?,
        environment,
    ))
}

fn declared_process_command(
    manifest: &ThreadOutboxProviderManifest,
) -> Result<&str, ThreadOutboxProviderSupervisorError> {
    let Some(command) = manifest.transport.command.as_deref() else {
        return Err(ThreadOutboxProviderSupervisorError::MissingProcessCommand);
    };
    let command = command.trim();
    if command.is_empty() {
        return Err(ThreadOutboxProviderSupervisorError::EmptyProcessCommand);
    }
    Ok(command)
}

fn resolve_process_command(command: &str, environment: &BTreeMap<String, String>) -> PathBuf {
    let path = Path::new(command);
    if path.is_absolute() || path.components().count() > 1 {
        return path.to_path_buf();
    }

    if let Some(paths) = environment.get("PATH") {
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
                if let Some(exts) = environment.get("PATHEXT") {
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
    credential_delivery.redact_json_value(&mut value);
    let (observation_value, output) = provider_response_parts(value)?;
    let redacted = serde_json::to_vec(&observation_value).map_err(|source| {
        json_error(
            "serializing redacted thread outbox provider observation",
            source,
        )
    })?;
    let mut observation: ThreadOutboxProviderObservation = serde_json::from_slice(&redacted)
        .map_err(|source| json_error("validating thread outbox provider observation", source))?;
    if observation.delivery_observations.is_none()
        && let Some(delivery_observation) = credential_delivery.public_observation()
    {
        observation.delivery_observations = Some(vec![delivery_observation.clone()]);
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

fn provider_process_cwd(
    options: &ThreadOutboxProviderSupervisorOptions,
) -> Result<PathBuf, ThreadOutboxProviderSupervisorError> {
    let cwd = options
        .cwd
        .clone()
        .or_else(|| options.environment.get(RUNX_CWD_ENV).map(PathBuf::from))
        .ok_or(ThreadOutboxProviderSupervisorError::MissingWorkingDirectory)?;
    if !cwd.is_absolute() {
        return Err(
            ThreadOutboxProviderSupervisorError::RelativeWorkingDirectory {
                path: cwd.to_string_lossy().into_owned(),
            },
        );
    }
    Ok(cwd)
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;

    use super::resolve_process_command;

    #[test]
    fn provider_process_env_preserves_host_paths_without_leaking_ambient_secrets() {
        let ambient = BTreeMap::from([
            ("PATH".to_owned(), "/opt/runx/bin:/usr/bin".to_owned()),
            ("HOME".to_owned(), "/private/operator-home".to_owned()),
            ("TMPDIR".to_owned(), "/private/operator-tmp".to_owned()),
            (
                "AWS_SECRET_ACCESS_KEY".to_owned(),
                "must-not-cross-boundary".to_owned(),
            ),
        ]);
        let env = crate::execution_environment::process_baseline_environment(&ambient);

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

    #[test]
    fn provider_command_resolution_uses_only_the_admitted_path()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let executable = root.path().join("provider-adapter");
        fs::write(&executable, "fixture")?;
        let environment = BTreeMap::from([(
            "PATH".to_owned(),
            root.path().to_string_lossy().into_owned(),
        )]);

        assert_eq!(
            resolve_process_command("provider-adapter", &environment),
            executable
        );
        assert_eq!(
            resolve_process_command("provider-adapter", &BTreeMap::new()),
            std::path::PathBuf::from("provider-adapter")
        );
        Ok(())
    }
}

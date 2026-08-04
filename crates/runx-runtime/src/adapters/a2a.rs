// Module rationale: the A2A parity slice keeps the transport
// contract, fixture transport, argument mapping, and receipt metadata in one
// reviewable adapter surface until the live transport split lands.
use std::collections::BTreeMap;
use std::thread;
use std::time::{Duration, Instant};

use runx_contracts::{JsonObject, JsonValue, sha256_hex};

use crate::RuntimeError;
use crate::adapter::{InvocationOutput, InvocationStatus, SkillAdapter, SkillInvocation};
use crate::adapter_pipeline::AdapterProjection;

const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MIN_TIMEOUT: Duration = Duration::from_millis(50);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum A2aTaskStatus {
    Submitted,
    Working,
    Completed,
    Failed,
    Canceled,
}

impl A2aTaskStatus {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Submitted => "submitted",
            Self::Working => "working",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }

    const fn terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Canceled)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct A2aTask {
    pub id: String,
    pub status: A2aTaskStatus,
    pub output: Option<JsonValue>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct A2aSendMessageRequest {
    pub agent_card_url: String,
    pub agent_identity: Option<String>,
    pub task: String,
    pub message: JsonObject,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct A2aGetTaskRequest {
    pub agent_card_url: String,
    pub task_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct A2aTransportError {
    message: String,
    timeout: bool,
}

impl A2aTransportError {
    #[must_use]
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            timeout: false,
        }
    }

    #[must_use]
    pub fn timeout(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            timeout: true,
        }
    }

    #[must_use]
    pub fn sanitized_message(&self) -> String {
        if self.timeout {
            self.message.clone()
        } else {
            "A2A adapter failed.".to_owned()
        }
    }

    #[must_use]
    pub fn sanitized_cancel_message(&self) -> String {
        if self.timeout {
            self.message.clone()
        } else {
            "A2A task cancellation failed.".to_owned()
        }
    }
}

pub trait A2aTransport {
    fn send_message(&self, request: A2aSendMessageRequest) -> Result<A2aTask, A2aTransportError>;
    fn get_task(&self, request: A2aGetTaskRequest) -> Result<A2aTask, A2aTransportError>;

    fn cancel_task(&self, _request: A2aGetTaskRequest) -> Result<A2aTask, A2aTransportError> {
        Err(A2aTransportError::failed(
            "A2A transport does not support cancellation.",
        ))
    }

    fn supports_cancel(&self) -> bool {
        false
    }
}

#[derive(Clone, Debug)]
pub struct A2aAdapter<T> {
    transport: T,
}

impl<T> A2aAdapter<T> {
    #[must_use]
    pub const fn new(transport: T) -> Self {
        Self { transport }
    }
}

impl<T> SkillAdapter for A2aAdapter<T>
where
    T: A2aTransport,
{
    fn adapter_type(&self) -> &'static str {
        "a2a"
    }

    // Function rationale: the send, poll, timeout-cancel,
    // and receipt-metadata path is the governed A2A adapter boundary.
    fn invoke(&self, request: SkillInvocation) -> Result<InvocationOutput, RuntimeError> {
        let started = Instant::now();
        crate::execution_environment::resolve_declared_environment(
            &request.requirements,
            &request.env,
        )?;
        let source = request.source;
        if source.source_type != runx_parser::SourceKind::A2a {
            return Err(RuntimeError::UnsupportedAdapter {
                adapter_type: source.source_type.as_str().to_owned(),
            });
        }
        let Some(agent_card_url) = source
            .agent_card_url
            .clone()
            .filter(|value| !value.is_empty())
        else {
            return Ok(failure(
                "A2A source requires agent_card_url and task metadata.",
                started,
                JsonObject::new(),
            ));
        };
        let Some(task) = source.task.clone().filter(|value| !value.is_empty()) else {
            return Ok(failure(
                "A2A source requires agent_card_url and task metadata.",
                started,
                JsonObject::new(),
            ));
        };

        let timeout = timeout_from_source(source.timeout_seconds);
        let message = map_arguments(
            source.arguments.as_ref(),
            &request.inputs,
            &request.resolved_inputs,
        )?;
        let submitted = match self.transport.send_message(A2aSendMessageRequest {
            agent_card_url: agent_card_url.clone(),
            agent_identity: source.agent_identity.clone(),
            task: task.clone(),
            message: message.clone(),
        }) {
            Ok(task) => task,
            Err(error) => {
                return Ok(failure(
                    error.sanitized_message(),
                    started,
                    metadata_for(&source, None, Some(&message), None)?,
                ));
            }
        };
        let task_id = submitted.id.clone();

        let completed = if submitted.status.terminal() {
            submitted
        } else {
            match poll_task(&self.transport, &agent_card_url, &task_id, timeout) {
                Ok(task) => task,
                Err(error) => {
                    let cancel_error =
                        cancel_if_supported(&self.transport, &agent_card_url, Some(&task_id));
                    let failed_task = A2aTask {
                        id: task_id,
                        status: A2aTaskStatus::Failed,
                        output: None,
                        error: None,
                    };
                    return Ok(failure(
                        error.sanitized_message(),
                        started,
                        metadata_for(
                            &source,
                            Some(&failed_task),
                            Some(&message),
                            cancel_error.as_deref(),
                        )?,
                    ));
                }
            }
        };

        if completed.status != A2aTaskStatus::Completed {
            return Ok(failure(
                format!("A2A task {}.", completed.status.as_str()),
                started,
                metadata_for(&source, Some(&completed), Some(&message), None)?,
            ));
        }

        let metadata = metadata_for(&source, Some(&completed), Some(&message), None)?;
        let value = completed.output.unwrap_or(JsonValue::Null);
        Ok(AdapterProjection::from_started(started).runtime_output(
            InvocationStatus::Success,
            value,
            None,
            metadata,
        ))
    }
}

#[derive(Debug, Default)]
pub struct FixtureA2aTransport {
    tasks: std::sync::Mutex<BTreeMap<String, A2aTask>>,
}

impl FixtureA2aTransport {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl A2aTransport for FixtureA2aTransport {
    fn send_message(&self, request: A2aSendMessageRequest) -> Result<A2aTask, A2aTransportError> {
        if !request.agent_card_url.starts_with("fixture://") {
            return Err(A2aTransportError::failed(
                "A2A fixture transport only supports fixture:// agent cards.",
            ));
        }
        let request_hash = sha256_json(&request_object(&request))
            .map_err(|error| A2aTransportError::failed(error.to_string()))?;
        let task_id = format!("a2a_{}", &request_hash[..16]);
        let task = if request.task == "fail" {
            A2aTask {
                id: task_id,
                status: A2aTaskStatus::Failed,
                output: None,
                error: Some("fixture failure".to_owned()),
            }
        } else {
            A2aTask {
                id: task_id,
                status: A2aTaskStatus::Completed,
                output: request
                    .message
                    .get("message")
                    .cloned()
                    .or(Some(JsonValue::Object(request.message))),
                error: None,
            }
        };
        self.tasks
            .lock()
            .map_err(|_| A2aTransportError::failed("A2A fixture task store is poisoned."))?
            .insert(task.id.clone(), task.clone());
        Ok(task)
    }

    fn get_task(&self, request: A2aGetTaskRequest) -> Result<A2aTask, A2aTransportError> {
        self.tasks
            .lock()
            .map_err(|_| A2aTransportError::failed("A2A fixture task store is poisoned."))?
            .get(&request.task_id)
            .cloned()
            .ok_or_else(|| A2aTransportError::failed("A2A fixture task not found."))
    }

    fn cancel_task(&self, request: A2aGetTaskRequest) -> Result<A2aTask, A2aTransportError> {
        let task = A2aTask {
            id: request.task_id,
            status: A2aTaskStatus::Canceled,
            output: None,
            error: None,
        };
        self.tasks
            .lock()
            .map_err(|_| A2aTransportError::failed("A2A fixture task store is poisoned."))?
            .insert(task.id.clone(), task.clone());
        Ok(task)
    }

    fn supports_cancel(&self) -> bool {
        true
    }
}

fn poll_task<T: A2aTransport>(
    transport: &T,
    agent_card_url: &str,
    task_id: &str,
    timeout: Duration,
) -> Result<A2aTask, A2aTransportError> {
    let started = Instant::now();
    loop {
        if started.elapsed() >= timeout {
            return Err(A2aTransportError::timeout(format!(
                "A2A task timed out after {}ms.",
                timeout.as_millis()
            )));
        }
        let task = transport.get_task(A2aGetTaskRequest {
            agent_card_url: agent_card_url.to_owned(),
            task_id: task_id.to_owned(),
        })?;
        if task.status.terminal() {
            return Ok(task);
        }
        thread::sleep(DEFAULT_POLL_INTERVAL.min(timeout.saturating_sub(started.elapsed())));
    }
}

fn cancel_if_supported<T: A2aTransport>(
    transport: &T,
    agent_card_url: &str,
    task_id: Option<&str>,
) -> Option<String> {
    if !transport.supports_cancel() {
        return None;
    }
    let task_id = task_id?;
    transport
        .cancel_task(A2aGetTaskRequest {
            agent_card_url: agent_card_url.to_owned(),
            task_id: task_id.to_owned(),
        })
        .err()
        .map(|error| error.sanitized_cancel_message())
}

fn timeout_from_source(timeout_seconds: Option<u64>) -> Duration {
    timeout_seconds
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_TIMEOUT)
        .max(MIN_TIMEOUT)
}

fn map_arguments(
    argument_template: Option<&JsonObject>,
    inputs: &JsonObject,
    resolved_inputs: &JsonObject,
) -> Result<JsonObject, RuntimeError> {
    let Some(template) = argument_template else {
        let mut merged = inputs.clone();
        merged.extend(resolved_inputs.clone());
        return Ok(merged);
    };
    template
        .iter()
        .map(|(key, value)| {
            let mapped = match value {
                JsonValue::String(template) => {
                    map_template_string(template, inputs, resolved_inputs)?
                }
                other => other.clone(),
            };
            Ok((key.clone(), mapped))
        })
        .collect()
}

// Exact and embedded templates share one delimiter-aware mapping path.
fn map_template_string(
    template: &str,
    inputs: &JsonObject,
    resolved_inputs: &JsonObject,
) -> Result<JsonValue, RuntimeError> {
    if let Some(key) = exact_template_key(template) {
        return Ok(resolved_inputs
            .get(key)
            .or_else(|| inputs.get(key))
            .cloned()
            .unwrap_or(JsonValue::Null));
    }

    let mut rendered = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let (prefix, after_start) = rest.split_at(start);
        rendered.push_str(prefix);
        let after_start = &after_start[2..];
        let Some(end) = after_start.find("}}") else {
            rendered.push_str("{{");
            rendered.push_str(after_start);
            return Ok(JsonValue::String(rendered));
        };
        let key = after_start[..end].trim();
        rendered.push_str(&stringify_input(
            resolved_inputs.get(key).or_else(|| inputs.get(key)),
        )?);
        rest = &after_start[end + 2..];
    }
    rendered.push_str(rest);
    Ok(JsonValue::String(rendered))
}

fn exact_template_key(template: &str) -> Option<&str> {
    let trimmed = template.trim();
    let inner = trimmed.strip_prefix("{{")?.strip_suffix("}}")?.trim();
    if inner.is_empty() || inner.contains(char::is_whitespace) {
        return None;
    }
    Some(inner)
}

fn stringify_input(value: Option<&JsonValue>) -> Result<String, RuntimeError> {
    match value {
        None | Some(JsonValue::Null) => Ok(String::new()),
        Some(JsonValue::String(value)) => Ok(value.clone()),
        Some(value) => serde_json::to_string(value)
            .map_err(|source| RuntimeError::json("serializing A2A template input", source)),
    }
}

// Function rationale: A2A metadata construction keeps
// every hash committed field adjacent to the exact source it summarizes.
fn metadata_for(
    source: &runx_parser::SkillSource,
    task: Option<&A2aTask>,
    message: Option<&JsonObject>,
    cancel_error: Option<&str>,
) -> Result<JsonObject, RuntimeError> {
    let mut a2a = JsonObject::new();
    a2a.insert(
        "agent_card_url_hash".to_owned(),
        JsonValue::String(sha256_hex(
            source.agent_card_url.as_deref().unwrap_or("").as_bytes(),
        )),
    );
    if let Some(agent_identity) = &source.agent_identity {
        a2a.insert(
            "agent_identity".to_owned(),
            JsonValue::String(agent_identity.clone()),
        );
    }
    if let Some(task_name) = &source.task {
        a2a.insert("task".to_owned(), JsonValue::String(task_name.clone()));
    }
    if let Some(task) = task {
        a2a.insert("task_id".to_owned(), JsonValue::String(task.id.clone()));
        a2a.insert(
            "task_status".to_owned(),
            JsonValue::String(task.status.as_str().to_owned()),
        );
        if let Some(output) = &task.output {
            a2a.insert(
                "output_hash".to_owned(),
                JsonValue::String(sha256_json(output)?),
            );
        }
    }
    if let Some(message) = message {
        a2a.insert(
            "message_hash".to_owned(),
            JsonValue::String(sha256_json(&JsonValue::Object(message.clone()))?),
        );
    }
    if let Some(cancel_error) = cancel_error {
        a2a.insert(
            "cancel_error".to_owned(),
            JsonValue::String(cancel_error.to_owned()),
        );
    }
    let mut metadata = JsonObject::new();
    metadata.insert("a2a".to_owned(), JsonValue::Object(a2a));
    metadata.extend(crate::process_invocation::boundary_metadata(
        runx_contracts::ExecutionBoundaryKind::RemoteProvider,
    )?);
    Ok(metadata)
}

fn request_object(request: &A2aSendMessageRequest) -> JsonValue {
    let mut object = JsonObject::new();
    object.insert(
        "agentCardUrl".to_owned(),
        JsonValue::String(request.agent_card_url.clone()),
    );
    if let Some(agent_identity) = &request.agent_identity {
        object.insert(
            "agentIdentity".to_owned(),
            JsonValue::String(agent_identity.clone()),
        );
    }
    object.insert("task".to_owned(), JsonValue::String(request.task.clone()));
    object.insert(
        "message".to_owned(),
        JsonValue::Object(request.message.clone()),
    );
    JsonValue::Object(object)
}

fn sha256_json(value: &JsonValue) -> Result<String, RuntimeError> {
    let json = serde_json::to_string(value)
        .map_err(|source| RuntimeError::json("serializing A2A hash payload", source))?;
    Ok(sha256_hex(json.as_bytes()))
}

fn failure(message: impl Into<String>, started: Instant, metadata: JsonObject) -> InvocationOutput {
    AdapterProjection::from_started(started).failure(message.into(), metadata)
}

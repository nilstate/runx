// Module rationale: the managed-agent parity slice keeps
// agent and agent-task invocation, telemetry, and metadata together until live
// provider adapters create natural module boundaries.
use std::time::Instant;

use runx_contracts::{
    AgentActInvocation, JsonNumber, JsonObject, JsonValue, ResolutionRequest, ResolutionResponse,
    ResolutionResponseActor,
};

use crate::RuntimeError;
use crate::adapter::{InvocationOutput, InvocationStatus, SkillAdapter, SkillInvocation};
use crate::adapter_pipeline::AdapterProjection;
use crate::agent_contract::verified_agent_metadata_with_artifacts;
use crate::agent_invocation::{
    AgentActInvocationSourceType, agent_act_resolution_request, agent_profile_metadata,
    build_agent_act_invocation,
};
use crate::config::ManagedAgentConfig;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentAdapterSourceType {
    Agent,
    AgentStep,
}

impl AgentAdapterSourceType {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::AgentStep => "agent-task",
        }
    }

    const fn invocation_source_type(self) -> AgentActInvocationSourceType {
        match self {
            Self::Agent => AgentActInvocationSourceType::Agent,
            Self::AgentStep => AgentActInvocationSourceType::AgentStep,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentExecutionTelemetry {
    pub rounds: Option<u64>,
    pub model_calls: Option<u64>,
    pub tool_calls: Option<u64>,
    pub tools: Option<Vec<String>>,
    pub tool_executions: Option<Vec<AgentToolExecutionTrace>>,
}

impl AgentExecutionTelemetry {
    #[must_use]
    pub fn public_projection(&self) -> JsonObject {
        let mut projection = JsonObject::new();
        if let Some(rounds) = self.rounds {
            projection.insert(
                "rounds".to_owned(),
                JsonValue::Number(JsonNumber::U64(rounds)),
            );
        }
        if let Some(model_calls) = self.model_calls {
            projection.insert(
                "model_calls".to_owned(),
                JsonValue::Number(JsonNumber::U64(model_calls)),
            );
        }
        if let Some(tool_calls) = self.tool_calls {
            projection.insert(
                "tool_calls".to_owned(),
                JsonValue::Number(JsonNumber::U64(tool_calls)),
            );
        }
        if let Some(tools) = &self.tools {
            projection.insert(
                "tools".to_owned(),
                JsonValue::Array(tools.iter().cloned().map(JsonValue::String).collect()),
            );
        }
        if let Some(tool_executions) = &self.tool_executions {
            projection.insert(
                "tool_executions".to_owned(),
                JsonValue::Array(
                    tool_executions
                        .iter()
                        .map(tool_execution_trace)
                        .collect::<Vec<_>>(),
                ),
            );
        }
        projection
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentToolExecutionTrace {
    pub tool: String,
    pub status: String,
    pub receipt_id: Option<String>,
    pub resolution_kind: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentResolution {
    pub response: ResolutionResponse,
    pub telemetry: Option<AgentExecutionTelemetry>,
    /// The last successful governed tool result of this turn (the real effect,
    /// e.g. the `/v1` response carrying the venue id). Captured from the tool
    /// output, never the model's restatement, so a domain receipt can record an
    /// effect ref that can be reconciled against the venue's own record.
    pub governed_effect: Option<JsonValue>,
}

impl AgentResolution {
    #[must_use]
    pub fn agent(payload: JsonValue, telemetry: Option<AgentExecutionTelemetry>) -> Self {
        Self::agent_with_effect(payload, telemetry, None)
    }

    #[must_use]
    pub fn agent_with_effect(
        payload: JsonValue,
        telemetry: Option<AgentExecutionTelemetry>,
        governed_effect: Option<JsonValue>,
    ) -> Self {
        Self {
            response: ResolutionResponse {
                actor: ResolutionResponseActor::Agent,
                payload,
            },
            telemetry,
            governed_effect,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentResolverError {
    reason_code: String,
    sanitized_message: String,
    telemetry: Option<Box<AgentExecutionTelemetry>>,
}

impl AgentResolverError {
    #[must_use]
    pub fn provider_error(_message: impl Into<String>) -> Self {
        Self {
            reason_code: "provider_failed".to_owned(),
            sanitized_message: "Managed agent provider request failed.".to_owned(),
            telemetry: None,
        }
    }

    #[must_use]
    pub fn sanitized(message: impl Into<String>) -> Self {
        Self {
            reason_code: "resolution_failed".to_owned(),
            sanitized_message: message.into(),
            telemetry: None,
        }
    }

    #[must_use]
    pub fn bounded_failure(
        reason_code: impl Into<String>,
        sanitized_message: impl Into<String>,
        telemetry: AgentExecutionTelemetry,
    ) -> Self {
        Self {
            reason_code: reason_code.into(),
            sanitized_message: sanitized_message.into(),
            telemetry: Some(Box::new(telemetry)),
        }
    }

    #[must_use]
    pub fn reason_code(&self) -> &str {
        &self.reason_code
    }

    #[must_use]
    pub fn sanitized_message(&self) -> &str {
        &self.sanitized_message
    }

    #[must_use]
    pub fn telemetry(&self) -> Option<&AgentExecutionTelemetry> {
        self.telemetry.as_deref()
    }

    #[must_use]
    pub(crate) fn public_failure_projection(&self) -> JsonObject {
        let mut projection = JsonObject::from([
            (
                "schema".to_owned(),
                JsonValue::String("runx.managed_agent_failure.v1".to_owned()),
            ),
            ("status".to_owned(), JsonValue::String("failed".to_owned())),
            (
                "reason_code".to_owned(),
                JsonValue::String(self.reason_code.clone()),
            ),
            (
                "message".to_owned(),
                JsonValue::String(self.sanitized_message.clone()),
            ),
        ]);
        if let Some(telemetry) = self.telemetry() {
            projection.insert(
                "telemetry".to_owned(),
                JsonValue::Object(telemetry.public_projection()),
            );
        }
        projection
    }

    #[must_use]
    pub(crate) fn receipt_metadata(&self) -> JsonObject {
        JsonObject::from([(
            "managed_agent_failure".to_owned(),
            JsonValue::Object(self.public_failure_projection()),
        )])
    }
}

impl std::fmt::Display for AgentResolverError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.sanitized_message)
    }
}

impl std::error::Error for AgentResolverError {}

pub trait AgentResolver {
    fn resolve(&self, request: ResolutionRequest) -> Result<AgentResolution, AgentResolverError>;
}

#[derive(Clone, Debug)]
pub struct AgentAdapter<T> {
    source_type: AgentAdapterSourceType,
    config: ManagedAgentConfig,
    resolver: T,
}

impl<T> AgentAdapter<T> {
    #[must_use]
    pub fn new(
        source_type: AgentAdapterSourceType,
        config: ManagedAgentConfig,
        resolver: T,
    ) -> Self {
        Self {
            source_type,
            config,
            resolver,
        }
    }

    #[must_use]
    pub fn agent(config: ManagedAgentConfig, resolver: T) -> Self {
        Self::new(AgentAdapterSourceType::Agent, config, resolver)
    }

    #[must_use]
    pub fn agent_task(config: ManagedAgentConfig, resolver: T) -> Self {
        Self::new(AgentAdapterSourceType::AgentStep, config, resolver)
    }
}

impl<T> SkillAdapter for AgentAdapter<T>
where
    T: AgentResolver,
{
    fn adapter_type(&self) -> &'static str {
        self.source_type.as_str()
    }

    fn invoke(&self, request: SkillInvocation) -> Result<InvocationOutput, RuntimeError> {
        let started = Instant::now();
        if request.source.source_type.as_str() != self.source_type.as_str() {
            return Err(RuntimeError::UnsupportedAdapter {
                adapter_type: request.source.source_type.as_str().to_owned(),
            });
        }

        let resolution_request =
            agent_act_resolution_request(&request, self.source_type.invocation_source_type())?;
        let profile_metadata = agent_profile_metadata(&resolution_request);
        match self.resolver.resolve(resolution_request.clone()) {
            Ok(resolution) => self.finish_resolution(
                &request,
                &resolution_request,
                resolution,
                started,
                &profile_metadata,
            ),
            Err(error) => Ok(failure_output(
                error.sanitized_message(),
                started,
                native_agent_metadata(
                    self.source_type,
                    &request,
                    &self.config,
                    "failure",
                    error.telemetry(),
                    Some(error.reason_code()),
                    &profile_metadata,
                ),
            )),
        }
    }
}

impl<T> AgentAdapter<T> {
    fn finish_resolution(
        &self,
        request: &SkillInvocation,
        resolution_request: &ResolutionRequest,
        resolution: AgentResolution,
        started: Instant,
        profile_metadata: &JsonObject,
    ) -> Result<InvocationOutput, RuntimeError> {
        let verified_metadata = verified_agent_metadata_with_artifacts(
            resolution_request,
            &resolution.response.payload,
            request.artifacts.as_ref(),
            &request.skill_directory,
            &request.env,
        );
        let Ok(verified_metadata) = verified_metadata else {
            return Ok(failure_output(
                "Managed agent output failed its declared contract.",
                started,
                native_agent_metadata(
                    self.source_type,
                    request,
                    &self.config,
                    "failure",
                    resolution.telemetry.as_ref(),
                    Some("output_contract_failed"),
                    profile_metadata,
                ),
            ));
        };
        let metadata = native_agent_metadata(
            self.source_type,
            request,
            &self.config,
            "success",
            resolution.telemetry.as_ref(),
            None,
            &verified_metadata,
        );
        success_output(resolution, started, metadata)
    }
}

pub fn build_managed_agent_act_invocation(
    request: &SkillInvocation,
    source_type: AgentAdapterSourceType,
) -> Result<AgentActInvocation, RuntimeError> {
    build_agent_act_invocation(request, source_type.invocation_source_type())
}

fn skill_name(request: &SkillInvocation, source_type: AgentAdapterSourceType) -> String {
    if request.skill_name.is_empty() {
        return match source_type {
            AgentAdapterSourceType::Agent => "skill".to_owned(),
            AgentAdapterSourceType::AgentStep => "agent-task".to_owned(),
        };
    }
    request.skill_name.clone()
}

fn success_output(
    resolution: AgentResolution,
    started: Instant,
    metadata: JsonObject,
) -> Result<InvocationOutput, RuntimeError> {
    Ok(AdapterProjection::from_started(started).runtime_output(
        InvocationStatus::Success,
        resolution.response.payload,
        None,
        metadata,
    ))
}

fn failure_output(message: &str, started: Instant, metadata: JsonObject) -> InvocationOutput {
    AdapterProjection::from_started(started).failure(message.to_owned(), metadata)
}

fn native_agent_metadata(
    source_type: AgentAdapterSourceType,
    request: &SkillInvocation,
    config: &ManagedAgentConfig,
    status: &str,
    telemetry: Option<&AgentExecutionTelemetry>,
    reason_code: Option<&str>,
    profile_metadata: &JsonObject,
) -> JsonObject {
    let mut root = JsonObject::new();
    let mut entry = JsonObject::new();
    match source_type {
        AgentAdapterSourceType::AgentStep => {
            entry.insert(
                "source_type".to_owned(),
                JsonValue::String("agent-task".to_owned()),
            );
            if let Some(agent) = &request.source.agent {
                entry.insert("agent".to_owned(), JsonValue::String(agent.clone()));
            }
            if let Some(task) = &request.source.task {
                entry.insert("task".to_owned(), JsonValue::String(task.clone()));
            }
            insert_common_metadata(&mut entry, config, status);
            insert_reason_code(&mut entry, reason_code);
            insert_telemetry(&mut entry, telemetry);
            root.insert("agent_hook".to_owned(), JsonValue::Object(entry));
        }
        AgentAdapterSourceType::Agent => {
            entry.insert(
                "skill".to_owned(),
                JsonValue::String(skill_name(request, source_type)),
            );
            insert_common_metadata(&mut entry, config, status);
            insert_reason_code(&mut entry, reason_code);
            insert_telemetry(&mut entry, telemetry);
            root.insert("agent_runner".to_owned(), JsonValue::Object(entry));
        }
    }
    root.extend(profile_metadata.clone());
    root
}

fn insert_reason_code(entry: &mut JsonObject, reason_code: Option<&str>) {
    if let Some(reason_code) = reason_code {
        entry.insert(
            "reason_code".to_owned(),
            JsonValue::String(reason_code.to_owned()),
        );
    }
}

fn insert_common_metadata(entry: &mut JsonObject, config: &ManagedAgentConfig, status: &str) {
    entry.insert("route".to_owned(), JsonValue::String("native".to_owned()));
    entry.insert(
        "provider".to_owned(),
        JsonValue::String(config.provider.as_ref().to_owned()),
    );
    entry.insert("model".to_owned(), JsonValue::String(config.model.clone()));
    entry.insert("status".to_owned(), JsonValue::String(status.to_owned()));
}

fn insert_telemetry(entry: &mut JsonObject, telemetry: Option<&AgentExecutionTelemetry>) {
    if let Some(telemetry) = telemetry {
        entry.extend(telemetry.public_projection());
    }
}

fn tool_execution_trace(trace: &AgentToolExecutionTrace) -> JsonValue {
    let mut object = JsonObject::new();
    object.insert("tool".to_owned(), JsonValue::String(trace.tool.clone()));
    object.insert("status".to_owned(), JsonValue::String(trace.status.clone()));
    if let Some(receipt_id) = &trace.receipt_id {
        object.insert(
            "receiptId".to_owned(),
            JsonValue::String(receipt_id.clone()),
        );
    }
    if let Some(resolution_kind) = &trace.resolution_kind {
        object.insert(
            "resolutionKind".to_owned(),
            JsonValue::String(resolution_kind.clone()),
        );
    }
    JsonValue::Object(object)
}

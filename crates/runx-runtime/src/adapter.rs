use std::collections::BTreeMap;
use std::path::PathBuf;

use runx_contracts::CredentialDeliveryObservation;
use runx_contracts::{ContextEntry, ExecutionRequirements, JsonObject, JsonValue, ProvenanceEntry};
use runx_parser::{SkillArtifactContract, SkillSource};
use serde::{Deserialize, Serialize};

use crate::RuntimeError;
use crate::credentials::CredentialDelivery;

/// Metadata key under which a skill's non-secret credential-delivery
/// observations are recorded on [`InvocationOutput::metadata`].
pub const CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA: &str = "credential_delivery_observations";
/// Structured, already-verified contract evidence that the receipt sealer binds
/// into signed criteria. Producers must populate this only after native
/// verification succeeds.
pub const CONTRACT_VERIFICATION_METADATA: &str = "contract_verification";
/// Runtime-enforced ceilings that shaped this invocation. The receipt sealer
/// copies only this structured, runtime-owned metadata key.
pub use runx_contracts::EXECUTION_LIMITS_METADATA;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum InvocationStatus {
    Success,
    Failure,
}

#[derive(Clone, Debug)]
pub struct SkillInvocation {
    pub skill_name: String,
    /// Graph step identity when the invocation is owned by a graph act.
    pub step_id: Option<String>,
    pub source: SkillSource,
    /// Exact non-secret manifest requirements for this executable act.
    pub requirements: ExecutionRequirements,
    /// Parser-validated artifact contract for this invocation. Adapters must not
    /// reconstruct it from `source.raw`.
    pub artifacts: Option<SkillArtifactContract>,
    /// Parser-validated tools available to an agent invocation.
    pub allowed_tools: Option<Vec<String>>,
    pub inputs: JsonObject,
    pub resolved_inputs: JsonObject,
    pub current_context: Vec<ContextEntry>,
    /// Exact graph context edges that supplied invocation inputs.
    pub provenance: Vec<ProvenanceEntry>,
    pub skill_directory: PathBuf,
    pub env: BTreeMap<String, String>,
    pub credential_delivery: CredentialDelivery,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InvocationOutput {
    pub status: InvocationStatus,
    /// The typed value produced by the invocation. Structured runtimes keep
    /// their native JSON tree; real process adapters parse JSON once or retain
    /// non-JSON stdout as a string.
    pub value: JsonValue,
    pub diagnostics: InvocationDiagnostics,
    pub metadata: JsonObject,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InvocationDiagnostics {
    Runtime {
        duration_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        failure: Option<String>,
    },
    Process {
        duration_ms: u64,
        exit_code: Option<i32>,
        stderr: String,
    },
}

impl InvocationOutput {
    #[must_use]
    pub fn runtime_success(value: JsonValue, duration_ms: u64, metadata: JsonObject) -> Self {
        Self {
            status: InvocationStatus::Success,
            value,
            diagnostics: InvocationDiagnostics::Runtime {
                duration_ms,
                failure: None,
            },
            metadata,
        }
    }

    #[must_use]
    pub fn runtime_failure(
        value: JsonValue,
        message: impl Into<String>,
        duration_ms: u64,
        metadata: JsonObject,
    ) -> Self {
        Self {
            status: InvocationStatus::Failure,
            value,
            diagnostics: InvocationDiagnostics::Runtime {
                duration_ms,
                failure: Some(message.into()),
            },
            metadata,
        }
    }

    #[must_use]
    pub fn process(
        status: InvocationStatus,
        stdout: String,
        stderr: String,
        exit_code: Option<i32>,
        duration_ms: u64,
        metadata: JsonObject,
    ) -> Self {
        let value = serde_json::from_str(&stdout).unwrap_or(JsonValue::String(stdout));
        Self::process_value(status, value, stderr, exit_code, duration_ms, metadata)
    }

    #[must_use]
    pub fn process_value(
        status: InvocationStatus,
        value: JsonValue,
        stderr: String,
        exit_code: Option<i32>,
        duration_ms: u64,
        metadata: JsonObject,
    ) -> Self {
        Self {
            status,
            value,
            diagnostics: InvocationDiagnostics::Process {
                duration_ms,
                exit_code,
                stderr,
            },
            metadata,
        }
    }

    #[must_use]
    pub fn succeeded(&self) -> bool {
        self.status == InvocationStatus::Success
    }

    #[must_use]
    pub fn duration_ms(&self) -> u64 {
        match &self.diagnostics {
            InvocationDiagnostics::Runtime { duration_ms, .. }
            | InvocationDiagnostics::Process { duration_ms, .. } => *duration_ms,
        }
    }

    pub fn set_duration_ms(&mut self, duration_ms: u64) {
        match &mut self.diagnostics {
            InvocationDiagnostics::Runtime {
                duration_ms: current,
                ..
            }
            | InvocationDiagnostics::Process {
                duration_ms: current,
                ..
            } => *current = duration_ms,
        }
    }

    #[must_use]
    pub fn exit_code(&self) -> Option<i32> {
        match &self.diagnostics {
            InvocationDiagnostics::Runtime { .. } => None,
            InvocationDiagnostics::Process { exit_code, .. } => *exit_code,
        }
    }

    #[must_use]
    pub fn process_stderr(&self) -> Option<&str> {
        match &self.diagnostics {
            InvocationDiagnostics::Runtime { .. } => None,
            InvocationDiagnostics::Process { stderr, .. } => Some(stderr),
        }
    }

    #[must_use]
    pub fn failure_message(&self) -> Option<String> {
        if self.succeeded() {
            return None;
        }
        match &self.diagnostics {
            InvocationDiagnostics::Runtime { failure, .. } => failure.clone(),
            InvocationDiagnostics::Process { stderr, .. } if !stderr.trim().is_empty() => {
                Some(stderr.clone())
            }
            InvocationDiagnostics::Process { .. } => match &self.value {
                JsonValue::String(value) if !value.trim().is_empty() => Some(value.clone()),
                JsonValue::Null => Some("process failed without diagnostic output".to_owned()),
                value => serde_json::to_string(value).ok(),
            },
        }
    }

    #[must_use]
    pub fn rendered_value(&self) -> String {
        match &self.value {
            JsonValue::String(value) => value.clone(),
            value => serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned()),
        }
    }

    pub fn reject(&mut self, message: impl Into<String>) {
        self.status = InvocationStatus::Failure;
        self.value = JsonValue::Null;
        self.diagnostics = InvocationDiagnostics::Runtime {
            duration_ms: self.duration_ms(),
            failure: Some(message.into()),
        };
    }

    /// Append one non-secret credential observation for receipt sealing. This
    /// records the runtime boundary observation as supplied; it does not imply
    /// that credential material entered the invoked subprocess.
    pub(crate) fn record_credential_observation(
        &mut self,
        observation: &CredentialDeliveryObservation,
    ) -> Result<(), RuntimeError> {
        let value: JsonValue = serde_json::to_value(observation)
            .and_then(serde_json::from_value)
            .map_err(|source| {
                RuntimeError::json("serializing credential delivery observation", source)
            })?;
        let observation_id = value
            .as_object()
            .and_then(|object| object.get("observation_id"))
            .and_then(JsonValue::as_str)
            .ok_or_else(|| RuntimeError::ReceiptInvalid {
                message: "credential delivery observation omitted observation_id".to_owned(),
            })?;
        match self
            .metadata
            .get_mut(CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA)
        {
            Some(JsonValue::Array(observations)) => {
                if let Some(existing) = observations.iter().find(|existing| {
                    existing
                        .as_object()
                        .and_then(|object| object.get("observation_id"))
                        .and_then(JsonValue::as_str)
                        == Some(observation_id)
                }) {
                    if existing == &value {
                        return Ok(());
                    }
                    return Err(RuntimeError::ReceiptInvalid {
                        message: format!(
                            "credential delivery observation {observation_id:?} was recorded with conflicting evidence"
                        ),
                    });
                }
                observations.push(value);
            }
            Some(_) => {
                return Err(RuntimeError::ReceiptInvalid {
                    message: format!(
                        "{CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA} metadata must be an array"
                    ),
                });
            }
            None => {
                self.metadata.insert(
                    CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA.to_owned(),
                    JsonValue::Array(vec![value]),
                );
            }
        }
        Ok(())
    }
}

pub trait SkillAdapter {
    fn adapter_type(&self) -> &'static str;
    fn invoke(&self, request: SkillInvocation) -> Result<InvocationOutput, RuntimeError>;

    /// Materialize an isolated executor for one parallel fanout branch.
    ///
    /// Returning `None` is the complete serial-only answer. This single factory
    /// replaces separate "parallel safe" and "cloneable" claims that could
    /// disagree during planning and dispatch.
    fn isolated_fanout_adapter(
        &self,
        source: &SkillSource,
    ) -> Option<Box<dyn SkillAdapter + Send + Sync>> {
        let _ = source;
        None
    }
}

pub(crate) struct BorrowedSkillAdapter<'a, A>
where
    A: SkillAdapter + ?Sized,
{
    adapter: &'a A,
}

impl<'a, A> BorrowedSkillAdapter<'a, A>
where
    A: SkillAdapter + ?Sized,
{
    pub(crate) fn new(adapter: &'a A) -> Self {
        Self { adapter }
    }
}

impl<A> SkillAdapter for BorrowedSkillAdapter<'_, A>
where
    A: SkillAdapter + ?Sized,
{
    fn adapter_type(&self) -> &'static str {
        self.adapter.adapter_type()
    }

    fn invoke(&self, request: SkillInvocation) -> Result<InvocationOutput, RuntimeError> {
        self.adapter.invoke(request)
    }

    fn isolated_fanout_adapter(
        &self,
        source: &SkillSource,
    ) -> Option<Box<dyn SkillAdapter + Send + Sync>> {
        self.adapter.isolated_fanout_adapter(source)
    }
}

impl<A> SkillAdapter for Box<A>
where
    A: SkillAdapter + ?Sized,
{
    fn adapter_type(&self) -> &'static str {
        self.as_ref().adapter_type()
    }

    fn invoke(&self, request: SkillInvocation) -> Result<InvocationOutput, RuntimeError> {
        self.as_ref().invoke(request)
    }

    fn isolated_fanout_adapter(
        &self,
        source: &SkillSource,
    ) -> Option<Box<dyn SkillAdapter + Send + Sync>> {
        self.as_ref().isolated_fanout_adapter(source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_observation_is_idempotent_and_rejects_conflicting_evidence()
    -> Result<(), Box<dyn std::error::Error>> {
        let delivery = CredentialDelivery::from_local_descriptor(
            "example",
            "api_key",
            "EXAMPLE_TOKEN",
            "local:example:test",
            vec!["example.read".to_owned()],
            "secret",
        )?;
        let observation = delivery
            .public_observation()
            .cloned()
            .ok_or("local delivery omitted its observation")?;
        let mut output = InvocationOutput::runtime_success(JsonValue::Null, 0, JsonObject::new());

        output.record_credential_observation(&observation)?;
        output.record_credential_observation(&observation)?;
        assert_eq!(
            output
                .metadata
                .get(CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA)
                .and_then(JsonValue::as_array)
                .map(Vec::len),
            Some(1)
        );

        let mut conflicting = observation;
        conflicting.provider = "different".into();
        assert!(output.record_credential_observation(&conflicting).is_err());
        Ok(())
    }
}

use std::collections::BTreeMap;
use std::path::PathBuf;

use runx_contracts::{ContextEntry, JsonObject};
#[cfg(feature = "cli-tool")]
use runx_contracts::{CredentialDeliveryObservation, JsonValue};
use runx_parser::SkillSource;
use serde::{Deserialize, Serialize};

use crate::RuntimeError;
use crate::credentials::CredentialDelivery;

/// Metadata key under which a skill's non-secret credential-delivery
/// observations are recorded on [`SkillOutput::metadata`].
pub const CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA: &str = "credential_delivery_observations";
/// Structured, already-verified contract evidence that the receipt sealer binds
/// into signed criteria. Producers must populate this only after native
/// verification succeeds.
pub const CONTRACT_VERIFICATION_METADATA: &str = "contract_verification";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum InvocationStatus {
    Success,
    Failure,
}

#[derive(Clone, Debug)]
pub struct SkillInvocation {
    pub skill_name: String,
    pub source: SkillSource,
    pub inputs: JsonObject,
    pub resolved_inputs: JsonObject,
    pub current_context: Vec<ContextEntry>,
    pub skill_directory: PathBuf,
    pub env: BTreeMap<String, String>,
    pub credential_delivery: CredentialDelivery,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SkillOutput {
    pub status: InvocationStatus,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub metadata: JsonObject,
}

impl SkillOutput {
    #[must_use]
    pub fn succeeded(&self) -> bool {
        self.status == InvocationStatus::Success
    }

    /// Append one non-secret credential observation for receipt sealing. This
    /// records the runtime boundary observation as supplied; it does not imply
    /// that credential material entered the invoked subprocess.
    #[cfg(feature = "cli-tool")]
    pub(crate) fn record_credential_observation(
        &mut self,
        observation: &CredentialDeliveryObservation,
    ) -> Result<(), RuntimeError> {
        let value: JsonValue = serde_json::to_value(observation)
            .and_then(serde_json::from_value)
            .map_err(|source| {
                RuntimeError::json("serializing credential delivery observation", source)
            })?;
        match self
            .metadata
            .get_mut(CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA)
        {
            Some(JsonValue::Array(observations)) => observations.push(value),
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FanoutExecutionMode {
    Serial,
    IsolatedParallel,
}

pub trait SkillAdapter {
    fn adapter_type(&self) -> &'static str;
    fn invoke(&self, request: SkillInvocation) -> Result<SkillOutput, RuntimeError>;

    fn fanout_execution_mode(&self, source: &SkillSource) -> FanoutExecutionMode {
        let _ = source;
        FanoutExecutionMode::Serial
    }

    fn clone_for_fanout(&self) -> Option<Box<dyn SkillAdapter + Send + Sync>> {
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

    fn invoke(&self, request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
        self.adapter.invoke(request)
    }

    fn fanout_execution_mode(&self, source: &SkillSource) -> FanoutExecutionMode {
        self.adapter.fanout_execution_mode(source)
    }

    fn clone_for_fanout(&self) -> Option<Box<dyn SkillAdapter + Send + Sync>> {
        self.adapter.clone_for_fanout()
    }
}

impl<A> SkillAdapter for Box<A>
where
    A: SkillAdapter + ?Sized,
{
    fn adapter_type(&self) -> &'static str {
        self.as_ref().adapter_type()
    }

    fn invoke(&self, request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
        self.as_ref().invoke(request)
    }

    fn fanout_execution_mode(&self, source: &SkillSource) -> FanoutExecutionMode {
        self.as_ref().fanout_execution_mode(source)
    }

    fn clone_for_fanout(&self) -> Option<Box<dyn SkillAdapter + Send + Sync>> {
        self.as_ref().clone_for_fanout()
    }
}

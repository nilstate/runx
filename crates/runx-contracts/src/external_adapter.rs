//! External adapter contract types.
use serde::{Deserialize, Deserializer, Serialize};

use crate::schema::{IsoDateTime, NonEmptyString, RunxSchema};
use crate::{JsonNumber, JsonObject, Reference, ResolutionRequest};

pub const EXTERNAL_ADAPTER_PROTOCOL_VERSION: &str = "runx.external_adapter.v1";

/// The const `protocol_version` discriminant shared by every external-adapter
/// frame.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum ExternalAdapterProtocolVersion {
    #[serde(rename = "runx.external_adapter.v1")]
    V1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum ExternalAdapterManifestSchema {
    #[serde(rename = "runx.external_adapter.manifest.v1")]
    V1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum ExternalAdapterCredentialRequestSchema {
    #[serde(rename = "runx.external_adapter.credential_request.v1")]
    V1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum ExternalAdapterInvocationSchema {
    #[serde(rename = "runx.external_adapter.invocation.v1")]
    V1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum ExternalAdapterHostResolutionSchema {
    #[serde(rename = "runx.external_adapter.host_resolution.v1")]
    V1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
pub enum ExternalAdapterCancellationSchema {
    #[serde(rename = "runx.external_adapter.cancellation.v1")]
    V1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalAdapterTransportKind {
    Process,
    Http,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalAdapterStatus {
    Completed,
    Failed,
    HostResolutionRequested,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalAdapterCredentialPurpose {
    ProviderApi,
    Registry,
    ArtifactStore,
    WebhookVerification,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ExternalAdapterTransport {
    pub kind: ExternalAdapterTransportKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<NonEmptyString>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ExternalAdapterCredentialNeed {
    pub purpose: ExternalAdapterCredentialPurpose,
    pub provider: NonEmptyString,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_refs: Option<Vec<Reference>>,
    pub required: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ExternalAdapterTimeouts {
    pub startup_ms: u64,
    pub invocation_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.external_adapter.manifest.v1")]
pub struct ExternalAdapterManifest {
    pub schema: ExternalAdapterManifestSchema,
    pub protocol_version: ExternalAdapterProtocolVersion,
    pub adapter_id: NonEmptyString,
    pub name: NonEmptyString,
    pub version: NonEmptyString,
    pub supported_source_types: Vec<NonEmptyString>,
    pub transport: ExternalAdapterTransport,
    pub timeouts: ExternalAdapterTimeouts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_needs: Option<Vec<ExternalAdapterCredentialNeed>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonObject>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ExternalAdapterCredentialReference {
    pub credential_ref: Reference,
    pub provider: NonEmptyString,
    pub purpose: ExternalAdapterCredentialPurpose,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.external_adapter.credential_request.v1")]
pub struct ExternalAdapterCredentialRequest {
    pub schema: ExternalAdapterCredentialRequestSchema,
    pub protocol_version: ExternalAdapterProtocolVersion,
    pub request_id: NonEmptyString,
    pub adapter_id: NonEmptyString,
    pub invocation_id: NonEmptyString,
    pub credential_refs: Vec<ExternalAdapterCredentialReference>,
    pub requested_at: IsoDateTime,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.external_adapter.invocation.v1")]
pub struct ExternalAdapterInvocation {
    pub schema: ExternalAdapterInvocationSchema,
    pub protocol_version: ExternalAdapterProtocolVersion,
    pub invocation_id: NonEmptyString,
    pub adapter_id: NonEmptyString,
    pub run_id: NonEmptyString,
    pub step_id: NonEmptyString,
    pub source_type: NonEmptyString,
    pub skill_ref: NonEmptyString,
    pub harness_ref: Reference,
    pub host_ref: Reference,
    pub inputs: JsonObject,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_inputs: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt_dir: Option<NonEmptyString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_refs: Option<Vec<ExternalAdapterCredentialReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonObject>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ExternalAdapterArtifactObservation {
    pub artifact_ref: Reference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ExternalAdapterErrorObservation {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(untagged)]
pub enum ExternalAdapterTelemetryValue {
    Number(JsonNumber),
    String(String),
    Bool(bool),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct ExternalAdapterTelemetryObservation {
    pub name: String,
    pub value: ExternalAdapterTelemetryValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.external_adapter.response.v1")]
pub struct ExternalAdapterResponse {
    pub schema: String,
    pub protocol_version: String,
    pub invocation_id: String,
    pub adapter_id: String,
    pub status: ExternalAdapterStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_nullable_i64",
        skip_serializing_if = "Option::is_none"
    )]
    pub exit_code: Option<Option<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<ExternalAdapterArtifactObservation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<ExternalAdapterErrorObservation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub telemetry: Option<Vec<ExternalAdapterTelemetryObservation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonObject>,
    pub observed_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.external_adapter.host_resolution.v1")]
pub struct ExternalAdapterHostResolutionFrame {
    pub schema: ExternalAdapterHostResolutionSchema,
    pub protocol_version: ExternalAdapterProtocolVersion,
    pub frame_id: NonEmptyString,
    pub invocation_id: NonEmptyString,
    pub adapter_id: NonEmptyString,
    pub request: ResolutionRequest,
    pub requested_at: IsoDateTime,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.external_adapter.cancellation.v1")]
pub struct ExternalAdapterCancellationFrame {
    pub schema: ExternalAdapterCancellationSchema,
    pub protocol_version: ExternalAdapterProtocolVersion,
    pub frame_id: NonEmptyString,
    pub invocation_id: NonEmptyString,
    pub adapter_id: NonEmptyString,
    pub reason: NonEmptyString,
    pub requested_at: IsoDateTime,
}

fn deserialize_optional_nullable_i64<'de, D>(
    deserializer: D,
) -> Result<Option<Option<i64>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<i64>::deserialize(deserializer).map(Some)
}

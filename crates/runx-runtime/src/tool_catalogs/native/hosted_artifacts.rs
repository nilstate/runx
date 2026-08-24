//! Principal-scoped hosted artifact allocation.
//!
//! This capability keeps the run-local bearer and run identity inside the
//! native runtime. Skill graphs can materialize one bounded value and receive
//! only validated V1 artifact metadata; executable package code never receives
//! ambient API authority.

use base64::Engine as _;
use runx_contracts::{JsonObject, JsonValue, ProviderOperationPacket};
use serde::{Deserialize, Serialize};

use crate::hosted_api::request::send_json_idempotent;
use crate::http::NativeHttpTransport;
use crate::{
    CapabilityAdmission, CapabilityApproval, CapabilityArtifacts, CapabilityDefinition,
    CapabilityEffect, CapabilityField, CapabilityInput, CapabilityOutput, HostedApiEnvironment,
    RuntimeError, hosted_private_network_allowed,
};

use super::capability::{NativeCapability, TypedNativeCapability};
use super::{NativeInvocation, invalid_input};

const ALLOCATE_TOOL: &str = "artifact.allocate";
const MAX_ARTIFACT_BYTES: usize = 25 * 1024 * 1024;
const MAX_IDEMPOTENCY_SCOPE_BYTES: usize = 256;

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct ArtifactAllocateInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_base64: Option<String>,
    media_type: String,
    idempotency_scope: String,
}

impl CapabilityInput for ArtifactAllocateInput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct HostedArtifactOutput {
    artifact_operation: ProviderOperationPacket,
}

impl CapabilityOutput for HostedArtifactOutput {}

const ALLOCATE_FIELDS: &[CapabilityField] = &[
    CapabilityField {
        name: "value",
        description: "Optional JSON value encoded as stable JSON bytes; exactly one of value or data_base64 is required.",
    },
    CapabilityField {
        name: "data_base64",
        description: "Optional canonical base64 bytes; exactly one of value or data_base64 is required.",
    },
    CapabilityField {
        name: "media_type",
        description: "Media type committed to the artifact readback.",
    },
    CapabilityField {
        name: "idempotency_scope",
        description: "Stable package-owned purpose; Runx binds it to the current run before storage.",
    },
];

static ALLOCATE: TypedNativeCapability<ArtifactAllocateInput, HostedArtifactOutput> =
    TypedNativeCapability::new_with_execution_boundary(
        CapabilityDefinition {
            id: ALLOCATE_TOOL,
            owner: "runx-runtime/hosted-artifacts",
            summary: "Allocate one bounded principal-scoped hosted artifact with run-bound replay identity.",
            scopes: &["runx:artifact:write"],
            effect: CapabilityEffect::Mutate,
            approval: CapabilityApproval::None,
            artifacts: CapabilityArtifacts::Named {
                output: "artifact_operation",
                packet: "runx.provider.operation.v1",
            },
            admission: CapabilityAdmission::RuntimeInvariant(
                "artifact bytes, digest, media type, and run-bound replay identity must agree before materialization",
            ),
            fields: ALLOCATE_FIELDS,
        },
        allocate,
        runx_contracts::ExecutionBoundaryKind::RemoteProvider,
    );

pub(in crate::tool_catalogs::native) const CAPABILITIES: &[&dyn NativeCapability] = &[&ALLOCATE];

fn allocate(
    invocation: &NativeInvocation<'_, ArtifactAllocateInput>,
) -> Result<HostedArtifactOutput, RuntimeError> {
    let (data_base64, bytes) = allocation_bytes(invocation.inputs)?;
    let media_type = media_type(&invocation.inputs.media_type)?;
    let content_digest = runx_contracts::sha256_prefixed(&bytes);
    let idempotency_key = run_bound_idempotency_key(
        invocation.env,
        &invocation.inputs.idempotency_scope,
        media_type,
        &content_digest,
    )?;
    let body = JsonObject::from([
        (
            "operation".to_owned(),
            JsonValue::String(ALLOCATE_TOOL.to_owned()),
        ),
        (
            "input".to_owned(),
            JsonValue::Object(JsonObject::from([
                (
                    "idempotency_key".to_owned(),
                    JsonValue::String(idempotency_key.clone()),
                ),
                ("data_base64".to_owned(), JsonValue::String(data_base64)),
                (
                    "content_digest".to_owned(),
                    JsonValue::String(content_digest.clone()),
                ),
                (
                    "media_type".to_owned(),
                    JsonValue::String(media_type.to_owned()),
                ),
            ])),
        ),
    ]);
    let (mut packet, principal_ref) = invoke(invocation, body)?;
    validate_packet(&packet, &idempotency_key, &principal_ref)?;
    packet.result = JsonValue::Object(validate_allocation_result(
        &packet,
        &content_digest,
        media_type,
        bytes.len(),
    )?);
    Ok(HostedArtifactOutput {
        artifact_operation: packet,
    })
}

fn invoke<I>(
    invocation: &NativeInvocation<'_, I>,
    body: JsonObject,
) -> Result<(ProviderOperationPacket, String), RuntimeError> {
    let transport = NativeHttpTransport::for_hosted_api(
        invocation.harness_http_responses(),
        hosted_private_network_allowed(false, invocation.env),
    )
    .map_err(|error| runtime_failure(ALLOCATE_TOOL, error.to_string()))?;
    let resolved =
        HostedApiEnvironment::resolve(None, None, invocation.env, invocation.skill_directory)
            .map_err(|error| runtime_failure(ALLOCATE_TOOL, error.to_string()))?;
    let authenticated = resolved
        .authenticate(&transport)
        .map_err(|error| runtime_failure(ALLOCATE_TOOL, error.to_string()))?;
    let encoded = serde_json::to_string(&body)
        .map_err(|source| RuntimeError::json("serializing hosted artifact request", source))?;
    let packet = send_json_idempotent(
        &transport,
        authenticated.base_url(),
        ALLOCATE_TOOL,
        crate::http::HttpMethod::Post,
        "/v1/artifact-operations",
        Some(authenticated.token()),
        Some(encoded),
    )
    .map_err(|error| runtime_failure(ALLOCATE_TOOL, error.to_string()))?;
    Ok((
        packet,
        format!("runx:principal:{}", authenticated.principal_id()),
    ))
}

fn allocation_bytes(input: &ArtifactAllocateInput) -> Result<(String, Vec<u8>), RuntimeError> {
    let bytes = match (&input.value, &input.data_base64) {
        (Some(value), None) => serde_json::to_vec(value)
            .map_err(|source| RuntimeError::json("serializing artifact value", source))?,
        (None, Some(encoded)) => {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| invalid_input(ALLOCATE_TOOL, "data_base64 is invalid"))?;
            if base64::engine::general_purpose::STANDARD.encode(&decoded) != *encoded {
                return Err(invalid_input(
                    ALLOCATE_TOOL,
                    "data_base64 must use canonical padded base64",
                ));
            }
            decoded
        }
        _ => {
            return Err(invalid_input(
                ALLOCATE_TOOL,
                "exactly one of value or data_base64 is required",
            ));
        }
    };
    validate_allocation_size(bytes.len())?;
    Ok((
        base64::engine::general_purpose::STANDARD.encode(&bytes),
        bytes,
    ))
}

fn validate_allocation_size(size: usize) -> Result<(), RuntimeError> {
    if size == 0 || size > MAX_ARTIFACT_BYTES {
        return Err(invalid_input(
            ALLOCATE_TOOL,
            "artifact bytes must be between 1 byte and 25 MiB",
        ));
    }
    Ok(())
}

fn validate_packet(
    packet: &ProviderOperationPacket,
    idempotency_key: &str,
    principal_ref: &str,
) -> Result<(), RuntimeError> {
    if packet.schema != "runx.provider.operation.v1"
        || packet.status != "success"
        || packet.provider != "runx-artifact"
        || packet.operation != ALLOCATE_TOOL
        || packet.access.as_deref() != Some("mutate")
        || packet.transport != "hosted_loopback"
        || packet.principal_ref.as_deref() != Some(principal_ref)
        || packet.finality.as_deref() != Some("verified")
        || packet.readback_ref.trim().is_empty()
        || packet
            .operation_id
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        || packet.idempotency_key.as_deref() != Some(idempotency_key)
        || packet.grant_ref.is_some()
        || packet.plan_digest.is_some()
        || packet.result_digest.is_some()
        || packet.host.is_some()
        || packet.account_ref.is_some()
    {
        return Err(runtime_failure(
            ALLOCATE_TOOL,
            "hosted artifact readback does not match the admitted operation",
        ));
    }
    Ok(())
}

fn validate_allocation_result(
    packet: &ProviderOperationPacket,
    expected_digest: &str,
    expected_media_type: &str,
    expected_size: usize,
) -> Result<JsonObject, RuntimeError> {
    let result = packet.result.as_object().ok_or_else(|| {
        runtime_failure(
            ALLOCATE_TOOL,
            "artifact allocation result must be an object",
        )
    })?;
    let artifact_ref = result.get("artifact_ref").and_then(JsonValue::as_str);
    let digest = result.get("content_digest").and_then(JsonValue::as_str);
    let media_type = result.get("media_type").and_then(JsonValue::as_str);
    let size = result.get("size_bytes").and_then(|value| match value {
        JsonValue::Number(runx_contracts::JsonNumber::U64(value)) => Some(*value),
        JsonValue::Number(runx_contracts::JsonNumber::I64(value)) => u64::try_from(*value).ok(),
        _ => None,
    });
    let (Some(artifact_ref), Some(digest), Some(media_type), Some(size)) =
        (artifact_ref, digest, media_type, size)
    else {
        return Err(runtime_failure(
            ALLOCATE_TOOL,
            "artifact allocation result does not match the requested bytes",
        ));
    };
    if artifact_ref != packet.target
        || self::artifact_ref(artifact_ref).ok() != expected_digest.strip_prefix("sha256:")
        || digest != expected_digest
        || media_type != expected_media_type
        || Some(size) != u64::try_from(expected_size).ok()
    {
        return Err(runtime_failure(
            ALLOCATE_TOOL,
            "artifact allocation result does not match the requested bytes",
        ));
    }
    Ok(JsonObject::from([
        (
            "artifact_ref".to_owned(),
            JsonValue::String(artifact_ref.to_owned()),
        ),
        (
            "content_digest".to_owned(),
            JsonValue::String(digest.to_owned()),
        ),
        (
            "media_type".to_owned(),
            JsonValue::String(media_type.to_owned()),
        ),
        (
            "size_bytes".to_owned(),
            JsonValue::Number(runx_contracts::JsonNumber::U64(size)),
        ),
    ]))
}

fn run_bound_idempotency_key(
    environment: &std::collections::BTreeMap<String, String>,
    scope: &str,
    media_type: &str,
    content_digest: &str,
) -> Result<String, RuntimeError> {
    let run_id = environment
        .get(crate::execution::runner::RUNX_RUN_ID_ENV)
        .map(String::as_str)
        .filter(|value| valid_text(value, 256))
        .ok_or_else(|| invalid_input(ALLOCATE_TOOL, "runtime run identity is unavailable"))?;
    if !valid_text(scope, MAX_IDEMPOTENCY_SCOPE_BYTES) {
        return Err(invalid_input(ALLOCATE_TOOL, "idempotency_scope is invalid"));
    }
    let media_type = self::media_type(media_type)?;
    if !valid_text(content_digest, 71) || !content_digest.starts_with("sha256:") {
        return Err(invalid_input(ALLOCATE_TOOL, "content digest is invalid"));
    }
    let digest = runx_contracts::sha256_prefixed(
        format!("{run_id}\n{scope}\n{media_type}\n{content_digest}").as_bytes(),
    );
    Ok(format!(
        "runx.artifact.allocate:{}",
        digest.trim_start_matches("sha256:")
    ))
}

fn artifact_ref(value: &str) -> Result<&str, RuntimeError> {
    let Some(suffix) = value.strip_prefix("runx:artifact:sha256:") else {
        return Err(invalid_input(ALLOCATE_TOOL, "artifact_ref is invalid"));
    };
    if suffix.len() != 64
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid_input(ALLOCATE_TOOL, "artifact_ref is invalid"));
    }
    Ok(suffix)
}

fn media_type(value: &str) -> Result<&str, RuntimeError> {
    if !valid_text(value, 200) || !value.contains('/') {
        return Err(invalid_input(ALLOCATE_TOOL, "media_type is invalid"));
    }
    Ok(value)
}

fn valid_text(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn runtime_failure(operation: &str, message: impl Into<String>) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: operation.to_owned(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use std::collections::BTreeMap;

    use super::*;
    use crate::credentials::CredentialDelivery;
    use crate::effects::RuntimeEffectRegistry;
    use crate::http::RuntimeHttpResponse;

    #[test]
    fn allocation_accepts_one_canonical_source() {
        let value = ArtifactAllocateInput {
            value: Some(JsonValue::Object(JsonObject::from([(
                "answer".to_owned(),
                JsonValue::Number(runx_contracts::JsonNumber::U64(42)),
            )]))),
            data_base64: None,
            media_type: "application/json".to_owned(),
            idempotency_scope: "ocr-output".to_owned(),
        };
        let (_, bytes) = allocation_bytes(&value).expect("JSON allocation bytes");
        assert_eq!(bytes, br#"{"answer":42}"#);

        let both = ArtifactAllocateInput {
            data_base64: Some("e30=".to_owned()),
            ..value
        };
        assert!(allocation_bytes(&both).is_err());

        let noncanonical = ArtifactAllocateInput {
            value: None,
            data_base64: Some("Zg".to_owned()),
            media_type: "application/octet-stream".to_owned(),
            idempotency_scope: "binary-output".to_owned(),
        };
        assert!(allocation_bytes(&noncanonical).is_err());
        assert!(validate_allocation_size(0).is_err());
        assert!(validate_allocation_size(MAX_ARTIFACT_BYTES + 1).is_err());
    }

    #[test]
    fn idempotency_is_run_bound_and_scope_stable() {
        let environment = std::collections::BTreeMap::from([(
            crate::execution::runner::RUNX_RUN_ID_ENV.to_owned(),
            "run-1".to_owned(),
        )]);
        let first = run_bound_idempotency_key(
            &environment,
            "ocr-output",
            "application/json",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("first key");
        let replay = run_bound_idempotency_key(
            &environment,
            "ocr-output",
            "application/json",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("replay key");
        let other = run_bound_idempotency_key(
            &environment,
            "other-output",
            "application/json",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("other key");
        let other_content = run_bound_idempotency_key(
            &environment,
            "ocr-output",
            "application/json",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .expect("other content key");
        let other_media_type = run_bound_idempotency_key(
            &environment,
            "ocr-output",
            "text/plain",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("other media type key");
        assert_eq!(first, replay);
        assert_ne!(first, other);
        assert_ne!(first, other_content);
        assert_ne!(first, other_media_type);
    }

    #[test]
    fn allocation_readback_binds_principal_and_replay_identity() {
        let mut packet = ProviderOperationPacket {
            schema: "runx.provider.operation.v1".to_owned(),
            status: "success".to_owned(),
            provider: "runx-artifact".to_owned(),
            operation: ALLOCATE_TOOL.to_owned(),
            target: "runx:artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            result: JsonValue::Object(JsonObject::new()),
            transport: "hosted_loopback".to_owned(),
            readback_ref: "runx:artifact-readback:test".to_owned(),
            access: Some("mutate".to_owned()),
            principal_ref: Some("runx:principal:test".to_owned()),
            grant_ref: None,
            finality: Some("verified".to_owned()),
            plan_digest: None,
            result_digest: None,
            operation_id: Some("runx:artifact-operation:test".to_owned()),
            idempotency_key: Some("runx.artifact.allocate:test".to_owned()),
            host: None,
            account_ref: None,
        };
        validate_packet(
            &packet,
            "runx.artifact.allocate:test",
            "runx:principal:test",
        )
        .expect("matching packet");

        packet.principal_ref = Some("runx:principal:other".to_owned());
        assert!(
            validate_packet(
                &packet,
                "runx.artifact.allocate:test",
                "runx:principal:test"
            )
            .is_err()
        );

        packet.principal_ref = Some("runx:principal:test".to_owned());
        packet.account_ref = Some("account:unverified".to_owned());
        assert!(
            validate_packet(
                &packet,
                "runx.artifact.allocate:test",
                "runx:principal:test"
            )
            .is_err()
        );
    }

    #[test]
    fn allocation_replays_through_the_native_harness_and_projects_metadata() {
        let base_url = "https://artifact-fixture.runx.invalid";
        let input = ArtifactAllocateInput {
            value: Some(JsonValue::Object(JsonObject::from([(
                "answer".to_owned(),
                JsonValue::Number(runx_contracts::JsonNumber::U64(42)),
            )]))),
            data_base64: None,
            media_type: "application/json".to_owned(),
            idempotency_scope: "ausca.document-ocr.output.v1".to_owned(),
        };
        let (_, bytes) = allocation_bytes(&input).expect("allocation bytes");
        let content_digest = runx_contracts::sha256_prefixed(&bytes);
        let artifact_ref = format!(
            "runx:artifact:sha256:{}",
            content_digest.trim_start_matches("sha256:")
        );
        let env = BTreeMap::from([
            (
                crate::HOSTED_API_BASE_URL_ENV.to_owned(),
                base_url.to_owned(),
            ),
            (
                crate::HOSTED_API_TOKEN_ENV.to_owned(),
                "rxk_fixture".to_owned(),
            ),
            (
                crate::execution::runner::RUNX_RUN_ID_ENV.to_owned(),
                "run-fixture".to_owned(),
            ),
        ]);
        let idempotency_key = run_bound_idempotency_key(
            &env,
            &input.idempotency_scope,
            &input.media_type,
            &content_digest,
        )
        .expect("idempotency key");
        let packet = ProviderOperationPacket {
            schema: "runx.provider.operation.v1".to_owned(),
            status: "success".to_owned(),
            provider: "runx-artifact".to_owned(),
            operation: ALLOCATE_TOOL.to_owned(),
            target: artifact_ref.clone(),
            result: JsonValue::Object(JsonObject::from([
                (
                    "artifact_ref".to_owned(),
                    JsonValue::String(artifact_ref.clone()),
                ),
                (
                    "content_digest".to_owned(),
                    JsonValue::String(content_digest),
                ),
                (
                    "media_type".to_owned(),
                    JsonValue::String("application/json".to_owned()),
                ),
                (
                    "size_bytes".to_owned(),
                    JsonValue::Number(runx_contracts::JsonNumber::U64(bytes.len() as u64)),
                ),
                (
                    "download_url".to_owned(),
                    JsonValue::String("https://must-not-escape.invalid".to_owned()),
                ),
            ])),
            transport: "hosted_loopback".to_owned(),
            readback_ref: "runx:artifact-readback:fixture".to_owned(),
            access: Some("mutate".to_owned()),
            principal_ref: Some("runx:principal:operator:test".to_owned()),
            grant_ref: None,
            finality: Some("verified".to_owned()),
            plan_digest: None,
            result_digest: None,
            operation_id: Some("runx:artifact-operation:fixture".to_owned()),
            idempotency_key: Some(idempotency_key),
            host: None,
            account_ref: None,
        };
        let responses = BTreeMap::from([
            (
                format!("{base_url}/v1/me"),
                RuntimeHttpResponse::new(
                    200,
                    r#"{"status":"success","principal":{"principal_id":"operator:test"}}"#,
                ),
            ),
            (
                format!("{base_url}/v1/artifact-operations"),
                RuntimeHttpResponse::new(200, serde_json::to_string(&packet).expect("packet JSON")),
            ),
        ]);
        let effects = RuntimeEffectRegistry::default().with_harness_http_responses(responses);
        let credentials = CredentialDelivery::none();
        let output = allocate(&NativeInvocation {
            inputs: &input,
            observed_at: "2026-08-24T00:00:00Z",
            data_source_binding: None,
            env: &env,
            skill_directory: std::path::Path::new("."),
            credential_delivery: &credentials,
            local_artifacts: super::super::fixture_local_artifacts(),
            effects: &effects,
        })
        .expect("harness allocation");
        let result = output
            .artifact_operation
            .result
            .as_object()
            .expect("projected result");

        assert_eq!(result.len(), 4);
        assert!(!result.contains_key("download_url"));
        assert_eq!(
            crate::tool_catalogs::native::required_scopes(ALLOCATE_TOOL),
            Some(&["runx:artifact:write"][..])
        );
    }

    #[test]
    fn allocation_ref_must_name_the_verified_content_digest() {
        let expected_digest =
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let artifact_ref =
            "runx:artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let packet = ProviderOperationPacket {
            schema: "runx.provider.operation.v1".to_owned(),
            status: "success".to_owned(),
            provider: "runx-artifact".to_owned(),
            operation: ALLOCATE_TOOL.to_owned(),
            target: artifact_ref.to_owned(),
            result: JsonValue::Object(JsonObject::from([
                (
                    "artifact_ref".to_owned(),
                    JsonValue::String(artifact_ref.to_owned()),
                ),
                (
                    "content_digest".to_owned(),
                    JsonValue::String(expected_digest.to_owned()),
                ),
                (
                    "media_type".to_owned(),
                    JsonValue::String("application/json".to_owned()),
                ),
                (
                    "size_bytes".to_owned(),
                    JsonValue::Number(runx_contracts::JsonNumber::U64(1)),
                ),
            ])),
            transport: "hosted_loopback".to_owned(),
            readback_ref: "runx:artifact-readback:test".to_owned(),
            access: Some("mutate".to_owned()),
            principal_ref: Some("runx:principal:test".to_owned()),
            grant_ref: None,
            finality: Some("verified".to_owned()),
            plan_digest: None,
            result_digest: None,
            operation_id: Some("runx:artifact-operation:test".to_owned()),
            idempotency_key: Some("runx.artifact.allocate:test".to_owned()),
            host: None,
            account_ref: None,
        };

        assert!(
            validate_allocation_result(&packet, expected_digest, "application/json", 1).is_err()
        );
    }
}

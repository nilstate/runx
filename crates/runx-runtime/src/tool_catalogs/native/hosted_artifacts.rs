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
const HOSTED_ARTIFACT_MAXIMUM_BYTES_ENV: &str = "RUNX_HOSTED_ARTIFACT_MAXIMUM_BYTES";
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
    let maximum_bytes = hosted_artifact_maximum_bytes(invocation.env)?;
    let (data_base64, bytes) = allocation_bytes(invocation.inputs, maximum_bytes)?;
    let media_type = media_type(&invocation.inputs.media_type)?;
    let content_digest = runx_contracts::sha256_prefixed(&bytes);
    let run_id = runtime_run_id(invocation.env)?;
    let idempotency_key = run_bound_idempotency_key(
        run_id,
        &invocation.inputs.idempotency_scope,
        media_type,
        &content_digest,
    )?;
    let body = JsonObject::from([
        (
            "operation".to_owned(),
            JsonValue::String(ALLOCATE_TOOL.to_owned()),
        ),
        ("run_id".to_owned(), JsonValue::String(run_id.to_owned())),
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
    let (packet, principal_ref) = invoke(invocation, body)?;
    validate_packet(&packet, &idempotency_key, &principal_ref)?;
    validate_allocation_result(&packet, &content_digest, media_type, bytes.len())?;
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

fn allocation_bytes(
    input: &ArtifactAllocateInput,
    maximum_bytes: usize,
) -> Result<(String, Vec<u8>), RuntimeError> {
    let bytes = match (&input.value, &input.data_base64) {
        (Some(value), None) => serde_json::to_vec(value)
            .map_err(|source| RuntimeError::json("serializing artifact value", source))?,
        (None, Some(encoded)) => {
            if encoded.len() > maximum_base64_bytes(maximum_bytes) {
                return Err(invalid_input(
                    ALLOCATE_TOOL,
                    "artifact bytes exceed the hosted capacity",
                ));
            }
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
    validate_allocation_size(bytes.len(), maximum_bytes)?;
    Ok((
        base64::engine::general_purpose::STANDARD.encode(&bytes),
        bytes,
    ))
}

fn hosted_artifact_maximum_bytes(
    environment: &std::collections::BTreeMap<String, String>,
) -> Result<usize, RuntimeError> {
    let maximum_bytes = environment
        .get(HOSTED_ARTIFACT_MAXIMUM_BYTES_ENV)
        .filter(|value| {
            value.as_bytes().first().is_some_and(|byte| *byte != b'0')
                && value.bytes().all(|byte| byte.is_ascii_digit())
        })
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            invalid_input(
                ALLOCATE_TOOL,
                "hosted artifact capacity is unavailable or invalid",
            )
        })?;
    Ok(maximum_bytes)
}

fn maximum_base64_bytes(maximum_bytes: usize) -> usize {
    maximum_bytes
        .checked_add(2)
        .and_then(|value| value.checked_div(3))
        .and_then(|value| value.checked_mul(4))
        .unwrap_or(usize::MAX)
}

fn validate_allocation_size(size: usize, maximum_bytes: usize) -> Result<(), RuntimeError> {
    if size == 0 || size > maximum_bytes {
        return Err(invalid_input(
            ALLOCATE_TOOL,
            "artifact bytes must be non-empty and within the hosted capacity",
        ));
    }
    Ok(())
}

fn validate_packet(
    packet: &ProviderOperationPacket,
    idempotency_key: &str,
    principal_ref: &str,
) -> Result<(), RuntimeError> {
    let hosted_result_digest = digest_json(&packet.result)?;
    let expected_readback_ref = format!(
        "runx:artifact-readback:{}",
        hosted_result_digest.trim_start_matches("sha256:")
    );
    if packet.schema != "runx.provider.operation.v1"
        || packet.status != "success"
        || packet.provider != "runx-artifact"
        || packet.operation != ALLOCATE_TOOL
        || packet.access.as_deref() != Some("mutate")
        || !matches!(
            packet.transport.as_str(),
            "hosted_loopback" | "hosted_control_plane"
        )
        || packet.principal_ref.as_deref() != Some(principal_ref)
        || packet.finality.as_deref() != Some("verified")
        || packet.readback_ref != expected_readback_ref
        || packet
            .operation_id
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        || packet.idempotency_key.as_deref() != Some(idempotency_key)
        || packet.grant_ref.is_some()
        || packet.plan_digest.is_some()
        || packet.result_digest.as_deref() != Some(hosted_result_digest.as_str())
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
) -> Result<(), RuntimeError> {
    let result = packet.result.as_object().ok_or_else(|| {
        runtime_failure(
            ALLOCATE_TOOL,
            "artifact allocation result must be an object",
        )
    })?;
    let artifact_ref = result.get("artifact_ref").and_then(JsonValue::as_str);
    let digest = result.get("content_digest").and_then(JsonValue::as_str);
    let media_type = result.get("media_type").and_then(JsonValue::as_str);
    let created_at = result.get("created_at").and_then(JsonValue::as_str);
    let size = result.get("size_bytes").and_then(|value| match value {
        JsonValue::Number(runx_contracts::JsonNumber::U64(value)) => Some(*value),
        JsonValue::Number(runx_contracts::JsonNumber::I64(value)) => u64::try_from(*value).ok(),
        _ => None,
    });
    let (Some(artifact_ref), Some(digest), Some(media_type), Some(size), Some(created_at)) =
        (artifact_ref, digest, media_type, size, created_at)
    else {
        return Err(runtime_failure(
            ALLOCATE_TOOL,
            "artifact allocation result does not match the requested bytes",
        ));
    };
    // artifact_ref is the principal/idempotency-scoped storage identity. The
    // separately verified content_digest is the content identity; callers
    // must not infer one from the other.
    if result.len() != 5
        || artifact_ref != packet.target
        || self::artifact_ref(artifact_ref).is_err()
        || digest != expected_digest
        || media_type != expected_media_type
        || Some(size) != u64::try_from(expected_size).ok()
        || !valid_text(created_at, 64)
    {
        return Err(runtime_failure(
            ALLOCATE_TOOL,
            "artifact allocation result does not match the requested bytes",
        ));
    }
    Ok(())
}

fn run_bound_idempotency_key(
    run_id: &str,
    scope: &str,
    media_type: &str,
    content_digest: &str,
) -> Result<String, RuntimeError> {
    if !valid_text(run_id, 256) {
        return Err(invalid_input(
            ALLOCATE_TOOL,
            "runtime run identity is unavailable",
        ));
    }
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

fn runtime_run_id(
    environment: &std::collections::BTreeMap<String, String>,
) -> Result<&str, RuntimeError> {
    environment
        .get(crate::execution::runner::RUNX_RUN_ID_ENV)
        .map(String::as_str)
        .filter(|value| valid_text(value, 256))
        .ok_or_else(|| invalid_input(ALLOCATE_TOOL, "runtime run identity is unavailable"))
}

fn digest_json(value: &JsonValue) -> Result<String, RuntimeError> {
    serde_json::to_vec(value)
        .map(|encoded| runx_contracts::sha256_prefixed(&encoded))
        .map_err(|source| RuntimeError::json("digesting hosted artifact result", source))
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
        let maximum_bytes = 2 * 1024 * 1024;
        let value = ArtifactAllocateInput {
            value: Some(JsonValue::Object(JsonObject::from([(
                "answer".to_owned(),
                JsonValue::Number(runx_contracts::JsonNumber::U64(42)),
            )]))),
            data_base64: None,
            media_type: "application/json".to_owned(),
            idempotency_scope: "ocr-output".to_owned(),
        };
        let (_, bytes) = allocation_bytes(&value, maximum_bytes).expect("JSON allocation bytes");
        assert_eq!(bytes, br#"{"answer":42}"#);

        let both = ArtifactAllocateInput {
            data_base64: Some("e30=".to_owned()),
            ..value
        };
        assert!(allocation_bytes(&both, maximum_bytes).is_err());

        let noncanonical = ArtifactAllocateInput {
            value: None,
            data_base64: Some("Zg".to_owned()),
            media_type: "application/octet-stream".to_owned(),
            idempotency_scope: "binary-output".to_owned(),
        };
        assert!(allocation_bytes(&noncanonical, maximum_bytes).is_err());
        assert!(validate_allocation_size(0, maximum_bytes).is_err());
        assert!(validate_allocation_size(maximum_bytes + 1, maximum_bytes).is_err());
    }

    #[test]
    fn allocation_capacity_is_host_owned_and_above_legacy_inline_size() {
        let maximum_bytes = 2 * 1024 * 1024;
        let environment = BTreeMap::from([(
            HOSTED_ARTIFACT_MAXIMUM_BYTES_ENV.to_owned(),
            maximum_bytes.to_string(),
        )]);
        assert_eq!(
            hosted_artifact_maximum_bytes(&environment).expect("configured capacity"),
            maximum_bytes
        );

        let data = vec![7_u8; 1024 * 1024 + 1];
        let input = ArtifactAllocateInput {
            value: None,
            data_base64: Some(base64::engine::general_purpose::STANDARD.encode(&data)),
            media_type: "application/octet-stream".to_owned(),
            idempotency_scope: "large-binary".to_owned(),
        };
        let (_, decoded) = allocation_bytes(&input, maximum_bytes).expect("artifact above 1 MiB");
        assert_eq!(decoded.len(), data.len());
        assert!(allocation_bytes(&input, data.len() - 1).is_err());

        for invalid in [
            None,
            Some(""),
            Some("0"),
            Some("01"),
            Some("+1"),
            Some(" 1024"),
            Some("not-a-size"),
        ] {
            let environment = invalid
                .map(|value| {
                    BTreeMap::from([(
                        HOSTED_ARTIFACT_MAXIMUM_BYTES_ENV.to_owned(),
                        value.to_owned(),
                    )])
                })
                .unwrap_or_default();
            assert!(hosted_artifact_maximum_bytes(&environment).is_err());
        }
    }

    #[test]
    fn allocation_refuses_missing_capacity_before_hosted_io() {
        let input = ArtifactAllocateInput {
            value: Some(JsonValue::Object(JsonObject::from([(
                "answer".to_owned(),
                JsonValue::Number(runx_contracts::JsonNumber::U64(42)),
            )]))),
            data_base64: None,
            media_type: "application/json".to_owned(),
            idempotency_scope: "ocr-output".to_owned(),
        };
        let env = BTreeMap::from([(
            crate::HOSTED_API_BASE_URL_ENV.to_owned(),
            "not-a-hosted-url".to_owned(),
        )]);
        let credentials = CredentialDelivery::none();
        let effects = RuntimeEffectRegistry::default();

        let error = allocate(&NativeInvocation {
            inputs: &input,
            observed_at: "2026-08-24T00:00:00Z",
            data_source_binding: None,
            env: &env,
            skill_directory: std::path::Path::new("."),
            credential_delivery: &credentials,
            local_artifacts: super::super::fixture_local_artifacts(),
            effects: &effects,
        })
        .expect_err("missing capacity must refuse before hosted resolution");

        assert!(
            matches!(
                &error,
                RuntimeError::SkillFailed {
                    skill_name,
                    message,
                } if skill_name == ALLOCATE_TOOL
                    && message == "hosted artifact capacity is unavailable or invalid"
            ),
            "unexpected missing-capacity error: {error}"
        );
    }

    #[test]
    fn idempotency_is_run_bound_and_scope_stable() {
        let first = run_bound_idempotency_key(
            "run-1",
            "ocr-output",
            "application/json",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("first key");
        let replay = run_bound_idempotency_key(
            "run-1",
            "ocr-output",
            "application/json",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("replay key");
        let other = run_bound_idempotency_key(
            "run-1",
            "other-output",
            "application/json",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("other key");
        let other_content = run_bound_idempotency_key(
            "run-1",
            "ocr-output",
            "application/json",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .expect("other content key");
        let other_media_type = run_bound_idempotency_key(
            "run-1",
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
        let result = JsonValue::Object(JsonObject::new());
        let result_digest = digest_json(&result).expect("result digest");
        let mut packet = ProviderOperationPacket {
            schema: "runx.provider.operation.v1".to_owned(),
            status: "success".to_owned(),
            provider: "runx-artifact".to_owned(),
            operation: ALLOCATE_TOOL.to_owned(),
            target: "runx:artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            result,
            transport: "hosted_loopback".to_owned(),
            readback_ref: format!(
                "runx:artifact-readback:{}",
                result_digest.trim_start_matches("sha256:")
            ),
            access: Some("mutate".to_owned()),
            principal_ref: Some("runx:principal:test".to_owned()),
            grant_ref: None,
            finality: Some("verified".to_owned()),
            plan_digest: None,
            result_digest: Some(result_digest),
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
    fn artifact_result_digest_matches_the_hosted_canonical_json_contract() {
        let result = JsonValue::Object(JsonObject::from([
            (
                "artifact_ref".to_owned(),
                JsonValue::String(
                    "runx:artifact:sha256:81c6229bbf333718687f4cb790606ace26e5d509f8b044d6a330828083231bb5"
                        .to_owned(),
                ),
            ),
            (
                "content_digest".to_owned(),
                JsonValue::String(
                    "sha256:80ff22272248cc8280cc7fbbbaab3568ab009b7905dc51fa498e16ff2f181aa9"
                        .to_owned(),
                ),
            ),
            (
                "created_at".to_owned(),
                JsonValue::String("2026-08-24T00:00:00.000Z".to_owned()),
            ),
            (
                "media_type".to_owned(),
                JsonValue::String("application/pdf".to_owned()),
            ),
            (
                "size_bytes".to_owned(),
                JsonValue::Number(runx_contracts::JsonNumber::U64(23)),
            ),
        ]));
        assert_eq!(
            digest_json(&result).expect("artifact result digest"),
            "sha256:2f72b1eb54a75ba3b7d0b71b014915ed5b0951b060da53504d17b080dce2378d"
        );
    }

    #[test]
    fn allocation_replays_through_the_native_harness_and_validates_exact_metadata() {
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
        let maximum_bytes = 1024;
        let (_, bytes) = allocation_bytes(&input, maximum_bytes).expect("allocation bytes");
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
            (
                HOSTED_ARTIFACT_MAXIMUM_BYTES_ENV.to_owned(),
                maximum_bytes.to_string(),
            ),
        ]);
        let idempotency_key = run_bound_idempotency_key(
            "run-fixture",
            &input.idempotency_scope,
            &input.media_type,
            &content_digest,
        )
        .expect("idempotency key");
        let hosted_result = JsonValue::Object(JsonObject::from([
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
                "created_at".to_owned(),
                JsonValue::String("2026-08-24T00:00:00.000Z".to_owned()),
            ),
        ]));
        let hosted_result_digest = digest_json(&hosted_result).expect("hosted result digest");
        let packet = ProviderOperationPacket {
            schema: "runx.provider.operation.v1".to_owned(),
            status: "success".to_owned(),
            provider: "runx-artifact".to_owned(),
            operation: ALLOCATE_TOOL.to_owned(),
            target: artifact_ref.clone(),
            result: hosted_result,
            transport: "hosted_control_plane".to_owned(),
            readback_ref: format!(
                "runx:artifact-readback:{}",
                hosted_result_digest.trim_start_matches("sha256:")
            ),
            access: Some("mutate".to_owned()),
            principal_ref: Some("runx:principal:operator:test".to_owned()),
            grant_ref: None,
            finality: Some("verified".to_owned()),
            plan_digest: None,
            result_digest: Some(hosted_result_digest),
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

        assert_eq!(result.len(), 5);
        assert!(!result.contains_key("download_url"));
        assert_eq!(
            crate::tool_catalogs::native::required_scopes(ALLOCATE_TOOL),
            Some(&["runx:artifact:write"][..])
        );
    }

    #[test]
    fn allocation_ref_is_opaque_and_result_remains_exact() {
        let expected_digest =
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let artifact_ref =
            "runx:artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let mut packet = ProviderOperationPacket {
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
                (
                    "created_at".to_owned(),
                    JsonValue::String("2026-08-24T00:00:00.000Z".to_owned()),
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

        validate_allocation_result(&packet, expected_digest, "application/json", 1)
            .expect("opaque artifact identity with exact content evidence");

        let JsonValue::Object(result) = &mut packet.result else {
            panic!("artifact result must be an object");
        };
        result.insert(
            "artifact_ref".to_owned(),
            JsonValue::String("runx:artifact:not-a-digest".to_owned()),
        );
        assert!(
            validate_allocation_result(&packet, expected_digest, "application/json", 1).is_err()
        );
        let JsonValue::Object(result) = &mut packet.result else {
            panic!("artifact result must be an object");
        };
        result.insert(
            "artifact_ref".to_owned(),
            JsonValue::String(artifact_ref.to_owned()),
        );
        result.insert(
            "download_url".to_owned(),
            JsonValue::String("https://must-not-escape.invalid".to_owned()),
        );
        assert!(
            validate_allocation_result(&packet, expected_digest, "application/json", 1).is_err()
        );
        let JsonValue::Object(result) = &mut packet.result else {
            panic!("artifact result must be an object");
        };
        result.remove("download_url");
        validate_allocation_result(&packet, expected_digest, "application/json", 1)
            .expect("exact artifact result");
    }
}

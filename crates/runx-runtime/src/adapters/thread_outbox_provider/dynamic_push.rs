use runx_contracts::{
    CredentialDeliveryMode, CredentialDeliveryPurpose, JsonObject, JsonValue, Reference,
    ReferenceType, ThreadOutboxProviderCredentialProfile, ThreadOutboxProviderIdempotency,
    ThreadOutboxProviderIdempotencyObservation, ThreadOutboxProviderIdempotencyStatus,
    ThreadOutboxProviderManifest, ThreadOutboxProviderObservation,
    ThreadOutboxProviderObservationSchema, ThreadOutboxProviderObservationStatus,
    ThreadOutboxProviderOperation, ThreadOutboxProviderPayloadFormat,
    ThreadOutboxProviderProtocolVersion, ThreadOutboxProviderPush, ThreadOutboxProviderPushSchema,
    ThreadOutboxProviderReceiptContext, ThreadOutboxProviderRenderedPayload,
    ThreadOutboxProviderThreadLocator, sha256_prefixed,
};

use super::{ThreadOutboxProviderSkillAdapterError, json_error};
use crate::credentials::CredentialDelivery;
use crate::outbox_provider::ThreadOutboxProviderProcessOutcome;

struct DynamicPushContext {
    outbox_entry_id: String,
    thread_locator: String,
    payload_body: String,
    content_hash: String,
    idempotency_key: String,
}

pub(super) fn dynamic_push_from_inputs(
    manifest: &ThreadOutboxProviderManifest,
    inputs: &JsonObject,
    credential_delivery: &CredentialDelivery,
) -> Result<Option<ThreadOutboxProviderPush>, ThreadOutboxProviderSkillAdapterError> {
    let Some(context) = dynamic_push_context(manifest, inputs)? else {
        return Ok(None);
    };
    Ok(Some(build_dynamic_push(
        manifest,
        credential_delivery,
        context,
    )))
}

pub(super) fn skipped_dynamic_push_outcome(
    manifest: &ThreadOutboxProviderManifest,
    inputs: &JsonObject,
) -> Result<ThreadOutboxProviderProcessOutcome, ThreadOutboxProviderSkillAdapterError> {
    let outbox_entry = required_input_object(inputs, "outbox_entry")?;
    let outbox_entry_id = required_object_string(outbox_entry, "outbox_entry", "entry_id")?;
    let provider_output = skipped_provider_output(inputs, outbox_entry)?;
    Ok(ThreadOutboxProviderProcessOutcome {
        observation: skipped_observation(manifest, outbox_entry_id),
        provider_output: Some(provider_output),
        redacted_stderr: String::new(),
        process_exit_code: Some(0),
        duration_ms: 0,
        execution_boundary: None,
    })
}

fn dynamic_push_context(
    manifest: &ThreadOutboxProviderManifest,
    inputs: &JsonObject,
) -> Result<Option<DynamicPushContext>, ThreadOutboxProviderSkillAdapterError> {
    let outbox_entry = required_input_object(inputs, "outbox_entry")?;
    let outbox_entry_id = required_object_string(outbox_entry, "outbox_entry", "entry_id")?;
    let Some(thread) = optional_input_object(inputs, "thread")? else {
        return Ok(None);
    };
    let thread_locator = first_object_string(outbox_entry, "thread_locator")
        .or_else(|| first_object_string(thread, "thread_locator"))
        .ok_or(
            ThreadOutboxProviderSkillAdapterError::MissingDynamicInputString {
                field: "thread",
                nested: "thread_locator",
            },
        )?;
    let payload_body = dynamic_payload_body(inputs)?;
    let content_hash = sha256_prefixed(payload_body.as_bytes());
    Ok(Some(DynamicPushContext {
        outbox_entry_id: outbox_entry_id.to_owned(),
        thread_locator: thread_locator.to_owned(),
        payload_body,
        content_hash,
        idempotency_key: format!(
            "thread-outbox:{}:{}:{}",
            manifest.provider, thread_locator, outbox_entry_id
        ),
    }))
}

fn build_dynamic_push(
    manifest: &ThreadOutboxProviderManifest,
    credential_delivery: &CredentialDelivery,
    context: DynamicPushContext,
) -> ThreadOutboxProviderPush {
    ThreadOutboxProviderPush {
        schema: ThreadOutboxProviderPushSchema::V1,
        protocol_version: ThreadOutboxProviderProtocolVersion::V1,
        push_id: format!(
            "thread_push_{}",
            identifier_segment(&context.outbox_entry_id)
        )
        .into(),
        adapter_id: manifest.adapter_id.clone(),
        provider: manifest.provider.clone(),
        outbox_entry_id: context.outbox_entry_id.clone().into(),
        thread_locator: dynamic_thread_locator(manifest, &context.thread_locator),
        idempotency: ThreadOutboxProviderIdempotency {
            key: context.idempotency_key.into(),
            content_hash: Some(context.content_hash.clone().into()),
        },
        payload: dynamic_payload(context.payload_body, context.content_hash),
        provider_profile: dynamic_provider_profile(manifest, credential_delivery),
        credential_delivery_refs: credential_delivery_refs(credential_delivery),
        receipt_context: dynamic_receipt_context(),
        requested_at: crate::time::now_iso8601().into(),
    }
}

fn dynamic_thread_locator(
    manifest: &ThreadOutboxProviderManifest,
    thread_locator: &str,
) -> ThreadOutboxProviderThreadLocator {
    ThreadOutboxProviderThreadLocator {
        provider: manifest.provider.clone(),
        thread_ref: thread_reference(manifest.provider.as_str(), thread_locator),
        locator: thread_locator.to_owned().into(),
    }
}

fn dynamic_payload(
    payload_body: String,
    content_hash: String,
) -> ThreadOutboxProviderRenderedPayload {
    ThreadOutboxProviderRenderedPayload {
        format: ThreadOutboxProviderPayloadFormat::Json,
        body: payload_body.into(),
        body_sha256: Some(content_hash.into()),
        redaction_refs: Some(vec![Reference::with_uri(
            ReferenceType::RedactionPolicy,
            "runx:redaction_policy:provider-output",
        )]),
    }
}

fn dynamic_provider_profile(
    manifest: &ThreadOutboxProviderManifest,
    credential_delivery: &CredentialDelivery,
) -> ThreadOutboxProviderCredentialProfile {
    ThreadOutboxProviderCredentialProfile {
        provider: manifest.provider.clone(),
        purpose: CredentialDeliveryPurpose::ProviderApi,
        profile_id: first_credential_profile_id(manifest)
            .unwrap_or_else(|| "provider-api-env".to_owned())
            .into(),
        delivery_mode: CredentialDeliveryMode::ProcessEnv,
        credential_refs: credential_delivery.credential_refs().unwrap_or_default(),
    }
}

fn dynamic_receipt_context() -> ThreadOutboxProviderReceiptContext {
    ThreadOutboxProviderReceiptContext {
        harness_ref: Reference::with_uri(
            ReferenceType::Harness,
            "runx:harness:thread-outbox-provider-dynamic",
        ),
        host_ref: Reference::with_uri(ReferenceType::Host, "runx:host:local-cli"),
        authority_proof_refs: None,
        scope_refs: None,
    }
}

fn skipped_provider_output(
    inputs: &JsonObject,
    outbox_entry: &JsonObject,
) -> Result<JsonObject, ThreadOutboxProviderSkillAdapterError> {
    let mut provider_output = JsonObject::new();
    provider_output.insert(
        "outbox_entry".to_owned(),
        JsonValue::Object(outbox_entry.clone()),
    );
    provider_output.insert("thread".to_owned(), JsonValue::Null);
    provider_output.insert("push".to_owned(), JsonValue::Object(skipped_push()));
    if let Some(draft_pull_request) = optional_input_object(inputs, "draft_pull_request")? {
        provider_output.insert(
            "draft_pull_request".to_owned(),
            JsonValue::Object(draft_pull_request.clone()),
        );
    }
    Ok(provider_output)
}

fn skipped_push() -> JsonObject {
    let mut push = JsonObject::new();
    push.insert("status".to_owned(), JsonValue::String("skipped".to_owned()));
    push.insert(
        "reason".to_owned(),
        JsonValue::String("thread not provided".to_owned()),
    );
    push
}

fn skipped_observation(
    manifest: &ThreadOutboxProviderManifest,
    outbox_entry_id: &str,
) -> ThreadOutboxProviderObservation {
    ThreadOutboxProviderObservation {
        schema: ThreadOutboxProviderObservationSchema::V1,
        protocol_version: ThreadOutboxProviderProtocolVersion::V1,
        observation_id: format!("thread_obs_skipped_{}", identifier_segment(outbox_entry_id))
            .into(),
        adapter_id: manifest.adapter_id.clone(),
        provider: manifest.provider.clone(),
        operation: ThreadOutboxProviderOperation::Push,
        request_id: format!("thread_push_{}", identifier_segment(outbox_entry_id)).into(),
        status: ThreadOutboxProviderObservationStatus::Skipped,
        idempotency: ThreadOutboxProviderIdempotencyObservation {
            key: format!(
                "thread-outbox:{}:missing-thread:{}",
                manifest.provider, outbox_entry_id
            )
            .into(),
            status: ThreadOutboxProviderIdempotencyStatus::Skipped,
            original_observation_ref: None,
        },
        provider_locator: None,
        provider_event_id_hash: None,
        readback_summary: None,
        delivery_observations: None,
        redaction_refs: None,
        errors: None,
        observed_at: crate::time::now_iso8601().into(),
    }
}

fn dynamic_payload_body(
    inputs: &JsonObject,
) -> Result<String, ThreadOutboxProviderSkillAdapterError> {
    serde_json::to_string(&JsonValue::Object(dynamic_provider_payload(inputs)))
        .map_err(|source| json_error("serializing dynamic thread provider payload", source))
}

fn dynamic_provider_payload(inputs: &JsonObject) -> JsonObject {
    let mut payload = JsonObject::new();
    for key in [
        "thread",
        "outbox_entry",
        "draft_pull_request",
        "fixture",
        "workspace_path",
        "next_status",
    ] {
        if let Some(value) = inputs.get(key) {
            payload.insert(key.to_owned(), value.clone());
        }
    }
    payload
}

fn required_input_object<'a>(
    inputs: &'a JsonObject,
    field: &'static str,
) -> Result<&'a JsonObject, ThreadOutboxProviderSkillAdapterError> {
    optional_input_object(inputs, field)?
        .ok_or(ThreadOutboxProviderSkillAdapterError::MissingDynamicInput { field })
}

fn optional_input_object<'a>(
    inputs: &'a JsonObject,
    field: &'static str,
) -> Result<Option<&'a JsonObject>, ThreadOutboxProviderSkillAdapterError> {
    match inputs.get(field) {
        Some(JsonValue::Object(object)) => Ok(Some(object)),
        Some(JsonValue::Null) | None => Ok(None),
        Some(_) => Err(ThreadOutboxProviderSkillAdapterError::InvalidDynamicInput {
            field,
            expected: "an object",
        }),
    }
}

fn required_object_string<'a>(
    object: &'a JsonObject,
    field: &'static str,
    nested: &'static str,
) -> Result<&'a str, ThreadOutboxProviderSkillAdapterError> {
    first_object_string(object, nested)
        .ok_or(ThreadOutboxProviderSkillAdapterError::MissingDynamicInputString { field, nested })
}

fn first_object_string<'a>(object: &'a JsonObject, key: &str) -> Option<&'a str> {
    object
        .get(key)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn credential_delivery_refs(credential_delivery: &CredentialDelivery) -> Vec<Reference> {
    credential_delivery
        .public_observation()
        .map(|observation| {
            vec![Reference::with_uri(
                ReferenceType::Receipt,
                format!(
                    "runx:credential_delivery_observation:{}",
                    observation.observation_id
                ),
            )]
        })
        .unwrap_or_default()
}

fn first_credential_profile_id(manifest: &ThreadOutboxProviderManifest) -> Option<String> {
    manifest
        .credential_needs
        .as_ref()?
        .iter()
        .find(|need| need.provider.as_str() == manifest.provider.as_str())
        .map(|need| need.profile_id.to_string())
}

fn thread_reference(provider: &str, thread_locator: &str) -> Reference {
    let reference_type = if provider == "github" && thread_locator.starts_with("github://") {
        ReferenceType::GithubIssue
    } else {
        ReferenceType::ProviderThread
    };
    let mut reference = Reference::with_uri(reference_type, thread_locator.to_owned());
    reference.provider = Some(provider.to_owned().into());
    reference.locator = Some(thread_locator.to_owned().into());
    reference
}

fn identifier_segment(value: &str) -> String {
    let mut output = String::new();
    let mut replaced = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character);
            replaced = false;
        } else if !replaced {
            output.push('_');
            replaced = true;
        }
    }
    let trimmed = output.trim_matches('_');
    if trimmed.is_empty() {
        "entry".to_owned()
    } else {
        trimmed.to_owned()
    }
}

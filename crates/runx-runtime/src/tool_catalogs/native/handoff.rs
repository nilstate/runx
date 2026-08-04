use std::collections::BTreeMap;
use std::net::IpAddr;

use runx_contracts::{
    JsonObject, JsonValue, OrchestratorExecutionContext, OrchestratorHandoffBinding,
    OrchestratorHandoffContext, OrchestratorHandoffDelivery, OrchestratorHandoffIdempotency,
    OrchestratorHandoffRequest, OrchestratorReceiptExpectations, OrchestratorReceiverValidation,
};
use serde::{Deserialize, Serialize};

use crate::{
    CapabilityAdmission, CapabilityApproval, CapabilityArtifacts, CapabilityDefinition,
    CapabilityEffect, CapabilityField, CapabilityInput, CapabilityOutput, RuntimeError,
};

use super::capability::{NativeCapability, TypedNativeCapability};
use super::{NativeInvocation, invalid_input};

const TOOL: &str = "control.prepare_handoff";

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct HandoffInput {
    platform: String,
    event_id: String,
    handoff_scope: String,
    handoff_audience: String,
    execution_context: OrchestratorExecutionContext,
    payload: JsonValue,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    receiver: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request: Option<HandoffRequestInput>,
}

impl CapabilityInput for HandoffInput {
    fn defaults() -> JsonObject {
        JsonObject::from([("source".to_owned(), JsonValue::String("runx".to_owned()))])
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct HandoffOutput {
    handoff_context: OrchestratorHandoffContext,
}

impl CapabilityOutput for HandoffOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct HandoffRequestInput {
    id: String,
    url: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    path: BTreeMap<String, String>,
}

const FIELDS: &[CapabilityField] = &[
    field(
        "platform",
        "Workflow platform label bound into the handoff.",
    ),
    field("event_id", "Stable receiver-side deduplication identity."),
    field(
        "handoff_scope",
        "Exact provider scope asserted by the handoff.",
    ),
    field(
        "handoff_audience",
        "Exact provider audience receiving the handoff.",
    ),
    field(
        "execution_context",
        "Caller, workflow, principal, or upstream-run context with provider extensions preserved.",
    ),
    field(
        "payload",
        "Business payload passed through without shape guessing.",
    ),
    field("source", "Human-readable handoff source label."),
    field(
        "receiver",
        "Optional receiver metadata and HTTPS endpoint reference.",
    ),
    field(
        "request",
        "Optional exact HTTPS webhook request template; native preparation binds the canonical delivery body and Runx handoff headers.",
    ),
];

const fn field(name: &'static str, description: &'static str) -> CapabilityField {
    CapabilityField { name, description }
}

static PREPARE: TypedNativeCapability<HandoffInput, HandoffOutput> = TypedNativeCapability::new(
    CapabilityDefinition {
        id: TOOL,
        owner: "runx-runtime/control",
        summary: "Validate and normalize a provider-neutral workflow handoff without performing network I/O.",
        scopes: &[],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Named {
            output: "handoff_context",
            packet: "runx.orchestrator.handoff_context.v1",
        },
        admission: CapabilityAdmission::ReusedBy(&["n8n-handoff", "zapier-handoff"]),
        fields: FIELDS,
    },
    prepare,
);

pub(in crate::tool_catalogs::native) const CAPABILITIES: &[&dyn NativeCapability] = &[&PREPARE];

fn prepare(invocation: &NativeInvocation<'_, HandoffInput>) -> Result<HandoffOutput, RuntimeError> {
    reject_delivered_credential_material(invocation.inputs, invocation)?;
    prepare_input(invocation.inputs)
}

fn prepare_input(input: &HandoffInput) -> Result<HandoffOutput, RuntimeError> {
    let platform = non_empty("platform", &input.platform)?;
    if platform.len() > 64
        || !platform
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(invalid_input(
            TOOL,
            "platform must be 1-64 ASCII letters, numbers, dashes, or underscores",
        ));
    }
    let event_id = non_empty("event_id", &input.event_id)?;
    if !(3..=200).contains(&event_id.len())
        || !event_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
    {
        return Err(invalid_input(
            TOOL,
            "event_id must be 3-200 ASCII letters, numbers, dots, underscores, colons, or dashes",
        ));
    }
    let scope = non_empty("handoff_scope", &input.handoff_scope)?;
    if !scope.starts_with(&format!("orchestrator.{platform}.")) || unsafe_claim(scope) {
        return Err(invalid_input(
            TOOL,
            format!("handoff_scope must start with orchestrator.{platform}."),
        ));
    }
    let audience = non_empty("handoff_audience", &input.handoff_audience)?;
    if !audience.starts_with(&format!("{platform}:"))
        || audience.len() <= platform.len() + 1
        || unsafe_claim(audience)
    {
        return Err(invalid_input(
            TOOL,
            format!("handoff_audience must start with {platform}: and include a receiver id"),
        ));
    }
    let source = if input.source.trim().is_empty() {
        "runx"
    } else {
        input.source.trim()
    };
    let idempotency_key = event_id;
    if !input.execution_context.identifies_origin() {
        return Err(invalid_input(
            TOOL,
            "execution_context must identify the caller, workflow, principal, or upstream run",
        ));
    }
    if let Some((field, expected)) = input
        .execution_context
        .binding_mismatches(platform, event_id, idempotency_key, scope, audience)
        .into_iter()
        .next()
    {
        return Err(invalid_input(
            TOOL,
            format!("execution_context.{field} must match {expected}"),
        ));
    }
    validate_payload(&input.payload)?;
    validate_receiver(input.receiver.as_ref())?;

    let mut execution_context = input.execution_context.clone();
    execution_context.bind_handoff(platform, event_id, idempotency_key, scope, audience);
    let delivery = OrchestratorHandoffDelivery {
        event_id: event_id.to_owned(),
        handoff_scope: scope.to_owned(),
        handoff_audience: audience.to_owned(),
        execution_context: execution_context.clone(),
        payload: input.payload.clone(),
        source: source.to_owned(),
        idempotency_key: idempotency_key.to_owned(),
    };
    let requests = input
        .request
        .as_ref()
        .map(|request| prepare_request(request, scope, audience, event_id, &delivery))
        .transpose()?
        .into_iter()
        .collect();
    Ok(HandoffOutput {
        handoff_context: OrchestratorHandoffContext {
            status: "ready".to_owned(),
            platform: platform.to_owned(),
            event_id: event_id.to_owned(),
            idempotency: OrchestratorHandoffIdempotency {
                key: idempotency_key.to_owned(),
                receiver_should_dedupe: true,
            },
            handoff: OrchestratorHandoffBinding {
                scope: scope.to_owned(),
                audience: audience.to_owned(),
                source: source.to_owned(),
            },
            receiver: input.receiver.clone(),
            delivery,
            receiver_validation: OrchestratorReceiverValidation {
                require_bearer: true,
                require_scope: scope.to_owned(),
                require_audience: audience.to_owned(),
                require_event_id: event_id.to_owned(),
                reject_duplicate_event_id: true,
            },
            receipt_expectations: OrchestratorReceiptExpectations {
                context_artifact: "handoff_context".to_owned(),
                outbound_effect_must_be_receipted: true,
                receiver_response_must_be_captured: true,
                delivered_credential_material_absent: true,
            },
            requests,
            stop_conditions: Vec::new(),
        },
    })
}

fn prepare_request(
    request: &HandoffRequestInput,
    scope: &str,
    audience: &str,
    event_id: &str,
    delivery: &OrchestratorHandoffDelivery,
) -> Result<OrchestratorHandoffRequest, RuntimeError> {
    let id = non_empty("request.id", &request.id)?;
    if id.len() > 128
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err(invalid_input(
            TOOL,
            "request.id must be 1-128 ASCII letters, numbers, dots, underscores, or dashes",
        ));
    }
    let url = non_empty("request.url", &request.url)?;
    if !url.starts_with("https://") || url.chars().any(char::is_whitespace) {
        return Err(invalid_input(
            TOOL,
            "request.url must be an HTTPS URL or HTTPS URL template without whitespace",
        ));
    }
    if request
        .path
        .iter()
        .any(|(key, value)| key.trim().is_empty() || value.trim().is_empty())
    {
        return Err(invalid_input(
            TOOL,
            "request.path keys and values must not be empty",
        ));
    }
    Ok(OrchestratorHandoffRequest {
        id: id.to_owned(),
        method: "POST".to_owned(),
        url: url.to_owned(),
        path: request.path.clone(),
        headers: BTreeMap::from([
            ("content-type".to_owned(), "application/json".to_owned()),
            ("x-runx-event-id".to_owned(), event_id.to_owned()),
            ("x-runx-handoff-audience".to_owned(), audience.to_owned()),
            ("x-runx-handoff-scope".to_owned(), scope.to_owned()),
        ]),
        body: delivery.clone(),
    })
}

fn non_empty<'a>(field: &str, value: &'a str) -> Result<&'a str, RuntimeError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(invalid_input(TOOL, format!("{field} must not be empty")));
    }
    Ok(value)
}

fn unsafe_claim(value: &str) -> bool {
    value.chars().any(char::is_whitespace) || value.contains('{') || value.contains('}')
}

fn reject_delivered_credential_material(
    input: &HandoffInput,
    invocation: &NativeInvocation<'_, HandoffInput>,
) -> Result<(), RuntimeError> {
    let context = &input.execution_context;
    for text in [
        Some(input.platform.as_str()),
        Some(input.event_id.as_str()),
        Some(input.handoff_scope.as_str()),
        Some(input.handoff_audience.as_str()),
        Some(input.source.as_str()),
        context.caller.as_deref(),
        context.caller_id.as_deref(),
        context.principal.as_deref(),
        context.principal_id.as_deref(),
        context.workflow.as_deref(),
        context.workflow_id.as_deref(),
        context.workflow_ref.as_deref(),
        context.source_workflow.as_deref(),
        context.upstream_execution_id.as_deref(),
        context.upstream_run_id.as_deref(),
        context.platform.as_deref(),
        context.event_id.as_deref(),
        context.idempotency_key.as_deref(),
        context.handoff_scope.as_deref(),
        context.handoff_audience.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        reject_delivered_credential_text(text, invocation)?;
    }
    reject_delivered_credential_json(&input.payload, invocation, 0)?;
    reject_delivered_credential_object(&context.extensions, invocation, 0)?;
    if let Some(receiver) = &input.receiver {
        reject_delivered_credential_object(receiver, invocation, 0)?;
    }
    if let Some(request) = &input.request {
        reject_delivered_credential_text(&request.id, invocation)?;
        reject_delivered_credential_text(&request.url, invocation)?;
        for (key, value) in &request.path {
            reject_delivered_credential_text(key, invocation)?;
            reject_delivered_credential_text(value, invocation)?;
        }
    }
    Ok(())
}

fn reject_delivered_credential_json(
    value: &JsonValue,
    invocation: &NativeInvocation<'_, HandoffInput>,
    depth: usize,
) -> Result<(), RuntimeError> {
    if depth >= 64 {
        return Err(invalid_input(
            TOOL,
            "handoff material exceeds the credential-scan nesting limit",
        ));
    }
    match value {
        JsonValue::String(text) => {
            reject_delivered_credential_text(text, invocation)?;
        }
        JsonValue::Array(values) => {
            for value in values {
                reject_delivered_credential_json(value, invocation, depth + 1)?;
            }
        }
        JsonValue::Object(object) => reject_delivered_credential_object(object, invocation, depth)?,
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => {}
    }
    Ok(())
}

fn reject_delivered_credential_object(
    object: &JsonObject,
    invocation: &NativeInvocation<'_, HandoffInput>,
    depth: usize,
) -> Result<(), RuntimeError> {
    for (key, value) in object {
        reject_delivered_credential_text(key, invocation)?;
        reject_delivered_credential_json(value, invocation, depth + 1)?;
    }
    Ok(())
}

fn reject_delivered_credential_text(
    text: &str,
    invocation: &NativeInvocation<'_, HandoffInput>,
) -> Result<(), RuntimeError> {
    if invocation.credential_delivery.redact_text(text) != text {
        return Err(invalid_input(
            TOOL,
            "handoff material contains credential data delivered by Runx; use credential-bound provider auth instead",
        ));
    }
    Ok(())
}

fn validate_payload(payload: &JsonValue) -> Result<(), RuntimeError> {
    if matches!(payload, JsonValue::Null)
        || payload
            .as_str()
            .is_some_and(|value| value.trim().is_empty())
    {
        return Err(invalid_input(TOOL, "payload must not be empty"));
    }
    Ok(())
}

fn validate_receiver(receiver: Option<&JsonObject>) -> Result<(), RuntimeError> {
    let Some(receiver) = receiver else {
        return Ok(());
    };
    let Some(raw_url) = receiver.get("url") else {
        return Ok(());
    };
    let Some(raw_url) = raw_url.as_str() else {
        return Err(invalid_input(TOOL, "receiver.url must be an HTTPS URL"));
    };
    let parsed = url::Url::parse(raw_url)
        .map_err(|_| invalid_input(TOOL, "receiver.url must be a valid HTTPS URL"))?;
    if parsed.scheme() != "https" {
        return Err(invalid_input(TOOL, "receiver.url must use HTTPS"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| invalid_input(TOOL, "receiver.url must include a public host"))?;
    if host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
    {
        return Err(invalid_input(TOOL, "receiver.url must not be loopback"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use std::collections::BTreeMap;

    use runx_contracts::OrchestratorExecutionContext;
    use serde_json::json;

    #[cfg(feature = "catalog")]
    use crate::RuntimeEffectRegistry;
    use crate::credentials::CredentialDelivery;
    use crate::tool_catalogs::native::NativeInvocation;

    use super::{HandoffInput, HandoffRequestInput, prepare, prepare_input};

    fn value(value: serde_json::Value) -> runx_contracts::JsonValue {
        serde_json::from_value(value).expect("portable test JSON")
    }

    fn input() -> HandoffInput {
        serde_json::from_value(json!({
            "platform": "n8n",
            "event_id": "evt_demo_001",
            "handoff_scope": "orchestrator.n8n.workflow.invoke",
            "handoff_audience": "n8n:workflow:demo",
            "execution_context": { "caller": "runx-cli", "environment": "local" },
            "payload": { "token": "business-domain-value" },
            "source": "runx"
        }))
        .expect("handoff input")
    }

    #[test]
    fn prepares_one_exact_delivery_envelope_without_guessing_payload_shape() {
        let output = prepare_input(&input()).expect("prepared handoff");
        assert_eq!(output.handoff_context.status, "ready");
        assert_eq!(output.handoff_context.idempotency.key, "evt_demo_001");
        assert_eq!(
            output.handoff_context.delivery.payload,
            value(json!({ "token": "business-domain-value" }))
        );
        assert_eq!(
            output
                .handoff_context
                .delivery
                .execution_context
                .platform
                .as_deref(),
            Some("n8n")
        );
        assert!(output.handoff_context.requests.is_empty());
    }

    #[test]
    fn prepares_the_exact_http_request_from_the_same_delivery_value() {
        let mut input = input();
        input.request = Some(HandoffRequestInput {
            id: "n8n-handoff".to_owned(),
            url: "https://{webhook_host}/webhook/{workflow_slug}".to_owned(),
            path: BTreeMap::from([
                ("webhook_host".to_owned(), "n8n.example.com".to_owned()),
                ("workflow_slug".to_owned(), "runx-effect".to_owned()),
            ]),
        });
        let output = prepare_input(&input).expect("prepared handoff");
        let request = output
            .handoff_context
            .requests
            .first()
            .expect("prepared request");
        assert_eq!(request.method, "POST");
        assert_eq!(
            request.body.payload,
            value(json!({ "token": "business-domain-value" }))
        );
        assert_eq!(request.body, output.handoff_context.delivery);
        assert_eq!(
            request.headers["x-runx-handoff-audience"],
            "n8n:workflow:demo"
        );
    }

    #[test]
    fn rejects_context_binding_mismatch() {
        let mut input = input();
        input.execution_context = OrchestratorExecutionContext {
            caller: Some("runx-cli".to_owned()),
            event_id: Some("evt_other".to_owned()),
            ..OrchestratorExecutionContext::default()
        };
        let error = prepare_input(&input).expect_err("mismatch refused");
        assert!(error.to_string().contains("execution_context.event_id"));
    }

    #[test]
    fn rejects_loopback_receiver_metadata() {
        let mut input = input();
        input.receiver = Some(
            serde_json::from_value(json!({
                "url": "https://127.0.0.1/hook"
            }))
            .expect("receiver"),
        );
        let error = prepare_input(&input).expect_err("loopback refused");
        assert!(error.to_string().contains("must not be loopback"));
    }

    #[test]
    fn credential_guard_rejects_delivered_values_without_guessing_business_keys()
    -> Result<(), Box<dyn std::error::Error>> {
        let workspace = tempfile::tempdir()?;
        let delivery = CredentialDelivery::from_local_descriptor(
            "n8n",
            "bearer",
            "N8N_WEBHOOK_TOKEN",
            "local:n8n:test",
            vec!["orchestrator.n8n.workflow.invoke".to_owned()],
            "credential-sentinel",
        )?;
        let env = BTreeMap::new();
        #[cfg(feature = "catalog")]
        let effects = RuntimeEffectRegistry::default();
        let mut allowed = input();
        allowed.payload = value(json!({ "token": "business-domain-value" }));
        let invocation = NativeInvocation {
            inputs: &allowed,
            observed_at: "2026-01-01T00:00:00Z",
            data_source_binding: None,
            env: &env,
            skill_directory: workspace.path(),
            credential_delivery: &delivery,
            local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
            #[cfg(feature = "catalog")]
            effects: &effects,
        };
        prepare(&invocation).expect("business token field remains valid");

        let mut rejected = input();
        rejected.payload = value(json!({ "value": "credential-sentinel" }));
        let invocation = NativeInvocation {
            inputs: &rejected,
            observed_at: "2026-01-01T00:00:00Z",
            data_source_binding: None,
            env: &env,
            skill_directory: workspace.path(),
            credential_delivery: &delivery,
            local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
            #[cfg(feature = "catalog")]
            effects: &effects,
        };
        let error = prepare(&invocation).expect_err("delivered credential value refused");
        assert!(error.to_string().contains("contains credential data"));
        Ok(())
    }
}

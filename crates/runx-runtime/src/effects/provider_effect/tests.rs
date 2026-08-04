#![allow(clippy::expect_used)]

use runx_contracts::{JsonObject, JsonValue};

use super::*;

#[test]
fn provider_effect_read_reaches_finality_without_approval() {
    let resolved = resolved(ProviderEffectClass::Read, None);
    let attempt = resolved.begin(None).expect("read attempt");
    let acknowledged = attempt
        .acknowledge(ack(None, None))
        .expect("read acknowledgement");
    let finality = acknowledged
        .readback(readback(None, "runx:readback:1", JsonValue::Bool(true)))
        .expect("readback")
        .finalize();

    assert_eq!(finality.readback_ref(), "runx:readback:1");
    assert!(finality.operation_id().is_none());
}

#[test]
fn provider_effect_draft_cannot_attempt_or_request_approval() {
    let resolved = resolved(ProviderEffectClass::Draft, None);
    assert_eq!(
        resolved.begin(None),
        Err(ProviderEffectError::DraftCannotExecute)
    );
}

#[test]
fn provider_effect_mutation_requires_exact_approval() {
    let resolved = resolved(ProviderEffectClass::Mutation, Some("request-1"));
    assert_eq!(
        resolved.clone().begin(None),
        Err(ProviderEffectError::ApprovalRequired)
    );
    let approval = ProviderApprovalEvidence {
        actor: "human".to_owned(),
        approval_key: "sha256:approval".to_owned(),
        plan_digest: resolved.plan_digest().to_owned(),
    };
    assert!(resolved.begin(Some(approval)).is_ok());
}

#[test]
fn provider_effect_rejects_gratuitous_read_approval() {
    let resolved = resolved(ProviderEffectClass::Read, None);
    let approval = ProviderApprovalEvidence {
        actor: "human".to_owned(),
        approval_key: "sha256:approval".to_owned(),
        plan_digest: resolved.plan_digest().to_owned(),
    };
    assert_eq!(
        resolved.begin(Some(approval)),
        Err(ProviderEffectError::GratuitousApproval {
            class: ProviderEffectClass::Read,
        })
    );
}

#[test]
fn provider_effect_rejects_approval_digest_drift() {
    let resolved = resolved(ProviderEffectClass::Mutation, Some("request-1"));
    let approval = ProviderApprovalEvidence {
        actor: "human".to_owned(),
        approval_key: "sha256:approval".to_owned(),
        plan_digest: "sha256:other".to_owned(),
    };
    assert_eq!(
        resolved.begin(Some(approval)),
        Err(ProviderEffectError::ApprovalDrift)
    );
}

#[test]
fn provider_effect_duplicate_retry_reuses_idempotency() {
    let attempt = mutation_attempt();
    let key = attempt.idempotency_key().to_owned();
    let retried = attempt.unknown("timeout after write").retry();

    assert_eq!(retried.idempotency_key(), key);
    assert_eq!(retried.attempt(), 2);
}

#[test]
fn provider_effect_ack_without_readback_cannot_finalize() {
    let acknowledged = mutation_attempt()
        .acknowledge(ack(
            Some("provider-operation-1"),
            Some(mutation_idempotency().as_str()),
        ))
        .expect("acknowledgement");

    assert_eq!(
        acknowledged.readback(readback(
            Some("provider-operation-1"),
            "",
            JsonValue::Bool(true),
        )),
        Err(ProviderEffectError::MissingReadback)
    );
}

#[test]
fn provider_effect_rejects_identity_mismatched_readback() {
    let attempt = mutation_attempt();
    let key = attempt.idempotency_key().to_owned();
    let acknowledged = attempt
        .acknowledge(ack(Some("provider-operation-1"), Some(&key)))
        .expect("acknowledgement");
    let mut evidence = readback(
        Some("provider-operation-1"),
        "runx:readback:1",
        JsonValue::Bool(true),
    );
    evidence.provider = "github".to_owned();

    assert_eq!(
        acknowledged.readback(evidence),
        Err(ProviderEffectError::ReadbackMismatch { field: "provider" })
    );
}

#[test]
fn provider_effect_timeout_is_unknown_until_same_key_recovers() {
    let attempt = mutation_attempt();
    let key = attempt.idempotency_key().to_owned();
    let unknown = attempt.unknown("provider timeout");
    assert_eq!(unknown.reason(), "provider timeout");
    let retry = unknown.retry();
    let acknowledged = retry
        .acknowledge(ack(Some("provider-operation-1"), Some(&key)))
        .expect("recovered acknowledgement");
    let finality = acknowledged
        .readback(readback(
            Some("provider-operation-1"),
            "runx:readback:provider-operation-1",
            JsonValue::Bool(true),
        ))
        .expect("recovered readback")
        .finalize();

    assert_eq!(finality.idempotency_key(), key);
    assert_eq!(finality.operation_id(), Some("provider-operation-1"));
}

#[test]
fn provider_effect_plan_stores_payload_digest_not_secret_material() {
    let secret = "credential-material-must-not-escape";
    let payload = JsonObject::from([(
        "credential".to_owned(),
        JsonValue::String(secret.to_owned()),
    )]);
    let intent = ProviderEffectIntent::new(ProviderEffectIntentInput {
        class: ProviderEffectClass::Mutation,
        provider: "slack",
        operation: "thread.reply",
        target: "slack://workspace/channel/thread",
        payload: &payload,
        required_scopes: vec!["thread.reply".to_owned()],
        amount: None,
        request_key: Some("request-1"),
    })
    .expect("intent");
    let resolved = ProviderEffectResolved::new(
        intent,
        ProviderEffectAuthority::new("grant-1", "runx:principal:operator").expect("authority"),
    )
    .expect("resolved");
    let debug = format!("{resolved:?}");
    let summary = serde_json::to_string(&resolved.approval_summary()).expect("summary");

    assert!(!debug.contains(secret));
    assert!(!summary.contains(secret));
}

#[test]
fn provider_effect_preserves_opaque_capabilities_without_normalizing_them() {
    let required_scopes = vec![
        "vendor.operation:v3".to_owned(),
        "https://provider.example/auth/custom.scope?mode=read,write".to_owned(),
        "opaque capability with spaces".to_owned(),
        "vendor.operation:v3".to_owned(),
    ];
    let intent = ProviderEffectIntent::new(ProviderEffectIntentInput {
        class: ProviderEffectClass::Read,
        provider: "future-provider",
        operation: "future.read",
        target: "future://account",
        payload: &JsonObject::new(),
        required_scopes: required_scopes.clone(),
        amount: None,
        request_key: None,
    })
    .expect("intent");

    assert_eq!(intent.required_scopes(), required_scopes);
}

fn resolved(class: ProviderEffectClass, request_key: Option<&str>) -> ProviderEffectResolved {
    let payload = JsonObject::from([("text".to_owned(), JsonValue::String("hello".to_owned()))]);
    let intent = ProviderEffectIntent::new(ProviderEffectIntentInput {
        class,
        provider: "slack",
        operation: "thread.reply",
        target: "slack://workspace/channel/thread",
        payload: &payload,
        required_scopes: vec!["thread.reply".to_owned()],
        amount: None,
        request_key,
    })
    .expect("intent");
    ProviderEffectResolved::new(
        intent,
        ProviderEffectAuthority::new("grant-1", "runx:principal:operator").expect("authority"),
    )
    .expect("resolved")
}

fn mutation_attempt() -> ProviderEffectAttempt {
    let resolved = resolved(ProviderEffectClass::Mutation, Some("request-1"));
    let approval = ProviderApprovalEvidence {
        actor: "human".to_owned(),
        approval_key: "sha256:approval".to_owned(),
        plan_digest: resolved.plan_digest().to_owned(),
    };
    resolved.begin(Some(approval)).expect("mutation attempt")
}

fn mutation_idempotency() -> String {
    mutation_attempt().idempotency_key().to_owned()
}

fn ack(
    operation_id: Option<&str>,
    idempotency_key: Option<&str>,
) -> ProviderAcknowledgementEvidence {
    ProviderAcknowledgementEvidence {
        provider: "slack".to_owned(),
        operation: "thread.reply".to_owned(),
        target: "slack://workspace/channel/thread".to_owned(),
        operation_id: operation_id.map(str::to_owned),
        idempotency_key: idempotency_key.map(str::to_owned),
    }
}

fn readback(
    operation_id: Option<&str>,
    readback_ref: &str,
    result: JsonValue,
) -> ProviderEffectReadbackEvidence {
    ProviderEffectReadbackEvidence {
        provider: "slack".to_owned(),
        operation: "thread.reply".to_owned(),
        target: "slack://workspace/channel/thread".to_owned(),
        operation_id: operation_id.map(str::to_owned),
        readback_ref: readback_ref.to_owned(),
        result,
    }
}

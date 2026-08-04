#![allow(clippy::expect_used)]

use std::collections::BTreeMap;
use std::path::Path;

use runx_contracts::{JsonObject, JsonValue, ReferenceType};
use runx_parser::GraphStep;

#[cfg(feature = "catalog")]
use super::execution::*;
#[cfg(feature = "catalog")]
use super::identity::*;
#[cfg(feature = "catalog")]
use super::readback::*;
use super::*;
use crate::effects::ResolvedEffectTarget;
#[cfg(feature = "catalog")]
use crate::{
    HostedProviderGrant, ProviderAcknowledgementEvidence, ProviderApprovalEvidence,
    ProviderEffectAttempt, ProviderEffectAuthority, ProviderEffectClass, ProviderEffectFinality,
    ProviderEffectIntent, ProviderEffectIntentInput, ProviderEffectReadbackEvidence,
};

mod admission;
#[cfg(feature = "catalog")]
mod execution;

fn effect_request<'a>(
    step: &'a GraphStep,
    inputs: &'a JsonObject,
    env: &'a BTreeMap<String, String>,
) -> EffectStepRequest<'a> {
    EffectStepRequest {
        step,
        target: ResolvedEffectTarget {
            skill_name: None,
            tool_ref: step.tool.as_deref(),
        },
        inputs,
        env,
        graph_dir: Path::new("."),
    }
}

fn test_step(id: &str, scopes: &[&str], verb: &str) -> GraphStep {
    GraphStep {
        id: id.to_owned(),
        label: None,
        skill: None,
        tool: None,
        run: None,
        artifacts: None,
        outputs: None,
        runner: None,
        inputs: JsonObject::new(),
        context: BTreeMap::new(),
        context_edges: Vec::new(),
        context_skills: Vec::new(),
        scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
        allowed_tools: None,
        retry: None,
        policy: Some(JsonObject::from([(
            PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            JsonValue::Object(JsonObject::from([
                (
                    "grant_id".to_owned(),
                    JsonValue::String("github-mcp-read".to_owned()),
                ),
                ("verb".to_owned(), JsonValue::String(verb.to_owned())),
            ])),
        )])),
        fanout_group: None,
        when: None,
        mutating: verb != "read",
        idempotency_key: Some(format!("{id}-key")),
        mint_authority: None,
        requested_scope_from: None,
    }
}

fn native_step(tool: &str, scopes: &[&str], verb: &str) -> GraphStep {
    let mut step = test_step("provider_operation", scopes, verb);
    step.tool = Some(tool.to_owned());
    step
}

fn provider_inputs(operation: &str) -> JsonObject {
    let mut inputs = JsonObject::from([
        (
            "expected_provider".to_owned(),
            JsonValue::String("slack".to_owned()),
        ),
        (
            "operation".to_owned(),
            JsonValue::String(operation.to_owned()),
        ),
        (
            "target".to_owned(),
            JsonValue::String("slack://workspace".to_owned()),
        ),
    ]);
    inputs.insert(
        "idempotency_key".to_owned(),
        JsonValue::String("request-1".to_owned()),
    );
    inputs
}

fn provider_env(grant_id: &str, scopes: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            PROVIDER_PERMISSION_GRANT_ID_ENV.to_owned(),
            grant_id.to_owned(),
        ),
        (
            PROVIDER_PERMISSION_GRANTED_SCOPES_ENV.to_owned(),
            encode_provider_scopes_env(&[scopes.to_owned()]).expect("scope transport"),
        ),
        (
            PROVIDER_PERMISSION_PRINCIPAL_REF_ENV.to_owned(),
            "runx:principal:operator:test".to_owned(),
        ),
    ])
}

fn policy_mut(step: &mut GraphStep) -> &mut JsonObject {
    step.policy
        .as_mut()
        .and_then(|policy| policy.get_mut(PROVIDER_PERMISSION_EFFECT_FAMILY))
        .and_then(|value| match value {
            JsonValue::Object(policy) => Some(policy),
            _ => None,
        })
        .expect("provider policy")
}

fn assert_policy_error(error: RuntimeEffectError, needle: &str) {
    assert!(
        matches!(error, RuntimeEffectError::Failed { ref family, operation: "parse provider permission policy", ref message }
            if family == PROVIDER_PERMISSION_EFFECT_FAMILY && message.contains(needle)),
        "unexpected policy error: {error:?}"
    );
}

#[cfg(feature = "catalog")]
fn test_provider_resolved(grant_id: &str, access: ProviderNativeAccess) -> ProviderEffectResolved {
    let class = match access {
        ProviderNativeAccess::Read => ProviderEffectClass::Read,
        ProviderNativeAccess::Mutate => ProviderEffectClass::Mutation,
    };
    let request_key = (access == ProviderNativeAccess::Mutate).then_some("request-1");
    ProviderEffectResolved::new(
        ProviderEffectIntent::new(ProviderEffectIntentInput {
            class,
            provider: "slack",
            operation: "messages.search",
            target: "slack://workspace",
            payload: &JsonObject::new(),
            required_scopes: vec!["messages.search".to_owned()],
            amount: None,
            request_key,
        })
        .expect("provider intent"),
        ProviderEffectAuthority::new(grant_id, "runx:principal:operator:test")
            .expect("provider authority"),
    )
    .expect("resolved provider effect")
}

#[cfg(feature = "catalog")]
fn test_provider_attempt(grant_id: &str, access: ProviderNativeAccess) -> ProviderEffectAttempt {
    let resolved = test_provider_resolved(grant_id, access);
    let approval = (access == ProviderNativeAccess::Mutate).then(|| ProviderApprovalEvidence {
        actor: "human".to_owned(),
        approval_key: "sha256:approval".to_owned(),
        plan_digest: resolved.plan_digest().to_owned(),
    });
    resolved.begin(approval).expect("provider attempt")
}

#[cfg(feature = "catalog")]
fn test_provider_finality(grant_id: &str, access: ProviderNativeAccess) -> ProviderEffectFinality {
    let attempt = test_provider_attempt(grant_id, access);
    let idempotency_key = attempt.idempotency_key().to_owned();
    let operation_id =
        (access == ProviderNativeAccess::Mutate).then_some("provider-operation-1".to_owned());
    attempt
        .acknowledge(ProviderAcknowledgementEvidence {
            provider: "slack".to_owned(),
            operation: "messages.search".to_owned(),
            target: "slack://workspace".to_owned(),
            operation_id: operation_id.clone(),
            idempotency_key: (access == ProviderNativeAccess::Mutate).then_some(idempotency_key),
        })
        .expect("provider acknowledgement")
        .readback(ProviderEffectReadbackEvidence {
            provider: "slack".to_owned(),
            operation: "messages.search".to_owned(),
            target: "slack://workspace".to_owned(),
            operation_id,
            readback_ref: "runx:readback:1".to_owned(),
            result: JsonValue::Object(JsonObject::new()),
        })
        .expect("provider readback")
        .finalize()
}

#[cfg(feature = "catalog")]
fn hosted_grant(
    grant_id: &str,
    provider: &str,
    scopes: &[&str],
    status: &str,
) -> HostedProviderGrant {
    HostedProviderGrant {
        grant_id: grant_id.to_owned(),
        provider: provider.to_owned(),
        scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
        status: status.to_owned(),
    }
}

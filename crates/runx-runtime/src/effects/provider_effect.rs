//! Closed provider-effect transitions shared by every hosted provider driver.
//!
//! The state types deliberately do not implement `Deserialize`: provider and
//! approval wire evidence enters through the bounded evidence structs and can
//! advance only after identity and digest checks pass.

use runx_contracts::{JsonObject, JsonValue};
use serde::{Deserialize, Serialize};
use thiserror::Error;

mod intent;
mod transition;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderEffectClass {
    Read,
    Draft,
    Mutation,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderEffectAmount {
    pub units: u64,
    pub unit: String,
}

#[derive(Clone, Debug)]
pub struct ProviderEffectIntentInput<'a> {
    pub class: ProviderEffectClass,
    pub provider: &'a str,
    pub operation: &'a str,
    pub target: &'a str,
    pub payload: &'a JsonObject,
    pub required_scopes: Vec<String>,
    pub amount: Option<ProviderEffectAmount>,
    pub request_key: Option<&'a str>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderEffectIntent {
    class: ProviderEffectClass,
    provider: String,
    operation: String,
    target: String,
    payload_digest: String,
    required_scopes: Vec<String>,
    amount: Option<ProviderEffectAmount>,
    request_key_digest: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderEffectAuthority {
    grant_id: String,
    principal_ref: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderEffectResolved {
    intent: ProviderEffectIntent,
    authority: ProviderEffectAuthority,
    plan_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderEffectApproval {
    actor: String,
    approval_key: String,
    plan_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderEffectAttempt {
    resolved: ProviderEffectResolved,
    approval: Option<ProviderEffectApproval>,
    idempotency_key: String,
    attempt: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderEffectAcknowledged {
    attempt: ProviderEffectAttempt,
    operation_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderEffectReadback {
    acknowledgement: ProviderEffectAcknowledged,
    readback_ref: String,
    result_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderEffectFinality {
    plan_digest: String,
    idempotency_key: String,
    operation_id: Option<String>,
    readback_ref: String,
    result_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderEffectUnknown {
    attempt: ProviderEffectAttempt,
    reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderApprovalEvidence {
    pub actor: String,
    pub approval_key: String,
    pub plan_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderAcknowledgementEvidence {
    pub provider: String,
    pub operation: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderEffectReadbackEvidence {
    pub provider: String,
    pub operation: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub readback_ref: String,
    pub result: JsonValue,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ProviderEffectError {
    #[error("provider effect {field} must be a safe non-empty value")]
    InvalidField { field: &'static str },
    #[error("provider effect requires at least one explicit scope")]
    MissingScopes,
    #[error("draft provider effects cannot be attempted")]
    DraftCannotExecute,
    #[error("provider mutation requires exact approval")]
    ApprovalRequired,
    #[error("provider mutation approval actor is not an admitted authority lane")]
    ApprovalActorInvalid,
    #[error("provider {class:?} must not carry an approval")]
    GratuitousApproval { class: ProviderEffectClass },
    #[error("provider approval digest does not match the resolved effect")]
    ApprovalDrift,
    #[error("provider recovery attempt must follow at least one prior attempt")]
    InvalidRecoveryAttempt,
    #[error("provider acknowledgement is missing {field}")]
    MissingAcknowledgement { field: &'static str },
    #[error("provider acknowledgement does not match {field}")]
    AcknowledgementMismatch { field: &'static str },
    #[error("provider readback is missing an opaque readback reference")]
    MissingReadback,
    #[error("provider readback does not match {field}")]
    ReadbackMismatch { field: &'static str },
    #[error("provider effect digest serialization failed: {0}")]
    Digest(String),
}

#[cfg(test)]
mod tests;

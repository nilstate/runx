use runx_contracts::{JsonObject, JsonValue, sha256_prefixed};
use runx_receipts::canonical_stable_json;

use super::{NativeInvocation, invalid_input};
use crate::RuntimeError;

mod capability;
mod evidence;
mod output;

use capability::AttestationInput;
pub(super) use capability::CAPABILITIES;
use output::AttestationOutput;

use super::capability::decode_typed_output;
use evidence::parse_evidence;

const TOOL: &str = "receipt.attest";
const MAX_ACTION_BYTES: usize = 2_000;
const MAX_PRINCIPAL_BYTES: usize = 512;
const MAX_CLAIM_BYTES: usize = 4_000;
const MAX_EVIDENCE: usize = 100;
const MAX_REF_BYTES: usize = 512;
const MAX_PROVES_BYTES: usize = 1_000;

fn prepare(
    invocation: &NativeInvocation<'_, AttestationInput>,
) -> Result<AttestationOutput, RuntimeError> {
    decode_typed_output(TOOL, build(invocation.inputs)?)
}

fn build(inputs: &AttestationInput) -> Result<JsonValue, RuntimeError> {
    let action = bounded_text(&inputs.action, "action", MAX_ACTION_BYTES)?;
    let principal = bounded_text(&inputs.principal, "principal", MAX_PRINCIPAL_BYTES)?;
    let claim = bounded_text(&inputs.claim, "claim", MAX_CLAIM_BYTES)?;
    let scope = inputs.scope.clone().unwrap_or_default();
    let mut gaps = Vec::new();
    require(
        &action,
        "attestation.action.missing",
        "action is required",
        &mut gaps,
    );
    require(
        &principal,
        "attestation.principal.missing",
        "principal is required",
        &mut gaps,
    );
    require(
        &claim,
        "attestation.claim.missing",
        "claim is required",
        &mut gaps,
    );
    let evidence_refs = parse_evidence(&inputs.evidence, &mut gaps);
    let decision = attestation_decision(&gaps);
    let digest = attestation_digest(&action, &claim, &principal, &evidence_refs, &scope)?;

    Ok(render_attestation(AttestationProjection {
        action,
        claim,
        principal,
        evidence_refs,
        scope,
        decision,
        digest,
        gaps,
    }))
}

fn attestation_decision(gaps: &[JsonValue]) -> &'static str {
    if gaps.is_empty() {
        return "ready_to_seal";
    }
    let missing_subject = gaps.iter().any(|finding| {
        finding
            .as_object()
            .and_then(|finding| finding.get("code"))
            .and_then(JsonValue::as_str)
            .is_some_and(|code| code.ends_with(".missing"))
    });
    if missing_subject {
        "needs_agent"
    } else {
        "needs_more_evidence"
    }
}

fn attestation_digest(
    action: &str,
    claim: &str,
    principal: &str,
    evidence_refs: &[JsonValue],
    scope: &JsonObject,
) -> Result<String, RuntimeError> {
    let core = JsonValue::Object(JsonObject::from([
        ("action".to_owned(), JsonValue::String(action.to_owned())),
        ("claim".to_owned(), JsonValue::String(claim.to_owned())),
        (
            "principal".to_owned(),
            JsonValue::String(principal.to_owned()),
        ),
        (
            "evidence_refs".to_owned(),
            JsonValue::Array(evidence_refs.to_vec()),
        ),
        ("scope".to_owned(), JsonValue::Object(scope.clone())),
    ]));
    let canonical = canonical_stable_json(&core).map_err(|error| {
        invalid_input(
            TOOL,
            format!("attestation canonicalization failed: {error}"),
        )
    })?;
    Ok(sha256_prefixed(canonical.as_bytes()))
}

struct AttestationProjection {
    action: String,
    claim: String,
    principal: String,
    evidence_refs: Vec<JsonValue>,
    scope: JsonObject,
    decision: &'static str,
    digest: String,
    gaps: Vec<JsonValue>,
}

// Function rationale: this is the declarative projection of
// one stable attestation packet; admission and digest decisions are upstream.
fn render_attestation(projection: AttestationProjection) -> JsonValue {
    JsonValue::Object(JsonObject::from([(
        "attestation".to_owned(),
        JsonValue::Object(JsonObject::from([
            (
                "schema".to_owned(),
                JsonValue::String("runx.attestation.v1".to_owned()),
            ),
            (
                "decision".to_owned(),
                JsonValue::String(projection.decision.to_owned()),
            ),
            ("action".to_owned(), JsonValue::String(projection.action)),
            ("claim".to_owned(), JsonValue::String(projection.claim)),
            (
                "principal".to_owned(),
                JsonValue::String(projection.principal),
            ),
            (
                "evidence_refs".to_owned(),
                JsonValue::Array(projection.evidence_refs),
            ),
            ("scope".to_owned(), JsonValue::Object(projection.scope)),
            (
                "attestation_digest".to_owned(),
                JsonValue::String(projection.digest),
            ),
            ("gaps".to_owned(), JsonValue::Array(projection.gaps)),
            (
                "proof_boundary".to_owned(),
                JsonValue::Object(JsonObject::from([
                    (
                        "external_action_verified".to_owned(),
                        JsonValue::Bool(false),
                    ),
                    (
                        "provider_status".to_owned(),
                        JsonValue::String("not_called".to_owned()),
                    ),
                    (
                        "external_ledger_status".to_owned(),
                        JsonValue::String("not_requested".to_owned()),
                    ),
                    (
                        "runtime_seal_status".to_owned(),
                        JsonValue::String("pending_parent_receipt".to_owned()),
                    ),
                ])),
            ),
        ])),
    )]))
}
fn bounded_text(value: &str, field: &str, max_bytes: usize) -> Result<String, RuntimeError> {
    let value = value.trim();
    if value.len() > max_bytes {
        return Err(invalid_input(
            TOOL,
            format!("{field} exceeds the {max_bytes}-byte limit"),
        ));
    }
    Ok(value.to_owned())
}

fn bounded_item_text(
    item: &JsonObject,
    index: usize,
    field: &str,
    max_bytes: usize,
    gaps: &mut Vec<JsonValue>,
) -> String {
    let Some(value) = item.get(field).and_then(JsonValue::as_str) else {
        return String::new();
    };
    let value = value.trim();
    if value.len() > max_bytes {
        gap(
            gaps,
            "attestation.evidence.limit",
            format!("evidence[{index}].{field} exceeds the {max_bytes}-byte limit"),
        );
        return String::new();
    }
    value.to_owned()
}

fn require(value: &str, code: &str, message: &str, gaps: &mut Vec<JsonValue>) {
    if value.is_empty() {
        gap(gaps, code, message);
    }
}

fn gap(gaps: &mut Vec<JsonValue>, code: &str, message: impl Into<String>) {
    gaps.push(JsonValue::Object(JsonObject::from([
        ("code".to_owned(), JsonValue::String(code.to_owned())),
        ("message".to_owned(), JsonValue::String(message.into())),
    ])));
}

fn opaque_reference(value: &str) -> bool {
    !value.chars().any(char::is_whitespace)
        && !value.to_ascii_lowercase().starts_with("sk-")
        && !value.to_ascii_lowercase().starts_with("bearer")
        && !value.to_ascii_lowercase().starts_with("-----begin")
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests;

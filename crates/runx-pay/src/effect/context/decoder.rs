use runx_contracts::{
    AuthoritySubsetProof, AuthorityTerm, Decision, JsonObject, JsonValue, Reference,
};
use runx_core::policy::authority_term_has_verb;
use runx_parser::GraphStep;
use runx_runtime::RuntimeEffectError;

use super::super::errors::{denied, failed};
use super::types::OwnedStepAuthoritySubmission;
use crate::authority::PaymentSpendCapabilityBinding;

#[derive(Clone, Debug)]
struct ReservedAuthorityInput {
    parent_authority: AuthorityTerm,
    child_authority: AuthorityTerm,
    reservation_decision: Option<Decision>,
    subset_proof: Option<AuthoritySubsetProof>,
    child_harness_ref: Reference,
    spend_capability_binding: Option<PaymentSpendCapabilityBinding>,
    consumed_spend_capability_refs: Vec<Reference>,
}

pub(in crate::effect) fn step_authority_submission(
    step: &GraphStep,
    inputs: &JsonObject,
) -> Result<Option<OwnedStepAuthoritySubmission>, RuntimeEffectError> {
    let Some(reserved) = optional_payment_authority_object(inputs)? else {
        return Ok(None);
    };
    let reserved = parse_reserved_payment_authority(reserved)?;
    let spends = authority_term_has_verb(
        &reserved.child_authority,
        runx_contracts::AuthorityVerb::Commit,
    );
    let (spend_capability_ref, idempotency_key) = if spends {
        let idempotency = require_object_input(inputs, "idempotency")?;
        (
            Some(require_reference_input(inputs, "spend_capability_ref")?),
            Some(require_non_empty_string_field(
                idempotency,
                "idempotency.key",
            )?),
        )
    } else {
        (None, None)
    };
    let _ = step;
    Ok(Some(OwnedStepAuthoritySubmission {
        spend_capability_ref,
        idempotency_key,
        parent_authority: reserved.parent_authority,
        child_authority: reserved.child_authority,
        reservation_decision: reserved.reservation_decision,
        subset_proof: reserved.subset_proof,
        child_harness_ref: reserved.child_harness_ref,
        spend_capability_binding: reserved.spend_capability_binding,
        consumed_spend_capability_refs: reserved.consumed_spend_capability_refs,
    }))
}

fn optional_payment_authority_object(
    inputs: &JsonObject,
) -> Result<Option<&JsonObject>, RuntimeEffectError> {
    let has_execution_field =
        inputs.contains_key("payment_challenge") || inputs.contains_key("spend_capability_ref");
    if inputs.contains_key("reserved_payment_authority") {
        if !has_execution_field && !inputs.contains_key("idempotency") {
            return Ok(None);
        }
        return require_object_input(inputs, "reserved_payment_authority").map(Some);
    }
    if has_execution_field {
        return Err(denied(
            "reserved_payment_authority is required before payment rail execution".to_owned(),
        ));
    }
    Ok(None)
}

fn parse_reserved_payment_authority(
    object: &JsonObject,
) -> Result<ReservedAuthorityInput, RuntimeEffectError> {
    Ok(ReservedAuthorityInput {
        parent_authority: required_typed_input(
            object,
            "reserved_payment_authority.parent_authority",
            "parent_authority",
        )?,
        child_authority: required_typed_input(
            object,
            "reserved_payment_authority.child_authority",
            "child_authority",
        )?,
        reservation_decision: optional_typed_input(
            object,
            "reserved_payment_authority.reservation_decision",
            "reservation_decision",
        )?,
        subset_proof: optional_typed_input(
            object,
            "reserved_payment_authority.subset_proof",
            "subset_proof",
        )?,
        child_harness_ref: required_typed_input(
            object,
            "reserved_payment_authority.child_harness_ref",
            "child_harness_ref",
        )?,
        spend_capability_binding: optional_typed_input(
            object,
            "reserved_payment_authority.spend_capability_binding",
            "spend_capability_binding",
        )?,
        consumed_spend_capability_refs: optional_typed_input(
            object,
            "reserved_payment_authority.consumed_spend_capability_refs",
            "consumed_spend_capability_refs",
        )?
        .unwrap_or_default(),
    })
}

fn require_object_input<'a>(
    inputs: &'a JsonObject,
    field: &str,
) -> Result<&'a JsonObject, RuntimeEffectError> {
    match inputs.get(field) {
        Some(JsonValue::Object(object)) => Ok(object),
        Some(_) => Err(denied(format!(
            "{field} must be an object before payment rail execution"
        ))),
        None => Err(denied(format!(
            "{field} is required before payment rail execution"
        ))),
    }
}

fn require_non_empty_string_field(
    object: &JsonObject,
    field_path: &str,
) -> Result<String, RuntimeEffectError> {
    let Some((_, field)) = field_path.rsplit_once('.') else {
        return Err(denied(format!(
            "{field_path} is not a valid payment admission field"
        )));
    };
    let Some(value) = object.get(field) else {
        return Err(denied(format!(
            "{field_path} is required before payment rail execution"
        )));
    };
    let JsonValue::String(value) = value else {
        return Err(denied(format!(
            "{field_path} must be a string before payment rail execution"
        )));
    };
    if value.trim().is_empty() {
        return Err(denied(format!(
            "{field_path} must not be empty before payment rail execution"
        )));
    }
    Ok(value.to_owned())
}

fn require_reference_input(
    inputs: &JsonObject,
    field: &str,
) -> Result<Reference, RuntimeEffectError> {
    match inputs.get(field) {
        Some(JsonValue::Object(_)) => required_typed_value(inputs.get(field), field),
        Some(_) => Err(denied(format!(
            "{field} must be a Reference before payment rail execution"
        ))),
        None => Err(denied(format!(
            "{field} is required before payment rail execution"
        ))),
    }
}

fn optional_typed_input<T: serde::de::DeserializeOwned>(
    object: &JsonObject,
    field_path: &str,
    field: &str,
) -> Result<Option<T>, RuntimeEffectError> {
    let Some(value) = object.get(field) else {
        return Ok(None);
    };
    required_typed_value(Some(value), field_path).map(Some)
}

fn required_typed_input<T: serde::de::DeserializeOwned>(
    object: &JsonObject,
    field_path: &str,
    field: &str,
) -> Result<T, RuntimeEffectError> {
    required_typed_value(object.get(field), field_path)
}

fn required_typed_value<T: serde::de::DeserializeOwned>(
    value: Option<&JsonValue>,
    field_path: &str,
) -> Result<T, RuntimeEffectError> {
    let Some(value) = value else {
        return Err(denied(format!(
            "{field_path} is required before payment rail execution"
        )));
    };
    serde_json::from_value::<T>(
        serde_json::to_value(value).map_err(|source| failed("serializing input", source))?,
    )
    .map_err(|source| {
        denied(format!(
            "{field_path} is not valid typed payment authority: {source}"
        ))
    })
}

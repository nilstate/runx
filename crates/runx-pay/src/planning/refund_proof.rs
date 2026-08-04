use runx_contracts::{
    AuthorityEffectLimit, AuthorityTerm, AuthorityVerb, ClosureDisposition, EffectFinalityPhase,
    ProofKind, Receipt, Reference, ReferenceType,
};
use runx_runtime::VerifiedReceiptStore;

use super::{PaymentPlanningError, RefundableCharge, invalid, json_bytes, sha256_hex};

const PAYMENT_FAMILY: &str = "payment";
const REFUND_OPERATION: &str = "refund";
const MONEY_MOVEMENT_URI_PREFIX: &str = "runx:money_movement:";
const RECEIPT_URI_PREFIX: &str = "runx:receipt:";

pub(super) struct VerifiedRefundProof {
    pub charge: RefundableCharge,
    pub history_receipt_refs: Vec<String>,
    pub proof_digest: String,
}

pub(super) fn resolve_refund_proof(
    request: runx_runtime::EffectToolRequest<'_>,
    original_receipt_ref: &str,
) -> Result<VerifiedRefundProof, PaymentPlanningError> {
    let store = VerifiedReceiptStore::resolve(request.env, request.skill_directory)
        .map_err(|error| invalid(format!("refund receipt store is unavailable: {error}")))?;
    let original = store.read_exact(original_receipt_ref).map_err(|error| {
        invalid(format!(
            "original payment receipt proof is invalid: {error}"
        ))
    })?;
    let original_projection = payment_projection(&original, AuthorityVerb::Commit)?;
    if original_projection.operation == REFUND_OPERATION {
        return Err(invalid(
            "original payment receipt must describe a charge, not another refund",
        ));
    }
    let history = verified_refund_history(&store, &original, &original_projection)?;
    let proof_digest = refund_proof_digest(&original, &original_projection, &history.entries)?;
    Ok(VerifiedRefundProof {
        charge: RefundableCharge {
            money_movement_id: original_projection.money_movement_id,
            rail: original_projection.rail,
            phase: EffectFinalityPhase::Sealed,
            amount_minor: original_projection.amount_minor,
            refunded_minor: history.refunded_minor,
            currency: original_projection.currency,
            payer_ref: original_projection.counterparty,
            proof_ref: original_projection.proof_ref,
        },
        history_receipt_refs: history
            .entries
            .into_iter()
            .map(|(receipt_ref, _, _)| receipt_ref)
            .collect(),
        proof_digest,
    })
}

struct VerifiedRefundHistory {
    refunded_minor: u64,
    entries: Vec<(String, String, u64)>,
}

fn verified_refund_history(
    store: &VerifiedReceiptStore,
    original: &Receipt,
    original_projection: &PaymentReceiptProjection,
) -> Result<VerifiedRefundHistory, PaymentPlanningError> {
    let mut refunded_minor = 0_u64;
    let mut entries = Vec::new();
    for receipt in store
        .list()
        .map_err(|error| invalid(format!("refund receipt history is invalid: {error}")))?
    {
        if receipt.id == original.id || !references_original_receipt(&receipt, original.id.as_str())
        {
            continue;
        }
        let refund = payment_projection(&receipt, AuthorityVerb::Reverse)?;
        if refund.operation != REFUND_OPERATION {
            continue;
        }
        if refund.rail != original_projection.rail
            || refund.currency != original_projection.currency
            || refund.counterparty != original_projection.counterparty
        {
            return Err(invalid(format!(
                "refund receipt {} does not match the original payment identity",
                receipt.id
            )));
        }
        refunded_minor = refunded_minor
            .checked_add(refund.amount_minor)
            .ok_or_else(|| invalid("verified refund history amount overflowed"))?;
        entries.push((
            receipt.id.to_string(),
            receipt.digest.to_string(),
            refund.amount_minor,
        ));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(VerifiedRefundHistory {
        refunded_minor,
        entries,
    })
}

fn refund_proof_digest(
    original: &Receipt,
    projection: &PaymentReceiptProjection,
    history: &[(String, String, u64)],
) -> Result<String, PaymentPlanningError> {
    let proof_value = serde_json::json!({
        "original_receipt_ref": original.id,
        "original_receipt_digest": original.digest,
        "money_movement_id": projection.money_movement_id,
        "provider_proof_ref": projection.proof_ref,
        "history": history,
    });
    Ok(format!("sha256:{}", sha256_hex(&json_bytes(&proof_value)?)))
}

struct PaymentReceiptProjection {
    rail: String,
    operation: String,
    amount_minor: u64,
    currency: String,
    counterparty: String,
    proof_ref: String,
    money_movement_id: String,
}

fn payment_projection(
    receipt: &Receipt,
    verb: AuthorityVerb,
) -> Result<PaymentReceiptProjection, PaymentPlanningError> {
    if receipt.seal.disposition != ClosureDisposition::Closed {
        return Err(invalid(format!(
            "payment receipt {} is not closed",
            receipt.id
        )));
    }
    let limit = validated_payment_limit(receipt, verb)?;
    let amount_minor = limit.max_per_call_units.ok_or_else(|| {
        invalid(format!(
            "payment receipt {} has no per-call amount bound",
            receipt.id
        ))
    })?;
    let [rail] = limit.channels.as_slice() else {
        return Err(invalid(format!(
            "payment receipt {} must bind exactly one rail",
            receipt.id
        )));
    };
    let operation = required_limit_binding(receipt, limit.operation.as_deref(), "operation")?;
    let counterparty = required_limit_binding(receipt, limit.peer.as_deref(), "counterparty")?;
    let (proof_ref, money_movement_id) = payment_proof_identity(receipt)?;
    Ok(PaymentReceiptProjection {
        rail: rail.as_str().to_owned(),
        operation,
        amount_minor,
        currency: limit.unit.as_str().to_owned(),
        counterparty,
        proof_ref,
        money_movement_id,
    })
}

fn validated_payment_limit(
    receipt: &Receipt,
    verb: AuthorityVerb,
) -> Result<&AuthorityEffectLimit, PaymentPlanningError> {
    let mut candidates = receipt
        .authority
        .terms
        .iter()
        .filter(|term| term.verbs.contains(&verb))
        .filter_map(|term| payment_limit(term).map(|limit| (term, limit)))
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(_, limit)| {
        (
            limit.max_per_call_units.unwrap_or(u64::MAX),
            limit.channels.len(),
        )
    });
    let (_, limit) = candidates.first().copied().ok_or_else(|| {
        invalid(format!(
            "payment receipt {} has no bounded {verb:?} authority",
            receipt.id
        ))
    })?;
    if !limit.receipt_before_success
        || !limit.idempotency_required
        || !limit.recovery_required
        || !limit.single_use_capability
    {
        return Err(invalid(format!(
            "payment receipt {} lacks required finality controls",
            receipt.id
        )));
    }
    Ok(limit)
}

fn required_limit_binding(
    receipt: &Receipt,
    value: Option<&str>,
    binding: &str,
) -> Result<String, PaymentPlanningError> {
    value.map(str::to_owned).ok_or_else(|| {
        invalid(format!(
            "payment receipt {} has no {binding} binding",
            receipt.id
        ))
    })
}

fn payment_proof_identity(receipt: &Receipt) -> Result<(String, String), PaymentPlanningError> {
    let verification_refs = receipt_verification_refs(receipt);
    let proof_ref = single_reference_uri(
        &verification_refs,
        |reference| reference.proof_kind == Some(ProofKind::EffectEvidence),
        "provider effect proof",
        receipt,
    )?;
    let movement_ref = single_reference_uri(
        &verification_refs,
        |reference| {
            reference
                .uri
                .as_str()
                .starts_with(MONEY_MOVEMENT_URI_PREFIX)
        },
        "money movement",
        receipt,
    )?;
    let money_movement_id = movement_ref
        .strip_prefix(MONEY_MOVEMENT_URI_PREFIX)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("payment receipt money movement reference is malformed"))?;
    Ok((proof_ref, money_movement_id.to_owned()))
}

fn payment_limit(term: &AuthorityTerm) -> Option<&AuthorityEffectLimit> {
    term.bounds
        .effect_limits
        .iter()
        .find(|limit| limit.family.as_str() == PAYMENT_FAMILY)
}

fn receipt_verification_refs(receipt: &Receipt) -> Vec<&Reference> {
    receipt
        .acts
        .iter()
        .flat_map(|act| &act.criterion_bindings)
        .flat_map(|binding| &binding.verification_refs)
        .collect()
}

fn single_reference_uri(
    references: &[&Reference],
    predicate: impl Fn(&Reference) -> bool,
    label: &str,
    receipt: &Receipt,
) -> Result<String, PaymentPlanningError> {
    let values = references
        .iter()
        .copied()
        .filter(|reference| predicate(reference))
        .map(|reference| reference.uri.as_str())
        .collect::<Vec<_>>();
    let [value] = values.as_slice() else {
        return Err(invalid(format!(
            "payment receipt {} must contain exactly one {label} reference",
            receipt.id
        )));
    };
    Ok((*value).to_owned())
}

fn references_original_receipt(receipt: &Receipt, original_receipt_ref: &str) -> bool {
    let expected_uri = format!("{RECEIPT_URI_PREFIX}{original_receipt_ref}");
    receipt.acts.iter().any(|act| {
        act.source_refs
            .iter()
            .chain(&act.target_refs)
            .chain(&act.artifact_refs)
            .chain(
                act.criterion_bindings
                    .iter()
                    .flat_map(|binding| &binding.verification_refs),
            )
            .any(|reference| {
                reference.reference_type == ReferenceType::Receipt
                    && reference.uri.as_str() == expected_uri
            })
    })
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests;

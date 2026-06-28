//! Subset comparator for payment authority terms.
//!
//! Fail-closed by construction: missing required payment dimensions make terms
//! incomparable, and incomparable terms are denied.

use runx_contracts::{
    AuthorityCapability, AuthorityEffectCredentialForm, AuthorityEffectLimit,
    AuthorityResourceFamily, AuthorityTerm, AuthorityVerb,
};

use super::payment_authority_spends;
use runx_core::policy::authority_algebra::{
    items_subset, optional_bound_subset, optional_exact_or_narrower, optional_ref_bound_subset,
    parent_items_preserved, same_reference_address,
};

const PAYMENT_EFFECT_FAMILY: &str = "payment";

#[must_use]
pub fn is_payment_authority_subset(child: &AuthorityTerm, parent: &AuthorityTerm) -> bool {
    child.resource_family == AuthorityResourceFamily::Effect
        && parent.resource_family == AuthorityResourceFamily::Effect
        && same_reference_address(&child.resource_ref, &parent.resource_ref)
        && items_subset(&child.verbs, &parent.verbs)
        && items_subset(&child.capabilities, &parent.capabilities)
        && parent_items_preserved(&child.conditions, &parent.conditions)
        && parent_items_preserved(&child.approvals, &parent.approvals)
        && optional_ref_bound_subset(child.expires_at.as_ref(), parent.expires_at.as_ref())
        && payment_bounds_subset(child, parent)
}

fn payment_bounds_subset(child: &AuthorityTerm, parent: &AuthorityTerm) -> bool {
    let Some(child_payment) = payment_effect_limit(child) else {
        return false;
    };
    let Some(parent_payment) = payment_effect_limit(parent) else {
        return false;
    };

    required_currency_equal(child_payment, parent_payment)
        && minor_unit_caps_subset(child, child_payment, parent_payment)
        && rails_subset(child_payment, parent_payment)
        && optional_exact_or_narrower(&child_payment.realm, &parent_payment.realm)
        && optional_exact_or_narrower(&child_payment.peer, &parent_payment.peer)
        && optional_exact_or_narrower(&child_payment.operation, &parent_payment.operation)
        && optional_exact_or_narrower(&child_payment.period, &parent_payment.period)
        && required_booleans_subset(child_payment, parent_payment)
        && optional_bound_subset(
            child_payment.preflight_ttl_ms,
            parent_payment.preflight_ttl_ms,
        )
        && optional_bound_subset(
            child_payment.approval_threshold_units,
            parent_payment.approval_threshold_units,
        )
        && authorization_form_exact_match(child_payment, parent_payment)
        && spend_authorization_form_granted(child, parent)
}

fn payment_effect_limit(term: &AuthorityTerm) -> Option<&AuthorityEffectLimit> {
    term.bounds
        .effect_limits
        .iter()
        .find(|limit| limit.family == PAYMENT_EFFECT_FAMILY)
}

fn required_currency_equal(child: &AuthorityEffectLimit, parent: &AuthorityEffectLimit) -> bool {
    child.unit == parent.unit
}

fn minor_unit_caps_subset(
    child: &AuthorityTerm,
    child_payment: &AuthorityEffectLimit,
    parent_payment: &AuthorityEffectLimit,
) -> bool {
    if uses_minor_units(child)
        && (child_payment.max_per_call_units.is_none()
            || parent_payment.max_per_call_units.is_none())
    {
        return false;
    }

    // Spend-class authority must be bounded in aggregate, not only per call: a
    // per-call cap with no per-run/per-period cap permits unbounded total spend
    // (per-call x unlimited calls). Require at least one aggregate cap on both
    // the requested child and the granting parent.
    if payment_authority_spends(child)
        && (!has_aggregate_minor_cap(child_payment) || !has_aggregate_minor_cap(parent_payment))
    {
        return false;
    }

    optional_bound_subset(
        child_payment.max_per_call_units,
        parent_payment.max_per_call_units,
    ) && optional_bound_subset(
        child_payment.max_per_run_units,
        parent_payment.max_per_run_units,
    ) && optional_bound_subset(
        child_payment.max_per_period_units,
        parent_payment.max_per_period_units,
    )
}

// Period caps count as aggregate bounds because the runtime clamps each run's
// spend ledger to min(max_per_run_units, max_per_period_units); a period cap
// declared without a run cap is still enforced, not advisory.
fn has_aggregate_minor_cap(payment: &AuthorityEffectLimit) -> bool {
    payment.max_per_run_units.is_some() || payment.max_per_period_units.is_some()
}

fn uses_minor_units(term: &AuthorityTerm) -> bool {
    term.verbs.iter().any(|verb| {
        matches!(
            verb,
            AuthorityVerb::Estimate
                | AuthorityVerb::Prepare
                | AuthorityVerb::Commit
                | AuthorityVerb::Reverse
        )
    })
}

fn rails_subset(child: &AuthorityEffectLimit, parent: &AuthorityEffectLimit) -> bool {
    !child.channels.is_empty()
        && !parent.channels.is_empty()
        && child
            .channels
            .iter()
            .all(|rail| parent.channels.contains(rail))
}

// Subset-time monotonicity: a child may not drop a required-boolean flag its
// parent set (attenuation can only narrow, never relax). The
// `receipt_before_success` clause here is distinct from the admission-time guard
// in `authority::authority_requires_effect_receipt_before_success`, which reads
// the same flag to decide whether the live step must hold a rail receipt. Both
// fire at different points and gate different things; keep both.
fn required_booleans_subset(child: &AuthorityEffectLimit, parent: &AuthorityEffectLimit) -> bool {
    (!parent.preflight_required || child.preflight_required)
        && (!parent.commitment_required || child.commitment_required)
        && (!parent.idempotency_required || child.idempotency_required)
        && (!parent.recovery_required || child.recovery_required)
        && (!parent.receipt_before_success || child.receipt_before_success)
}

fn authorization_form_exact_match(
    child: &AuthorityEffectLimit,
    parent: &AuthorityEffectLimit,
) -> bool {
    child.authorization_form == parent.authorization_form
}

fn spend_authorization_form_granted(child: &AuthorityTerm, parent: &AuthorityTerm) -> bool {
    if !payment_authority_spends(child) {
        return true;
    }
    let child_payment = payment_effect_limit(child);
    let parent_payment = payment_effect_limit(parent);
    let (Some(child_payment), Some(parent_payment)) = (child_payment, parent_payment) else {
        return false;
    };

    match child_payment.authorization_form.as_ref() {
        Some(AuthorityEffectCredentialForm::SingleUseCapability) => {
            child_payment.single_use_capability
                && parent_payment.single_use_capability
                && child
                    .capabilities
                    .contains(&AuthorityCapability::EffectSingleUseCapability)
                && parent
                    .capabilities
                    .contains(&AuthorityCapability::EffectSingleUseCapability)
        }
        Some(AuthorityEffectCredentialForm::ExternalSigner) => true,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::is_payment_authority_subset;
    use runx_contracts::{
        AuthorityBounds, AuthorityCapability, AuthorityEffectCredentialForm, AuthorityEffectLimit,
        AuthorityResourceFamily, AuthorityTerm, AuthorityVerb, Reference, ReferenceType,
    };

    const COUNTERPARTY: &str = "merchant:bridge";

    #[test]
    fn accepts_external_signer_when_parent_grants_same_form() {
        let parent = payment_term("parent", AuthorityEffectCredentialForm::ExternalSigner);
        let child = payment_term("child", AuthorityEffectCredentialForm::ExternalSigner);

        assert!(is_payment_authority_subset(&child, &parent));
    }

    #[test]
    fn denies_external_signer_child_when_parent_grants_single_use_form() {
        let parent = payment_term("parent", AuthorityEffectCredentialForm::SingleUseCapability);
        let child = payment_term("child", AuthorityEffectCredentialForm::ExternalSigner);

        assert!(!is_payment_authority_subset(&child, &parent));
    }

    #[test]
    fn denies_single_use_child_when_parent_grants_external_signer_form() {
        let mut parent = payment_term("parent", AuthorityEffectCredentialForm::ExternalSigner);
        parent.capabilities = vec![AuthorityCapability::EffectSingleUseCapability];
        if let Some(payment) = parent.bounds.effect_limits.first_mut() {
            payment.single_use_capability = true;
        }
        let child = payment_term("child", AuthorityEffectCredentialForm::SingleUseCapability);

        assert!(!is_payment_authority_subset(&child, &parent));
    }

    fn payment_term(
        term_id: &str,
        authorization_form: AuthorityEffectCredentialForm,
    ) -> AuthorityTerm {
        let uses_single_use = matches!(
            &authorization_form,
            AuthorityEffectCredentialForm::SingleUseCapability
        );

        AuthorityTerm {
            term_id: term_id.into(),
            principal_ref: reference(ReferenceType::Principal, "runx:principal:bridge-agent"),
            resource_ref: reference(ReferenceType::Grant, "runx:payment-grant:bridge"),
            resource_family: AuthorityResourceFamily::Effect,
            verbs: vec![AuthorityVerb::Prepare, AuthorityVerb::Commit],
            bounds: AuthorityBounds {
                effect_limits: vec![AuthorityEffectLimit {
                    family: "payment".into(),
                    unit: "USD".into(),
                    max_per_call_units: Some(1_000),
                    max_per_run_units: Some(5_000),
                    max_per_period_units: None,
                    period: None,
                    channels: vec!["stripe".into()],
                    realm: None,
                    peer: Some(COUNTERPARTY.into()),
                    operation: Some("bridge.spend".into()),
                    preflight_ttl_ms: Some(120_000),
                    approval_threshold_units: None,
                    authorization_form: Some(authorization_form),
                    preflight_required: true,
                    commitment_required: true,
                    idempotency_required: true,
                    recovery_required: true,
                    receipt_before_success: true,
                    single_use_capability: uses_single_use,
                }],
                ..AuthorityBounds::default()
            },
            conditions: Vec::new(),
            approvals: Vec::new(),
            capabilities: if uses_single_use {
                vec![AuthorityCapability::EffectSingleUseCapability]
            } else {
                Vec::new()
            },
            expires_at: Some("2026-05-22T00:00:00Z".into()),
            issued_by_ref: reference(ReferenceType::Grant, "runx:grant:bridge-issuer"),
            credential_ref: Some(reference(
                ReferenceType::Credential,
                "runx:credential:bridge-session",
            )),
        }
    }

    fn reference(reference_type: ReferenceType, uri: &str) -> Reference {
        Reference {
            reference_type,
            uri: uri.to_owned().into(),
            provider: None,
            locator: None,
            label: None,
            observed_at: None,
            proof_kind: None,
        }
    }
}

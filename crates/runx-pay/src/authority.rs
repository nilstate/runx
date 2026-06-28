// rust-style-allow: large-file - payment authority admission keeps spend
// capability binding, subset enforcement, and rail admission in one algebraic
// boundary until the term model settles.

mod subset;

pub use subset::is_payment_authority_subset;

use runx_contracts::{
    AuthorityCapability, AuthorityEffectCredentialForm, AuthorityEffectLimit,
    AuthorityResourceFamily, AuthoritySubsetProof, AuthorityTerm, AuthorityVerb, Decision,
    DecisionChoice, Reference,
};
#[cfg(test)]
use runx_core::policy::authority_effect_proof_kinds as generic_authority_effect_proof_kinds;
use runx_core::policy::{
    SubsetProofError, authority_effect_family as generic_authority_effect_family,
    ensure_subset_proof as core_ensure_subset_proof, evaluate_authority_effect_guards,
};
use thiserror::Error;

const PAYMENT_EFFECT_FAMILY: &str = "payment";

#[derive(Clone, Debug, PartialEq)]
pub struct StepAuthorityAdmission<'a> {
    pub parent_authority: &'a AuthorityTerm,
    pub child_authority: &'a AuthorityTerm,
    pub reservation_decision: Option<&'a Decision>,
    pub subset_proof: Option<&'a AuthoritySubsetProof>,
    pub child_harness_ref: &'a Reference,
    pub act_id: &'a str,
    pub idempotency_key: Option<&'a str>,
    pub spend_capability_binding: Option<PaymentSpendCapabilityBinding>,
    pub consumed_spend_capability_refs: &'a [Reference],
    pub spend_capability_ref: Option<&'a Reference>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepAuthorityAdmissionDecision<'a> {
    pub verb: Option<AuthorityVerb>,
    pub parent_term_id: &'a str,
    pub child_term_id: &'a str,
    pub idempotency_key: Option<&'a str>,
    pub spend_capability_ref: Option<&'a Reference>,
    pub effect_family: Option<&'a str>,
    pub receipt_before_success_required: bool,
    pub non_replay_required: bool,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq)]
struct PaymentRailAuthorization<'a> {
    pub parent_authority: &'a AuthorityTerm,
    pub child_authority: &'a AuthorityTerm,
    pub reservation_decision: Option<&'a Decision>,
    pub subset_proof: Option<&'a AuthoritySubsetProof>,
    pub child_harness_ref: &'a Reference,
    pub act_id: &'a str,
    pub idempotency_key: Option<&'a str>,
    pub spend_capability_binding: Option<PaymentSpendCapabilityBinding>,
    pub rail_proof_refs: &'a [Reference],
    pub consumed_spend_capability_refs: &'a [Reference],
    pub spend_capability_ref: Option<&'a Reference>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentSpendCapabilityBinding {
    pub child_harness_ref: Reference,
    pub act_id: String,
    pub reservation_decision_id: String,
    pub idempotency_key: String,
    pub amount_minor: u64,
    pub currency: String,
    pub counterparty: String,
    pub rail: String,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct PaymentRailAuthorizationDecision {
    pub parent_term_id: String,
    pub child_term_id: String,
    pub idempotency_key: Option<String>,
    pub spend_capability_ref: Option<Reference>,
    pub rail_proof_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PaymentRailAdmissionDecision<'a> {
    pub parent_term_id: &'a str,
    pub child_term_id: &'a str,
    pub idempotency_key: Option<&'a str>,
    pub spend_capability_ref: Option<&'a Reference>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum PaymentAuthorityError {
    #[error("payment spend requires a reservation decision")]
    MissingReservationDecision,
    #[error("payment reservation decision did not select an act or harness")]
    ReservationDecisionNotSelected,
    #[error("payment authority attenuation requires a subset proof")]
    MissingSubsetProof,
    #[error("payment authority attenuation subset proof is invalid")]
    InvalidSubsetProof,
    #[error("child payment authority is not a subset of parent authority")]
    AuthorityNotSubset,
    #[error("payment spend requires a single-use spend capability")]
    SpendRequiresSingleUseCapability,
    #[error("payment spend capability binding does not match the child harness act")]
    SpendCapabilityBindingMismatch,
    #[error("single-use payment spend capability was already consumed")]
    SpendCapabilityAlreadyConsumed,
    #[error("payment spend requires a deterministic idempotency key")]
    MissingIdempotencyKey,
    #[error("payment spend requires a bounded non-wildcard counterparty")]
    WildcardCounterpartyDenied,
    #[cfg(test)]
    #[error("payment authority requires a rail receipt before success")]
    MissingReceiptBeforeSuccess,
    #[cfg(test)]
    #[error("payment authority requires rail proof")]
    MissingRailProof,
}

#[must_use]
fn authority_term_has_verb(term: &AuthorityTerm, verb: AuthorityVerb) -> bool {
    term.verbs.iter().any(|candidate| candidate == &verb)
}

// Admission-time guard: derives whether this step must hold a rail receipt
// before reporting success, reading the generic effect-guard list
// (`bounds.effects`) plus, for payments, the `effect_limit.receipt_before_success`
// flag on either term. This populates the returned decision and gates runtime
// receipt-before-success. It is independent of, and complementary to, the
// subset-time monotonicity check in `subset::required_booleans_subset`, which
// reads the same payment flag for a different purpose (a child may not drop a
// flag its parent set). Both are load-bearing; do not collapse one into the other.
#[must_use]
fn authority_requires_effect_receipt_before_success(
    parent: &AuthorityTerm,
    child: &AuthorityTerm,
    family: &str,
) -> bool {
    evaluate_authority_effect_guards(parent, child, family).receipt_before_success_required
        || (family == PAYMENT_EFFECT_FAMILY
            && (payment_authority_requires_receipt_before_success(parent)
                || payment_authority_requires_receipt_before_success(child)))
}

#[must_use]
fn authority_requires_effect_non_replay(
    parent: &AuthorityTerm,
    child: &AuthorityTerm,
    family: &str,
) -> bool {
    evaluate_authority_effect_guards(parent, child, family).non_replay_required
}

#[must_use]
#[cfg(test)]
fn authority_effect_proof_kinds(
    parent: &AuthorityTerm,
    child: &AuthorityTerm,
    family: &str,
) -> Vec<runx_contracts::ProofKind> {
    generic_authority_effect_proof_kinds(parent, child, family)
}

#[must_use]
fn authority_effect_family<'a>(
    parent: &'a AuthorityTerm,
    child: &'a AuthorityTerm,
) -> Option<&'a str> {
    generic_authority_effect_family(parent, child)
        .or_else(|| payment_effect_limit(parent).map(|limit| limit.family.as_str()))
        .or_else(|| payment_effect_limit(child).map(|limit| limit.family.as_str()))
}

#[must_use]
fn payment_authority_requires_receipt_before_success(term: &AuthorityTerm) -> bool {
    payment_effect_limit(term).is_some_and(|payment| payment.receipt_before_success)
}

fn is_payment_effect_authority(term: &AuthorityTerm) -> bool {
    term.resource_family == AuthorityResourceFamily::Effect && payment_effect_limit(term).is_some()
}

fn payment_effect_limit(term: &AuthorityTerm) -> Option<&AuthorityEffectLimit> {
    term.bounds
        .effect_limits
        .iter()
        .find(|limit| limit.family == PAYMENT_EFFECT_FAMILY)
}

#[must_use]
pub(super) fn payment_authority_spends(term: &AuthorityTerm) -> bool {
    authority_term_has_verb(term, AuthorityVerb::Commit)
}

pub fn admit_step_authority(
    input: StepAuthorityAdmission<'_>,
) -> Result<StepAuthorityAdmissionDecision<'_>, PaymentAuthorityError> {
    let effect_family = authority_effect_family(input.parent_authority, input.child_authority);
    let receipt_before_success_required = effect_family.is_some_and(|family| {
        authority_requires_effect_receipt_before_success(
            input.parent_authority,
            input.child_authority,
            family,
        )
    });
    let non_replay_required = effect_family.is_some_and(|family| {
        authority_requires_effect_non_replay(input.parent_authority, input.child_authority, family)
    });

    if is_payment_effect_authority(input.child_authority) {
        let spends = payment_authority_spends(input.child_authority);
        let admission = admit_payment_rail(&input)?;
        return Ok(StepAuthorityAdmissionDecision {
            verb: admitted_payment_verb(input.child_authority, spends),
            parent_term_id: admission.parent_term_id,
            child_term_id: admission.child_term_id,
            idempotency_key: admission.idempotency_key,
            spend_capability_ref: admission.spend_capability_ref,
            effect_family,
            receipt_before_success_required,
            non_replay_required,
        });
    }

    Ok(StepAuthorityAdmissionDecision {
        verb: None,
        parent_term_id: input.parent_authority.term_id.as_str(),
        child_term_id: input.child_authority.term_id.as_str(),
        idempotency_key: input.idempotency_key,
        spend_capability_ref: input.spend_capability_ref,
        effect_family,
        receipt_before_success_required,
        non_replay_required,
    })
}

fn admitted_payment_verb(term: &AuthorityTerm, spends: bool) -> Option<AuthorityVerb> {
    if spends {
        return Some(AuthorityVerb::Commit);
    }
    term.verbs.first().cloned()
}

#[cfg(test)]
fn authorize_payment_rail(
    input: PaymentRailAuthorization<'_>,
) -> Result<PaymentRailAuthorizationDecision, PaymentAuthorityError> {
    let spends = payment_authority_spends(input.child_authority);
    let admission = admit_payment_rail(&StepAuthorityAdmission {
        parent_authority: input.parent_authority,
        child_authority: input.child_authority,
        reservation_decision: input.reservation_decision,
        subset_proof: input.subset_proof,
        child_harness_ref: input.child_harness_ref,
        act_id: input.act_id,
        idempotency_key: input.idempotency_key,
        spend_capability_binding: input.spend_capability_binding.clone(),
        consumed_spend_capability_refs: input.consumed_spend_capability_refs,
        spend_capability_ref: input.spend_capability_ref,
    })?;

    if requires_receipt_before_success(input.parent_authority, input.child_authority)
        && input.rail_proof_refs.is_empty()
    {
        return Err(PaymentAuthorityError::MissingReceiptBeforeSuccess);
    }

    if spends && input.rail_proof_refs.is_empty() {
        return Err(PaymentAuthorityError::MissingRailProof);
    }

    Ok(PaymentRailAuthorizationDecision {
        parent_term_id: admission.parent_term_id.to_owned(),
        child_term_id: admission.child_term_id.to_owned(),
        idempotency_key: admission.idempotency_key.map(str::to_owned),
        spend_capability_ref: admission.spend_capability_ref.cloned(),
        rail_proof_count: input.rail_proof_refs.len(),
    })
}

fn admit_payment_rail<'a>(
    input: &StepAuthorityAdmission<'a>,
) -> Result<PaymentRailAdmissionDecision<'a>, PaymentAuthorityError> {
    let spends = payment_authority_spends(input.child_authority);

    if spends {
        let Some(decision) = input.reservation_decision else {
            return Err(PaymentAuthorityError::MissingReservationDecision);
        };
        if !decision_selects_payment_execution(decision) {
            return Err(PaymentAuthorityError::ReservationDecisionNotSelected);
        }
        ensure_idempotency_key(input)?;
        ensure_bounded_spend_counterparty(input.child_authority)?;
        ensure_single_use_spend_capability(input)?;
    }

    ensure_subset_proof(
        input.subset_proof,
        input.child_authority,
        input.parent_authority,
    )?;

    if !is_payment_authority_subset(input.child_authority, input.parent_authority) {
        return Err(PaymentAuthorityError::AuthorityNotSubset);
    }

    Ok(PaymentRailAdmissionDecision {
        parent_term_id: input.parent_authority.term_id.as_str(),
        child_term_id: input.child_authority.term_id.as_str(),
        idempotency_key: input.idempotency_key,
        spend_capability_ref: input.spend_capability_ref,
    })
}

// The structural proof validation is the lifted, family-agnostic core
// `ensure_subset_proof`; payment maps its result onto the payment error so the
// admission keeps a single error vocabulary. There is exactly one validator in
// the workspace.
fn ensure_subset_proof(
    proof: Option<&AuthoritySubsetProof>,
    child: &AuthorityTerm,
    parent: &AuthorityTerm,
) -> Result<(), PaymentAuthorityError> {
    core_ensure_subset_proof(proof, child, parent).map_err(|error| match error {
        SubsetProofError::Missing => PaymentAuthorityError::MissingSubsetProof,
        SubsetProofError::Invalid => PaymentAuthorityError::InvalidSubsetProof,
    })
}

fn decision_selects_payment_execution(decision: &Decision) -> bool {
    matches!(
        decision.choice,
        DecisionChoice::Open
            | DecisionChoice::Continue
            | DecisionChoice::SpawnChild
            | DecisionChoice::Close
    ) && (decision.selected_act_id.is_some() || decision.selected_harness_ref.is_some())
}

fn ensure_single_use_spend_capability(
    input: &StepAuthorityAdmission<'_>,
) -> Result<(), PaymentAuthorityError> {
    let Some(payment) = payment_effect_limit(input.child_authority) else {
        return Err(PaymentAuthorityError::SpendRequiresSingleUseCapability);
    };

    let has_single_use = payment.single_use_capability
        && payment.authorization_form == Some(AuthorityEffectCredentialForm::SingleUseCapability)
        && input
            .child_authority
            .capabilities
            .contains(&AuthorityCapability::EffectSingleUseCapability);

    if !has_single_use || input.spend_capability_ref.is_none() {
        return Err(PaymentAuthorityError::SpendRequiresSingleUseCapability);
    }

    let Some(binding) = input.spend_capability_binding.as_ref() else {
        return Err(PaymentAuthorityError::SpendRequiresSingleUseCapability);
    };
    let Some(decision) = input.reservation_decision else {
        return Err(PaymentAuthorityError::MissingReservationDecision);
    };
    if !spend_capability_binding_matches(input, decision, payment, binding) {
        return Err(PaymentAuthorityError::SpendCapabilityBindingMismatch);
    }

    let Some(spend_capability_ref) = input.spend_capability_ref else {
        return Err(PaymentAuthorityError::SpendRequiresSingleUseCapability);
    };

    if input
        .consumed_spend_capability_refs
        .iter()
        .any(|consumed| same_reference(consumed, spend_capability_ref))
    {
        return Err(PaymentAuthorityError::SpendCapabilityAlreadyConsumed);
    }

    Ok(())
}

fn ensure_idempotency_key(input: &StepAuthorityAdmission<'_>) -> Result<(), PaymentAuthorityError> {
    let idempotency_required = payment_effect_limit(input.child_authority)
        .is_some_and(|payment| payment.idempotency_required);

    if idempotency_required && input.idempotency_key.is_none_or(str::is_empty) {
        return Err(PaymentAuthorityError::MissingIdempotencyKey);
    }

    Ok(())
}

fn ensure_bounded_spend_counterparty(term: &AuthorityTerm) -> Result<(), PaymentAuthorityError> {
    let Some(payment) = payment_effect_limit(term) else {
        return Err(PaymentAuthorityError::WildcardCounterpartyDenied);
    };
    let Some(counterparty) = payment.peer.as_deref() else {
        return Err(PaymentAuthorityError::WildcardCounterpartyDenied);
    };
    if matches!(counterparty, "" | "*" | "any") {
        return Err(PaymentAuthorityError::WildcardCounterpartyDenied);
    }

    Ok(())
}

fn spend_capability_binding_matches(
    input: &StepAuthorityAdmission<'_>,
    decision: &Decision,
    payment: &AuthorityEffectLimit,
    binding: &PaymentSpendCapabilityBinding,
) -> bool {
    same_reference(&binding.child_harness_ref, input.child_harness_ref)
        && binding.act_id == input.act_id
        && decision
            .selected_act_id
            .as_deref()
            .is_none_or(|id| id == input.act_id)
        && decision
            .selected_harness_ref
            .as_ref()
            .is_none_or(|reference| same_reference(reference, input.child_harness_ref))
        && binding.reservation_decision_id == decision.decision_id
        && input
            .idempotency_key
            .is_some_and(|idempotency_key| idempotency_key == binding.idempotency_key)
        && payment
            .max_per_call_units
            .is_some_and(|max| binding.amount_minor > 0 && binding.amount_minor <= max)
        && binding.currency == payment.unit
        && payment.channels.iter().any(|rail| rail == &binding.rail)
        && payment
            .peer
            .as_deref()
            .is_some_and(|counterparty| counterparty == binding.counterparty)
}

#[cfg(test)]
fn requires_receipt_before_success(parent: &AuthorityTerm, child: &AuthorityTerm) -> bool {
    authority_requires_effect_receipt_before_success(parent, child, "payment")
}

fn same_reference(left: &Reference, right: &Reference) -> bool {
    left.reference_type == right.reference_type && left.uri == right.uri
}

/// Returns true when `child` is no broader than `parent` under the pure payment
/// authority algebra.
///
#[cfg(test)]
mod tests {
    use super::{
        PaymentAuthorityError, PaymentRailAuthorization, PaymentRailAuthorizationDecision,
        PaymentSpendCapabilityBinding, StepAuthorityAdmission, admit_step_authority,
        authority_effect_proof_kinds, authorize_payment_rail,
    };
    use runx_contracts::{
        AuthorityApproval, AuthorityBounds, AuthorityCapability, AuthorityCondition,
        AuthorityConditionPredicate, AuthorityEffectCredentialForm, AuthorityEffectGuard,
        AuthorityEffectGuardKind, AuthorityEffectLimit, AuthorityResourceFamily,
        AuthoritySubsetComparison, AuthoritySubsetProof, AuthoritySubsetRelation,
        AuthoritySubsetResult, AuthorityTerm, AuthorityVerb, Decision, DecisionChoice,
        DecisionInputs, DecisionJustification, Intent, ProofKind, Reference, ReferenceType,
    };

    const ACT_ID: &str = "act_payment_spend";
    const IDEMPOTENCY_KEY: &str = "idem:decision_payment_reservation:harness-payment-rail";
    const COUNTERPARTY: &str = "merchant-123";

    #[test]
    fn admits_reserved_spend_with_subset_proof_and_rail_proof() {
        let scenario = PaymentScenario::standard();

        let result = scenario.authorize_decision();

        assert_eq!(
            result.map(|decision| (
                decision.parent_term_id,
                decision.child_term_id,
                decision.idempotency_key,
                decision.rail_proof_count,
            )),
            Ok((
                "parent".to_owned(),
                "child".to_owned(),
                Some(IDEMPOTENCY_KEY.to_owned()),
                1,
            ))
        );
    }

    #[test]
    fn admits_non_spend_payment_authority_with_subset_proof() {
        let scenario = PaymentScenario::with_child(payment_term(
            "child",
            vec![AuthorityVerb::Prepare],
            PaymentShape::new(2_500, &["card"]),
        ));

        let result = admit_step_authority(StepAuthorityAdmission {
            parent_authority: &scenario.parent,
            child_authority: &scenario.child,
            reservation_decision: None,
            subset_proof: Some(&scenario.subset_proof),
            child_harness_ref: &scenario.child_harness_ref,
            act_id: "act_payment_reserve",
            idempotency_key: None,
            spend_capability_binding: None,
            consumed_spend_capability_refs: &[],
            spend_capability_ref: None,
        });

        assert_eq!(
            result.map(|decision| (
                decision.verb,
                decision.parent_term_id,
                decision.child_term_id,
                decision.idempotency_key,
                decision.spend_capability_ref,
            )),
            Ok((Some(AuthorityVerb::Prepare), "parent", "child", None, None,))
        );
    }

    #[test]
    fn denies_non_spend_payment_authority_without_subset_proof() {
        let scenario = PaymentScenario::with_child(payment_term(
            "child",
            vec![AuthorityVerb::Prepare],
            PaymentShape::new(2_500, &["card"]),
        ));

        assert_eq!(
            admit_step_authority(StepAuthorityAdmission {
                parent_authority: &scenario.parent,
                child_authority: &scenario.child,
                reservation_decision: None,
                subset_proof: None,
                child_harness_ref: &scenario.child_harness_ref,
                act_id: "act_payment_reserve",
                idempotency_key: None,
                spend_capability_binding: None,
                consumed_spend_capability_refs: &[],
                spend_capability_ref: None,
            }),
            Err(PaymentAuthorityError::MissingSubsetProof)
        );
    }

    #[test]
    fn denies_amount_widening_before_rail() {
        let mut scenario = PaymentScenario::with_child(payment_term(
            "child",
            vec![AuthorityVerb::Commit],
            PaymentShape::new(2_000, &["card"]),
        ));
        scenario.parent = payment_term(
            "parent",
            vec![AuthorityVerb::Prepare, AuthorityVerb::Commit],
            PaymentShape::new(1_000, &["card"]),
        );

        assert_eq!(
            scenario.authorize(),
            Err(PaymentAuthorityError::AuthorityNotSubset)
        );
    }

    #[test]
    fn denies_spend_derived_from_reserve_only_parent() {
        let mut scenario = PaymentScenario::standard();
        scenario.parent.verbs = vec![AuthorityVerb::Prepare, AuthorityVerb::Verify];

        assert_eq!(
            scenario.authorize(),
            Err(PaymentAuthorityError::AuthorityNotSubset)
        );
    }

    #[test]
    fn denies_removing_parent_conditions_or_approvals() {
        let mut scenario = PaymentScenario::standard();
        scenario.parent.conditions = vec![payment_condition()];
        scenario.parent.approvals = vec![payment_approval()];
        scenario.child.conditions = Vec::new();
        scenario.child.approvals = Vec::new();

        assert_eq!(
            scenario.authorize(),
            Err(PaymentAuthorityError::AuthorityNotSubset)
        );
    }

    #[test]
    fn admits_child_that_preserves_parent_conditions_and_approvals() {
        let mut scenario = PaymentScenario::standard();
        let condition = payment_condition();
        let approval = payment_approval();
        scenario.parent.conditions = vec![condition.clone()];
        scenario.parent.approvals = vec![approval.clone()];
        scenario.child.conditions = vec![condition];
        scenario.child.approvals = vec![approval];

        assert_eq!(scenario.authorize(), Ok(()));
    }

    #[test]
    fn denies_missing_reservation_decision() {
        let scenario = PaymentScenario::standard();

        assert_eq!(
            scenario.authorize_with(AuthorizationOverride {
                reservation_decision: Some(None),
                ..AuthorizationOverride::default()
            }),
            Err(PaymentAuthorityError::MissingReservationDecision)
        );
    }

    #[test]
    fn denies_unselected_reservation_decision() {
        let scenario = PaymentScenario::with_decision(unselected_decision());

        assert_eq!(
            scenario.authorize(),
            Err(PaymentAuthorityError::ReservationDecisionNotSelected)
        );
    }

    #[test]
    fn denies_missing_subset_proof() {
        let scenario = PaymentScenario::standard();

        assert_eq!(
            scenario.authorize_with(AuthorizationOverride {
                subset_proof: Some(None),
                ..AuthorizationOverride::default()
            }),
            Err(PaymentAuthorityError::MissingSubsetProof)
        );
    }

    #[test]
    fn denies_subset_proof_that_does_not_match_terms() {
        let scenario = PaymentScenario::standard();
        let mut proof = scenario.subset_proof.clone();
        proof.compared_terms[0].child_term_id = "other-child".into();

        assert_eq!(
            scenario.authorize_with(AuthorizationOverride {
                subset_proof: Some(Some(&proof)),
                ..AuthorizationOverride::default()
            }),
            Err(PaymentAuthorityError::InvalidSubsetProof)
        );
    }

    #[test]
    fn denies_missing_idempotency_key_for_spend() {
        let scenario = PaymentScenario::standard();

        assert_eq!(
            scenario.authorize_with(AuthorizationOverride {
                idempotency_key: Some(None),
                ..AuthorizationOverride::default()
            }),
            Err(PaymentAuthorityError::MissingIdempotencyKey)
        );
    }

    #[test]
    fn denies_wildcard_counterparty_for_spend() {
        let scenario = PaymentScenario::with_child(child_wildcard_counterparty_term());

        assert_eq!(
            scenario.authorize(),
            Err(PaymentAuthorityError::WildcardCounterpartyDenied)
        );
    }

    #[test]
    fn denies_spend_capability_binding_that_does_not_match_act() {
        let scenario = PaymentScenario::standard();

        assert_eq!(
            scenario.authorize_with(AuthorizationOverride {
                spend_capability_binding: Some(Some(PaymentSpendCapabilityBinding {
                    act_id: "act_payment_other".to_owned(),
                    ..scenario.capability_binding()
                })),
                ..AuthorizationOverride::default()
            }),
            Err(PaymentAuthorityError::SpendCapabilityBindingMismatch)
        );
    }

    #[test]
    fn denies_missing_rail_proof_when_receipt_before_success_required() {
        let scenario = PaymentScenario::standard();

        assert_eq!(
            scenario.authorize_with(AuthorizationOverride {
                rail_proof_refs: Some(&[]),
                ..AuthorizationOverride::default()
            }),
            Err(PaymentAuthorityError::MissingReceiptBeforeSuccess)
        );
    }

    #[test]
    fn denies_sibling_reuse_of_single_use_spend_capability() {
        let mut scenario = PaymentScenario::standard();
        scenario.consumed_spend_capability_refs = vec![scenario.spend_capability_ref.clone()];

        assert_eq!(
            scenario.authorize(),
            Err(PaymentAuthorityError::SpendCapabilityAlreadyConsumed)
        );
    }

    #[test]
    fn admits_non_payment_authority_with_generic_effect_guards() {
        let parent = deployment_effect_term("parent");
        let child = deployment_effect_term("child");
        let child_harness_ref = reference(ReferenceType::Harness, "runx:harness:deploy");

        let decision = admit_step_authority(StepAuthorityAdmission {
            parent_authority: &parent,
            child_authority: &child,
            reservation_decision: None,
            subset_proof: None,
            child_harness_ref: &child_harness_ref,
            act_id: "act_deploy",
            idempotency_key: Some("deploy:prod:1"),
            spend_capability_binding: None,
            consumed_spend_capability_refs: &[],
            spend_capability_ref: None,
        });

        assert!(
            matches!(
                decision,
                Ok(ref decision)
                    if decision.verb.is_none()
                        && decision.effect_family == Some("deployment")
                        && decision.receipt_before_success_required
                        && decision.non_replay_required
            ),
            "generic effect authority should admit without payment rail state: {decision:?}"
        );
        assert_eq!(
            authority_effect_proof_kinds(&parent, &child, "deployment"),
            vec![ProofKind::EffectFinality]
        );
    }

    struct PaymentScenario {
        parent: AuthorityTerm,
        child: AuthorityTerm,
        decision: Decision,
        rail_proof_refs: Vec<Reference>,
        consumed_spend_capability_refs: Vec<Reference>,
        child_harness_ref: Reference,
        spend_capability_ref: Reference,
        subset_proof: AuthoritySubsetProof,
    }

    impl PaymentScenario {
        fn standard() -> Self {
            Self::with_child(child_spend_term())
        }

        fn with_child(child: AuthorityTerm) -> Self {
            let parent = parent_spend_term();
            let subset_proof = subset_proof(&child, &parent);
            Self {
                parent,
                child,
                decision: selected_decision(),
                rail_proof_refs: vec![reference(ReferenceType::Receipt, "runx:receipt:rail-1")],
                consumed_spend_capability_refs: Vec::new(),
                child_harness_ref: reference(
                    ReferenceType::Harness,
                    "runx:harness:harness-payment-rail",
                ),
                spend_capability_ref: reference(
                    ReferenceType::Credential,
                    "runx:payment-capability:spend-1",
                ),
                subset_proof,
            }
        }

        fn with_decision(decision: Decision) -> Self {
            Self {
                decision,
                ..Self::standard()
            }
        }

        fn authorize(&self) -> Result<(), PaymentAuthorityError> {
            self.authorize_with(AuthorizationOverride::default())
        }

        fn authorize_decision(
            &self,
        ) -> Result<PaymentRailAuthorizationDecision, PaymentAuthorityError> {
            let binding = self.capability_binding();

            authorize_payment_rail(PaymentRailAuthorization {
                parent_authority: &self.parent,
                child_authority: &self.child,
                reservation_decision: Some(&self.decision),
                subset_proof: Some(&self.subset_proof),
                child_harness_ref: &self.child_harness_ref,
                act_id: ACT_ID,
                idempotency_key: Some(IDEMPOTENCY_KEY),
                spend_capability_binding: Some(binding),
                rail_proof_refs: &self.rail_proof_refs,
                consumed_spend_capability_refs: &self.consumed_spend_capability_refs,
                spend_capability_ref: Some(&self.spend_capability_ref),
            })
        }

        fn authorize_with(
            &self,
            overrides: AuthorizationOverride<'_>,
        ) -> Result<(), PaymentAuthorityError> {
            let default_binding = self.capability_binding();
            let reservation_decision = overrides
                .reservation_decision
                .unwrap_or(Some(&self.decision));
            let idempotency_key = overrides.idempotency_key.unwrap_or(Some(IDEMPOTENCY_KEY));
            let spend_capability_binding = overrides
                .spend_capability_binding
                .unwrap_or(Some(default_binding));
            let rail_proof_refs = overrides.rail_proof_refs.unwrap_or(&self.rail_proof_refs);
            let subset_proof = overrides.subset_proof.unwrap_or(Some(&self.subset_proof));

            authorize_payment_rail(PaymentRailAuthorization {
                parent_authority: &self.parent,
                child_authority: &self.child,
                reservation_decision,
                subset_proof,
                child_harness_ref: &self.child_harness_ref,
                act_id: ACT_ID,
                idempotency_key,
                spend_capability_binding,
                rail_proof_refs,
                consumed_spend_capability_refs: &self.consumed_spend_capability_refs,
                spend_capability_ref: Some(&self.spend_capability_ref),
            })
            .map(|_| ())
        }

        fn capability_binding(&self) -> PaymentSpendCapabilityBinding {
            PaymentSpendCapabilityBinding {
                child_harness_ref: self.child_harness_ref.clone(),
                act_id: ACT_ID.to_owned(),
                reservation_decision_id: "decision_payment_reservation".to_owned(),
                idempotency_key: IDEMPOTENCY_KEY.to_owned(),
                amount_minor: 1_250,
                currency: "USD".to_owned(),
                counterparty: COUNTERPARTY.to_owned(),
                rail: "card".to_owned(),
            }
        }
    }

    #[derive(Default)]
    struct AuthorizationOverride<'a> {
        reservation_decision: Option<Option<&'a Decision>>,
        subset_proof: Option<Option<&'a AuthoritySubsetProof>>,
        idempotency_key: Option<Option<&'a str>>,
        spend_capability_binding: Option<Option<PaymentSpendCapabilityBinding>>,
        rail_proof_refs: Option<&'a [Reference]>,
    }

    fn subset_proof(child: &AuthorityTerm, parent: &AuthorityTerm) -> AuthoritySubsetProof {
        AuthoritySubsetProof {
            parent_authority_ref: parent.resource_ref.clone(),
            comparison_algorithm: "runx.payment-authority-subset.v1".into(),
            result: AuthoritySubsetResult::Subset,
            compared_terms: vec![AuthoritySubsetComparison {
                child_term_id: child.term_id.clone(),
                parent_term_id: parent.term_id.clone(),
                relation: AuthoritySubsetRelation::Subset,
            }],
            proof_ref: None,
            checked_at: "2026-05-22T00:00:00Z".into(),
        }
    }

    fn parent_spend_term() -> AuthorityTerm {
        payment_term(
            "parent",
            vec![
                AuthorityVerb::Estimate,
                AuthorityVerb::Prepare,
                AuthorityVerb::Commit,
                AuthorityVerb::Verify,
            ],
            PaymentShape::new(10_000, &["card", "ach"]),
        )
    }

    fn child_spend_term() -> AuthorityTerm {
        payment_term(
            "child",
            vec![AuthorityVerb::Prepare, AuthorityVerb::Commit],
            PaymentShape::new(2_500, &["card"]),
        )
    }

    fn child_wildcard_counterparty_term() -> AuthorityTerm {
        let mut term = child_spend_term();
        if let Some(payment) = term.bounds.effect_limits.first_mut() {
            payment.peer = Some("*".into());
        }
        term
    }

    struct PaymentShape {
        max_per_call_units: u64,
        rails: Vec<String>,
    }

    impl PaymentShape {
        fn new(max_per_call_units: u64, rails: &[&str]) -> Self {
            Self {
                max_per_call_units,
                rails: rails.iter().map(|rail| (*rail).to_owned()).collect(),
            }
        }
    }

    fn payment_term(
        term_id: &str,
        verbs: Vec<AuthorityVerb>,
        shape: PaymentShape,
    ) -> AuthorityTerm {
        AuthorityTerm {
            term_id: term_id.into(),
            principal_ref: reference(ReferenceType::Principal, "runx:principal:merchant-agent"),
            resource_ref: reference(ReferenceType::Grant, "runx:payment-grant:checkout"),
            resource_family: AuthorityResourceFamily::Effect,
            verbs,
            bounds: AuthorityBounds {
                effect_limits: vec![AuthorityEffectLimit {
                    family: "payment".into(),
                    unit: "USD".into(),
                    max_per_call_units: Some(shape.max_per_call_units),
                    max_per_run_units: Some(25_000),
                    max_per_period_units: None,
                    period: None,
                    channels: shape.rails.into_iter().map(Into::into).collect(),
                    realm: None,
                    peer: Some(COUNTERPARTY.into()),
                    operation: Some("checkout".into()),
                    preflight_ttl_ms: Some(120_000),
                    approval_threshold_units: Some(7_500),
                    authorization_form: Some(AuthorityEffectCredentialForm::SingleUseCapability),
                    preflight_required: true,
                    commitment_required: true,
                    idempotency_required: true,
                    recovery_required: true,
                    receipt_before_success: true,
                    single_use_capability: true,
                }],
                ..AuthorityBounds::default()
            },
            conditions: Vec::new(),
            approvals: Vec::new(),
            capabilities: vec![AuthorityCapability::EffectSingleUseCapability],
            expires_at: Some("2026-05-21T00:00:00Z".into()),
            issued_by_ref: reference(ReferenceType::Grant, "runx:grant:issuer"),
            credential_ref: Some(reference(
                ReferenceType::Credential,
                "runx:credential:payment-session",
            )),
        }
    }

    fn deployment_effect_term(term_id: &str) -> AuthorityTerm {
        AuthorityTerm {
            term_id: term_id.into(),
            principal_ref: reference(ReferenceType::Principal, "runx:principal:deploy-agent"),
            resource_ref: reference(ReferenceType::Deployment, "runx:deployment:prod"),
            resource_family: AuthorityResourceFamily::Deployment,
            verbs: vec![AuthorityVerb::Update],
            bounds: AuthorityBounds {
                effects: vec![AuthorityEffectGuard {
                    family: "deployment".into(),
                    guard_kinds: vec![
                        AuthorityEffectGuardKind::ReceiptBeforeSuccess,
                        AuthorityEffectGuardKind::NonReplay,
                    ],
                    proof_kinds: vec![ProofKind::EffectFinality],
                }],
                ..AuthorityBounds::default()
            },
            conditions: Vec::new(),
            approvals: Vec::new(),
            capabilities: Vec::new(),
            expires_at: Some("2026-05-21T00:00:00Z".into()),
            issued_by_ref: reference(ReferenceType::Grant, "runx:grant:issuer"),
            credential_ref: None,
        }
    }

    fn selected_decision() -> Decision {
        Decision {
            decision_id: "decision_payment_reservation".into(),
            choice: DecisionChoice::Continue,
            inputs: DecisionInputs::default(),
            proposed_intent: intent(),
            selected_act_id: Some(ACT_ID.into()),
            selected_harness_ref: None,
            justification: DecisionJustification {
                summary: "reservation selected a bounded spend act".into(),
                evidence_refs: Vec::new(),
            },
            closure: None,
            artifact_refs: Vec::new(),
        }
    }

    fn unselected_decision() -> Decision {
        Decision {
            selected_act_id: None,
            selected_harness_ref: None,
            ..selected_decision()
        }
    }

    fn intent() -> Intent {
        Intent {
            purpose: "complete a bounded checkout payment".into(),
            legitimacy: "authorized by selected reservation decision".into(),
            success_criteria: Vec::new(),
            constraints: Vec::new(),
            derived_from: Vec::new(),
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

    fn payment_condition() -> AuthorityCondition {
        AuthorityCondition {
            condition_id: "condition_payment_receipt".into(),
            predicate: AuthorityConditionPredicate::EffectProofPresent,
            refs: Vec::new(),
            parameters: None,
        }
    }

    fn payment_approval() -> AuthorityApproval {
        AuthorityApproval {
            approval_ref: reference(ReferenceType::Decision, "runx:decision:payment-approval"),
            approved_by_ref: Some(reference(
                ReferenceType::Principal,
                "runx:principal:operator",
            )),
            approved_at: Some("2026-05-20T00:00:00Z".into()),
            criterion_ids: vec!["payment_receipt".into()],
        }
    }
}

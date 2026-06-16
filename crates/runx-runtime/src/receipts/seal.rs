// rust-style-allow: large-file because receipt construction, explicit
// signature policy, and local proof sealing stay together until the runtime
// receipt builder is split out.
use std::collections::BTreeMap;

use crate::adapter::{CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA, SkillOutput};
use crate::effects::{RuntimeEffectRegistry, effect_verification_refs};
use crate::execution::output_projection::{
    StepOutputProjection, StepOutputRefs, project_step_output,
};
use crate::{RuntimeError, StepRun};
use runx_contracts::schema::NonEmptyString;
use runx_contracts::{
    ActForm, AuthorityAttenuation, AuthoritySubsetResult, Closure, ClosureDisposition,
    CredentialDeliveryObservation, CriterionBinding, CriterionStatus, Decision, DecisionChoice,
    DecisionInputs, DecisionJustification, FanoutReceiptSyncPoint, Intent, JsonObject, Lineage,
    RECEIPT_CANONICALIZATION, Receipt, ReceiptAct, ReceiptAuthority, ReceiptEnforcement,
    ReceiptIdempotency, ReceiptIssuer, ReceiptSchema, Reference, ReferenceType, Seal,
    SignatureAlgorithm, Subject, SuccessCriterion, json_string_field, receipt_subject_kind,
};
use runx_receipts::{
    ReceiptProofContext, ReceiptProofContextProvider, ReceiptSignature, ReceiptTreeConfig,
    SignatureVerificationFailure, SignatureVerifier, canonical_receipt_body_digest,
    content_addressed_receipt_id,
};

use super::local_runtime_issuer;
use super::signing::{
    RuntimeReceiptSigner, RuntimeReceiptSigningError, is_local_pseudo_signature,
    validate_production_issuer,
};
pub fn step_receipt(
    graph_name: &str,
    step_id: &str,
    attempt: u32,
    output: &SkillOutput,
    created_at: &str,
) -> Result<Receipt, RuntimeError> {
    let disposition = disposition(output);
    step_receipt_with_disposition(StepReceiptWithDisposition {
        graph_name,
        step_id,
        attempt,
        output,
        created_at,
        reason_code: process_reason_code(&disposition),
        disposition,
        summary: format!("step {step_id} completed"),
    })
}

pub fn step_receipt_with_signature_policy(
    graph_name: &str,
    step_id: &str,
    attempt: u32,
    output: &SkillOutput,
    created_at: &str,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    let disposition = disposition(output);
    step_receipt_with_disposition_and_policy(
        StepReceiptWithDisposition {
            graph_name,
            step_id,
            attempt,
            output,
            created_at,
            reason_code: process_reason_code(&disposition),
            disposition,
            summary: format!("step {step_id} completed"),
        },
        signature_policy,
    )
}

pub fn step_receipt_with_authority_grant_refs(
    graph_name: &str,
    step_id: &str,
    attempt: u32,
    output: &SkillOutput,
    authority_grant_refs: Vec<Reference>,
    created_at: &str,
) -> Result<Receipt, RuntimeError> {
    let disposition = disposition(output);
    let projection = project_step_output(output);
    step_receipt_with_disposition_projection_authority_and_policy(
        StepReceiptWithDisposition {
            graph_name,
            step_id,
            attempt,
            output,
            created_at,
            reason_code: process_reason_code(&disposition),
            disposition,
            summary: format!("step {step_id} completed"),
        },
        &projection,
        authority_grant_refs,
        RuntimeReceiptSignaturePolicy::local_development(),
    )
}

pub(crate) fn step_receipt_with_projection_and_signature_policy(
    graph_name: &str,
    step_id: &str,
    attempt: u32,
    output: &SkillOutput,
    projection: &StepOutputProjection,
    created_at: &str,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    step_receipt_with_projection_authority_and_signature_policy(
        StepReceiptWithProjectionAuthority {
            graph_name,
            step_id,
            attempt,
            output,
            projection,
            authority_grant_refs: Vec::new(),
            created_at,
        },
        signature_policy,
    )
}

pub(crate) struct StepReceiptWithProjectionAuthority<'a> {
    pub(crate) graph_name: &'a str,
    pub(crate) step_id: &'a str,
    pub(crate) attempt: u32,
    pub(crate) output: &'a SkillOutput,
    pub(crate) projection: &'a StepOutputProjection,
    pub(crate) authority_grant_refs: Vec<Reference>,
    pub(crate) created_at: &'a str,
}

pub(crate) fn step_receipt_with_projection_authority_and_signature_policy(
    params: StepReceiptWithProjectionAuthority<'_>,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    let StepReceiptWithProjectionAuthority {
        graph_name,
        step_id,
        attempt,
        output,
        projection,
        authority_grant_refs,
        created_at,
    } = params;
    let disposition = disposition(output);
    step_receipt_with_disposition_projection_authority_and_policy(
        StepReceiptWithDisposition {
            graph_name,
            step_id,
            attempt,
            output,
            created_at,
            reason_code: process_reason_code(&disposition),
            disposition,
            summary: format!("step {step_id} completed"),
        },
        projection,
        authority_grant_refs,
        signature_policy,
    )
}

pub(crate) struct StepReceiptWithDisposition<'a> {
    pub(crate) graph_name: &'a str,
    pub(crate) step_id: &'a str,
    pub(crate) attempt: u32,
    pub(crate) output: &'a SkillOutput,
    pub(crate) created_at: &'a str,
    pub(crate) disposition: ClosureDisposition,
    pub(crate) reason_code: String,
    pub(crate) summary: String,
}

pub(crate) fn step_receipt_with_disposition(
    params: StepReceiptWithDisposition<'_>,
) -> Result<Receipt, RuntimeError> {
    step_receipt_with_disposition_and_policy(
        params,
        RuntimeReceiptSignaturePolicy::local_development(),
    )
}

pub(crate) fn step_receipt_with_disposition_and_policy(
    params: StepReceiptWithDisposition<'_>,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    let projection = project_step_output(params.output);
    step_receipt_with_disposition_projection_and_policy(params, &projection, signature_policy)
}

pub(crate) fn step_receipt_with_disposition_projection_and_policy(
    params: StepReceiptWithDisposition<'_>,
    projection: &StepOutputProjection,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    step_receipt_with_disposition_projection_authority_and_policy(
        params,
        projection,
        Vec::new(),
        signature_policy,
    )
}

fn step_receipt_with_disposition_projection_authority_and_policy(
    params: StepReceiptWithDisposition<'_>,
    projection: &StepOutputProjection,
    authority_grant_refs: Vec<Reference>,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    let StepReceiptWithDisposition {
        graph_name,
        step_id,
        attempt,
        output,
        created_at,
        disposition,
        reason_code,
        summary,
    } = params;
    let output_refs = output_refs(output, &projection.refs);
    let act = observation_act(
        step_id,
        output,
        created_at,
        disposition.clone(),
        &output_refs,
    );
    let seal_criterion = process_exit_criterion(output, &output_refs);
    let seal = seal(
        disposition,
        reason_code,
        summary,
        created_at,
        vec![seal_criterion],
    );
    let decisions = decisions(
        step_id,
        &act,
        &output_refs.signal_refs,
        &output_refs.artifact_refs,
    );
    let mut receipt = build_receipt(BuildReceipt {
        id: step_receipt_id(graph_name, step_id, attempt),
        graph_name,
        node_id: step_id,
        kind: receipt_subject_kind::SKILL.into(),
        created_at,
        decisions,
        acts: vec![act],
        seal,
        children: Vec::new(),
        sync_points: Vec::new(),
        signals: output_refs.signal_refs,
        authority_grant_refs,
        authority_override: None,
        previous: None,
    });
    seal_receipt_unvalidated(&mut receipt, signature_policy)?;
    Ok(receipt)
}

/// The single `process_exit` criterion binding a step receipt seals on, derived
/// from the skill output and its reference set.
fn process_exit_criterion(output: &SkillOutput, output_refs: &StepOutputRefs) -> CriterionBinding {
    CriterionBinding {
        criterion_id: "process_exit".into(),
        status: if output.succeeded() {
            CriterionStatus::Verified
        } else {
            CriterionStatus::Failed
        },
        evidence_refs: output_refs.evidence_refs.clone(),
        verification_refs: output_refs.verification_refs.clone(),
        summary: Some(output_summary(output).into()),
    }
}

pub fn graph_receipt(
    graph_name: &str,
    steps: &mut [StepRun],
    sync_points: Vec<FanoutReceiptSyncPoint>,
    created_at: &str,
) -> Result<Receipt, RuntimeError> {
    graph_receipt_with_disposition(
        graph_name,
        steps,
        sync_points,
        created_at,
        ClosureDisposition::Closed,
        "graph_closed".to_owned(),
        format!("graph {graph_name} completed"),
    )
}

pub fn graph_receipt_with_signature_policy(
    graph_name: &str,
    steps: &mut [StepRun],
    sync_points: Vec<FanoutReceiptSyncPoint>,
    created_at: &str,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    graph_receipt_with_effects_and_signature_policy(
        graph_name,
        steps,
        sync_points,
        created_at,
        RuntimeEffectRegistry::default(),
        signature_policy,
    )
}

pub(crate) fn graph_receipt_with_effects_and_signature_policy(
    graph_name: &str,
    steps: &mut [StepRun],
    sync_points: Vec<FanoutReceiptSyncPoint>,
    created_at: &str,
    effects: RuntimeEffectRegistry,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    graph_receipt_with_disposition_and_policy(
        graph_name,
        steps,
        sync_points,
        created_at,
        GraphClosure {
            disposition: ClosureDisposition::Closed,
            reason_code: "graph_closed".to_owned(),
            summary: format!("graph {graph_name} completed"),
        },
        effects,
        signature_policy,
    )
}

pub(crate) fn graph_receipt_with_disposition(
    graph_name: &str,
    steps: &mut [StepRun],
    sync_points: Vec<FanoutReceiptSyncPoint>,
    created_at: &str,
    disposition: ClosureDisposition,
    reason_code: String,
    summary: String,
) -> Result<Receipt, RuntimeError> {
    graph_receipt_with_disposition_and_policy(
        graph_name,
        steps,
        sync_points,
        created_at,
        GraphClosure {
            disposition,
            reason_code,
            summary,
        },
        RuntimeEffectRegistry::default(),
        RuntimeReceiptSignaturePolicy::local_development(),
    )
}

pub(crate) struct GraphClosure {
    pub(crate) disposition: ClosureDisposition,
    pub(crate) reason_code: String,
    pub(crate) summary: String,
}

pub(crate) fn graph_receipt_with_disposition_and_policy(
    graph_name: &str,
    steps: &mut [StepRun],
    sync_points: Vec<FanoutReceiptSyncPoint>,
    created_at: &str,
    closure: GraphClosure,
    effects: RuntimeEffectRegistry,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    // Pass 1: learn the stable content-addressed id. The final pass below is
    // the only graph body digest/signature/proof seal this path needs.
    let mut receipt =
        build_graph_receipt(graph_name, Vec::new(), &sync_points, created_at, &closure);
    content_address_receipt(&mut receipt, signature_policy)?;
    let parent_ref = Reference::runx(ReferenceType::Receipt, &receipt.id);

    // Attach the parent link only to the terminal receipt for each step and
    // re-seal those children. Earlier retry attempts remain in the run history,
    // but they are superseded audit receipts, not active graph children.
    let current_child_indexes = current_step_indexes(steps);
    attach_parent_to_child_receipts(
        steps,
        &current_child_indexes,
        &parent_ref,
        &effects,
        signature_policy,
    )?;
    let child_refs = current_child_indexes
        .iter()
        .map(|index| child_receipt_reference(&steps[*index].receipt))
        .collect::<Vec<_>>();

    // Pass 2: re-seal the graph with the final child refs. The content address
    // is unchanged (lineage excluded); only the full digest commits the children.
    let mut receipt =
        build_graph_receipt(graph_name, child_refs, &sync_points, created_at, &closure);
    seal_receipt_unvalidated(&mut receipt, signature_policy)?;

    validate_receipt_tree_with_policy(
        &receipt,
        current_child_indexes
            .iter()
            .map(|index| &steps[*index].receipt),
        signature_policy,
    )?;
    Ok(receipt)
}

fn build_graph_receipt(
    graph_name: &str,
    children: Vec<Reference>,
    sync_points: &[FanoutReceiptSyncPoint],
    created_at: &str,
    closure: &GraphClosure,
) -> Receipt {
    build_receipt(BuildReceipt {
        id: format!("hrn_rcpt_{graph_name}"),
        graph_name,
        node_id: "graph",
        kind: receipt_subject_kind::GRAPH.into(),
        created_at,
        decisions: Vec::new(),
        acts: Vec::new(),
        seal: seal(
            closure.disposition.clone(),
            closure.reason_code.clone(),
            closure.summary.clone(),
            created_at,
            Vec::new(),
        ),
        children,
        sync_points: sync_points.to_vec(),
        signals: Vec::new(),
        authority_grant_refs: Vec::new(),
        authority_override: None,
        previous: None,
    })
}

fn validate_receipt_tree_with_policy<'a>(
    root: &Receipt,
    children: impl IntoIterator<Item = &'a Receipt>,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<(), RuntimeError> {
    super::tree::validate_runtime_receipt_tree_refs_with_policy(
        root,
        children,
        ReceiptTreeConfig::default(),
        signature_policy,
    )
    .map_err(receipt_error)
}

fn step_receipt_id(graph_name: &str, step_id: &str, attempt: u32) -> String {
    if attempt <= 1 {
        format!("hrn_rcpt_{graph_name}_{step_id}")
    } else {
        format!("hrn_rcpt_{graph_name}_{step_id}_attempt_{attempt}")
    }
}

fn process_reason_code(disposition: &ClosureDisposition) -> String {
    let suffix = match disposition {
        ClosureDisposition::Closed => "closed",
        ClosureDisposition::Deferred => "deferred",
        ClosureDisposition::Superseded => "superseded",
        ClosureDisposition::Declined => "declined",
        ClosureDisposition::Blocked => "blocked",
        ClosureDisposition::Failed => "failed",
        ClosureDisposition::Killed => "killed",
        ClosureDisposition::TimedOut => "timed_out",
    };
    format!("process_{suffix}")
}

struct BuildReceipt<'a> {
    id: String,
    graph_name: &'a str,
    node_id: &'a str,
    kind: NonEmptyString,
    created_at: &'a str,
    decisions: Vec<Decision>,
    acts: Vec<ReceiptAct>,
    seal: Seal,
    children: Vec<Reference>,
    sync_points: Vec<FanoutReceiptSyncPoint>,
    signals: Vec<Reference>,
    authority_grant_refs: Vec<Reference>,
    /// Fully-built authority for a domain act seal. When `None`, the generic
    /// `local_runtime` authority is used (unchanged for every existing caller).
    authority_override: Option<ReceiptAuthority>,
    /// The predecessor receipt this one chains from (`lineage.previous`), e.g. a
    /// judgment chaining from the delivery it judged. `None` for generic seals.
    previous: Option<Reference>,
}

fn build_receipt(parts: BuildReceipt<'_>) -> Receipt {
    let BuildReceipt {
        id,
        graph_name,
        node_id,
        kind,
        created_at,
        decisions,
        acts,
        seal,
        children,
        sync_points,
        signals,
        authority_grant_refs,
        authority_override,
        previous,
    } = parts;
    let lineage = Lineage {
        parent: None,
        previous,
        children,
        sync: sync_points,
        resume_ref: None,
    };
    Receipt {
        schema: ReceiptSchema::V1,
        id: id.into(),
        created_at: created_at.into(),
        canonicalization: RECEIPT_CANONICALIZATION.into(),
        issuer: local_runtime_issuer(),
        signature: placeholder_signature(),
        digest: "sha256:runtime-skeleton".into(),
        idempotency: idempotency(graph_name, node_id),
        subject: subject(graph_name, node_id, kind),
        authority: authority_override.unwrap_or_else(|| authority(authority_grant_refs)),
        signals,
        decisions,
        acts,
        seal,
        lineage: Some(lineage),
        metadata: None,
    }
}

/// The planner deliberation, inline in `decisions[]`. The `selected_act_id`
/// integrity property is checked against the inline `acts[]` at verify time.
fn decisions(
    node_id: &str,
    act: &ReceiptAct,
    signal_refs: &[Reference],
    artifact_refs: &[Reference],
) -> Vec<Decision> {
    vec![Decision {
        decision_id: format!("dec_{node_id}").into(),
        choice: DecisionChoice::Open,
        inputs: DecisionInputs {
            signal_refs: signal_refs.to_vec(),
            ..DecisionInputs::default()
        },
        proposed_intent: Intent {
            purpose: format!("Open runtime node {node_id}").into(),
            legitimacy: "Local graph execution requested this node".into(),
            success_criteria: Vec::new(),
            constraints: Vec::new(),
            derived_from: Vec::new(),
        },
        selected_act_id: Some(act.id.clone()),
        selected_harness_ref: None,
        justification: DecisionJustification {
            summary: "runtime graph planner selected this node".into(),
            evidence_refs: signal_refs.to_vec(),
        },
        closure: None,
        artifact_refs: artifact_refs.to_vec(),
    }]
}

fn observation_act(
    step_id: &str,
    output: &SkillOutput,
    performed_at: &str,
    disposition: ClosureDisposition,
    refs: &StepOutputRefs,
) -> ReceiptAct {
    let mut artifact_refs = refs.artifact_refs.clone();
    artifact_refs.extend(refs.surface_refs.iter().cloned());
    ReceiptAct {
        id: format!("act_{step_id}").into(),
        form: ActForm::Observation,
        intent: Intent {
            purpose: format!("Run graph step {step_id}").into(),
            legitimacy: "Runtime graph execution was admitted by the local harness".into(),
            success_criteria: vec![SuccessCriterion {
                criterion_id: "process_exit".into(),
                statement: "cli-tool exits successfully".into(),
                required: true,
            }],
            constraints: Vec::new(),
            derived_from: Vec::new(),
        },
        summary: format!("Executed graph step {step_id}").into(),
        criterion_bindings: vec![CriterionBinding {
            criterion_id: "process_exit".into(),
            status: if output.succeeded() {
                CriterionStatus::Verified
            } else {
                CriterionStatus::Failed
            },
            evidence_refs: refs.evidence_refs.clone(),
            verification_refs: refs.verification_refs.clone(),
            summary: Some(output_summary(output).into()),
        }],
        by: None,
        source_refs: refs.source_refs.clone(),
        target_refs: Vec::new(),
        artifact_refs,
        context_ref: None,
        closure: Closure {
            disposition,
            reason_code: "process_exit".into(),
            summary: output_summary(output).into(),
            closed_at: performed_at.into(),
        },
        revision: None,
        verification: None,
    }
}

fn seal(
    disposition: ClosureDisposition,
    reason_code: String,
    summary: String,
    closed_at: &str,
    criteria: Vec<CriterionBinding>,
) -> Seal {
    Seal {
        disposition,
        reason_code: reason_code.into(),
        summary: summary.into(),
        closed_at: closed_at.into(),
        last_observed_at: closed_at.into(),
        criteria,
    }
}

fn subject(graph_name: &str, node_id: &str, kind: NonEmptyString) -> Subject {
    Subject {
        kind,
        // The subject reference retains the harness identity (`hrn_<graph>_<node>`)
        // so history/replay projections keep a stable subject id.
        reference: Reference::with_uri(
            ReferenceType::Harness,
            format!("hrn_{graph_name}_{node_id}"),
        ),
        input_context: None,
        commitments: Vec::new(),
    }
}

fn authority(grant_refs: Vec<Reference>) -> ReceiptAuthority {
    ReceiptAuthority {
        actor_ref: Reference::runx(ReferenceType::Principal, "local_runtime"),
        authority_proof_refs: Vec::new(),
        grant_refs,
        scope_refs: Vec::new(),
        terms: Vec::new(),
        attenuation: AuthorityAttenuation {
            parent_authority_ref: None,
            subset_proof: None,
        },
        mandate_ref: None,
        enforcement: ReceiptEnforcement {
            profile_hash: "sha256:runtime-skeleton-enforcement".into(),
            redaction_refs: Vec::new(),
            setup_refs: Vec::new(),
            teardown_refs: Vec::new(),
        },
    }
}

/// A governed turn's domain act, assembled from trusted sources (the skill's act
/// declaration, the driver's pinned beat inputs, the delivered credential) plus
/// the model's reason text. This is what makes a receipt read as "operator judged
/// claim c-4417, rejected" instead of "a turn ran". The model never sets the
/// form, target, choice, or authority; it supplies only the reason prose.
pub(crate) struct DomainActFrame {
    pub form: ActForm,
    pub purpose: NonEmptyString,
    pub legitimacy: NonEmptyString,
    pub summary: NonEmptyString,
    pub target_refs: Vec<Reference>,
    pub artifact_refs: Vec<Reference>,
    pub decision_choice: DecisionChoice,
    pub decision_summary: NonEmptyString,
    pub actor_ref: Reference,
    pub authority_grant_refs: Vec<Reference>,
    pub authority_scope_refs: Vec<Reference>,
    pub previous: Option<Reference>,
}

/// Seal a governed turn as its domain act. Reuses the generic receipt assembly
/// (`build_receipt`/`seal`) but fills the act, decision, and authority from the
/// trusted `DomainActFrame`. Transport (tool names, urls, status codes, tokens)
/// never enters the receipt.
pub(crate) fn domain_act_receipt(
    graph_name: &str,
    step_id: &str,
    succeeded: bool,
    created_at: &str,
    disposition: ClosureDisposition,
    reason_code: String,
    seal_summary: String,
    frame: DomainActFrame,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    let status = if succeeded {
        CriterionStatus::Verified
    } else {
        CriterionStatus::Failed
    };
    let closure = Closure {
        disposition: disposition.clone(),
        reason_code: reason_code.clone().into(),
        summary: frame.summary.clone(),
        closed_at: created_at.into(),
    };
    let criterion = CriterionBinding {
        criterion_id: "act_closed".into(),
        status,
        evidence_refs: Vec::new(),
        verification_refs: Vec::new(),
        summary: Some(frame.summary.clone()),
    };
    let intent = Intent {
        purpose: frame.purpose.clone(),
        legitimacy: frame.legitimacy.clone(),
        success_criteria: Vec::new(),
        constraints: Vec::new(),
        derived_from: Vec::new(),
    };
    let act = ReceiptAct {
        id: format!("act_{step_id}").into(),
        form: frame.form,
        intent: intent.clone(),
        summary: frame.summary.clone(),
        criterion_bindings: vec![criterion.clone()],
        by: None,
        source_refs: Vec::new(),
        target_refs: frame.target_refs.clone(),
        artifact_refs: frame.artifact_refs.clone(),
        context_ref: None,
        closure: closure.clone(),
        revision: None,
        verification: None,
    };
    let decision = Decision {
        decision_id: format!("dec_{step_id}").into(),
        choice: frame.decision_choice,
        inputs: DecisionInputs {
            target_ref: frame.target_refs.first().cloned(),
            ..DecisionInputs::default()
        },
        proposed_intent: intent,
        selected_act_id: Some(act.id.clone()),
        selected_harness_ref: None,
        justification: DecisionJustification {
            summary: frame.decision_summary,
            evidence_refs: Vec::new(),
        },
        closure: Some(closure),
        artifact_refs: frame.artifact_refs.clone(),
    };
    let authority = ReceiptAuthority {
        actor_ref: frame.actor_ref,
        authority_proof_refs: Vec::new(),
        grant_refs: frame.authority_grant_refs,
        scope_refs: frame.authority_scope_refs,
        terms: Vec::new(),
        attenuation: AuthorityAttenuation {
            parent_authority_ref: None,
            subset_proof: None,
        },
        mandate_ref: None,
        enforcement: ReceiptEnforcement {
            profile_hash: "sha256:runtime-skeleton-enforcement".into(),
            redaction_refs: Vec::new(),
            setup_refs: Vec::new(),
            teardown_refs: Vec::new(),
        },
    };
    let seal = seal(disposition, reason_code, seal_summary, created_at, vec![criterion]);
    let mut receipt = build_receipt(BuildReceipt {
        id: step_receipt_id(graph_name, step_id, 1),
        graph_name,
        node_id: step_id,
        kind: receipt_subject_kind::SKILL.into(),
        created_at,
        decisions: vec![decision],
        acts: vec![act],
        seal,
        children: Vec::new(),
        sync_points: Vec::new(),
        signals: Vec::new(),
        authority_grant_refs: Vec::new(),
        authority_override: Some(authority),
        previous: frame.previous,
    });
    seal_receipt_unvalidated(&mut receipt, signature_policy)?;
    Ok(receipt)
}

fn idempotency(graph_name: &str, node_id: &str) -> ReceiptIdempotency {
    ReceiptIdempotency {
        intent_key: format!("sha256:{graph_name}-{node_id}-intent").into(),
        trigger_fingerprint: format!("sha256:{graph_name}-{node_id}-trigger").into(),
        content_hash: format!("sha256:{graph_name}-{node_id}-content").into(),
    }
}

fn output_refs(output: &SkillOutput, projected_refs: &StepOutputRefs) -> StepOutputRefs {
    let mut refs = projected_refs.clone();
    if let Some(request_id) = json_string_field(&output.metadata, "agent_request_id") {
        let reference = Reference {
            uri: format!("runx:agent_act:{request_id}").into(),
            reference_type: ReferenceType::Act,
            provider: None,
            locator: Some(request_id.to_owned().into()),
            label: Some("agent act request".to_owned().into()),
            observed_at: None,
            proof_kind: None,
        };
        refs.source_refs.insert(0, reference.clone());
        refs.evidence_refs.insert(0, reference);
    }
    collect_supervisor_metadata_refs(&output.metadata, &mut refs);
    collect_credential_delivery_refs(&output.metadata, &mut refs);
    refs
}

fn collect_supervisor_metadata_refs(metadata: &JsonObject, refs: &mut StepOutputRefs) {
    let Ok(mut verification_refs) = effect_verification_refs(metadata) else {
        return;
    };
    refs.verification_refs.append(&mut verification_refs);
}

fn collect_credential_delivery_refs(metadata: &JsonObject, refs: &mut StepOutputRefs) {
    let Some(value) = metadata.get(CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA) else {
        return;
    };
    let Ok(encoded) = serde_json::to_string(value) else {
        return;
    };
    let Ok(observations) = serde_json::from_str::<Vec<CredentialDeliveryObservation>>(&encoded)
    else {
        return;
    };

    for reference in observations
        .into_iter()
        .flat_map(|observation| observation.credential_refs)
    {
        if !refs
            .verification_refs
            .iter()
            .any(|existing| existing == &reference)
        {
            refs.verification_refs.push(reference);
        }
    }
}

fn disposition(output: &SkillOutput) -> ClosureDisposition {
    if output.succeeded() {
        ClosureDisposition::Closed
    } else {
        ClosureDisposition::Failed
    }
}

fn output_summary(output: &SkillOutput) -> String {
    if output.succeeded() {
        "cli-tool exited successfully".to_owned()
    } else if !output.stderr.is_empty() {
        output.stderr.clone()
    } else {
        format!("cli-tool failed with exit code {:?}", output.exit_code)
    }
}

fn child_receipt_reference(receipt: &Receipt) -> Reference {
    Reference {
        locator: Some(receipt.digest.clone()),
        ..Reference::runx(ReferenceType::Receipt, &receipt.id)
    }
}

fn current_step_indexes(steps: &[StepRun]) -> Vec<usize> {
    let mut latest = BTreeMap::<&str, usize>::new();
    for (index, step) in steps.iter().enumerate() {
        latest.insert(step.step_id.as_str(), index);
    }
    steps
        .iter()
        .enumerate()
        .filter_map(|(index, step)| {
            latest
                .get(step.step_id.as_str())
                .is_some_and(|latest_index| *latest_index == index)
                .then_some(index)
        })
        .collect()
}

fn attach_parent_to_child_receipts(
    steps: &mut [StepRun],
    current_child_indexes: &[usize],
    parent_ref: &Reference,
    effects: &RuntimeEffectRegistry,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<(), RuntimeError> {
    for index in current_child_indexes {
        let step = steps
            .get_mut(*index)
            .ok_or_else(|| RuntimeError::ReceiptInvalid {
                message: format!("graph child receipt index {index} is out of range"),
            })?;
        step.receipt
            .lineage
            .get_or_insert_with(Lineage::default)
            .parent = Some(parent_ref.clone());
        seal_receipt_unvalidated(&mut step.receipt, signature_policy)?;
        effects
            .refresh_output_metadata(&mut step.output, &step.receipt)
            .map_err(|error| RuntimeError::ReceiptInvalid {
                message: error.to_string(),
            })?;
    }
    Ok(())
}

fn placeholder_signature() -> ReceiptSignature {
    ReceiptSignature {
        alg: SignatureAlgorithm::Ed25519,
        value: "sig:pending".into(),
    }
}

fn seal_receipt_unvalidated(
    receipt: &mut Receipt,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<String, RuntimeError> {
    // Content-address the id over the canonical body (id = hash(canonical_body),
    // excluding id/signature/digest/metadata/lineage) before the digest commits
    // it. Lineage is excluded so parent<->child wiring does not perturb the id.
    content_address_receipt(receipt, signature_policy)?;
    let digest =
        canonical_receipt_body_digest(receipt).map_err(|error| RuntimeError::ReceiptInvalid {
            message: error.to_string(),
        })?;
    receipt.digest = digest.clone().into();
    signature_policy.sign_receipt(receipt, &digest)?;
    Ok(digest)
}

fn content_address_receipt(
    receipt: &mut Receipt,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<(), RuntimeError> {
    signature_policy.prepare_receipt(receipt)?;
    receipt.id = content_addressed_receipt_id(receipt)
        .map_err(|error| RuntimeError::ReceiptInvalid {
            message: error.to_string(),
        })?
        .into();
    Ok(())
}

pub(crate) fn proof_context<'a>(
    signature_verifier: Option<&'a dyn SignatureVerifier>,
    receipt: &Receipt,
) -> ReceiptProofContext<'a> {
    ReceiptProofContext {
        signature_verifier,
        authority_verified: authority_attenuation_verified(&receipt.authority.attenuation),
        external_attestations_verified: true,
        verified_redaction_refs: std::collections::BTreeSet::new(),
        verified_hash_commitments: std::collections::BTreeSet::new(),
    }
}

#[derive(Clone, Copy)]
pub struct RuntimeReceiptSignaturePolicy<'a> {
    mode: RuntimeReceiptSignatureMode,
    production_signer: Option<&'a dyn RuntimeReceiptSigner>,
    production_verifier: Option<&'a dyn SignatureVerifier>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuntimeReceiptSignatureMode {
    LocalDevelopment,
    Production,
}

impl std::fmt::Debug for RuntimeReceiptSignaturePolicy<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeReceiptSignaturePolicy")
            .field("mode", &self.mode)
            .field(
                "production_signer_supplied",
                &self.production_signer.is_some(),
            )
            .field(
                "production_verifier_supplied",
                &self.production_verifier.is_some(),
            )
            .finish()
    }
}

impl<'a> RuntimeReceiptSignaturePolicy<'a> {
    #[must_use]
    pub fn local_development() -> Self {
        Self {
            mode: RuntimeReceiptSignatureMode::LocalDevelopment,
            production_signer: None,
            production_verifier: None,
        }
    }

    #[must_use]
    pub fn production(verifier: &'a dyn SignatureVerifier) -> Self {
        Self {
            mode: RuntimeReceiptSignatureMode::Production,
            production_signer: None,
            production_verifier: Some(verifier),
        }
    }

    #[must_use]
    pub fn production_signing(
        signer: &'a dyn RuntimeReceiptSigner,
        verifier: &'a dyn SignatureVerifier,
    ) -> Self {
        Self {
            mode: RuntimeReceiptSignatureMode::Production,
            production_signer: Some(signer),
            production_verifier: Some(verifier),
        }
    }

    #[must_use]
    pub fn production_signing_without_verifier(signer: &'a dyn RuntimeReceiptSigner) -> Self {
        Self {
            mode: RuntimeReceiptSignatureMode::Production,
            production_signer: Some(signer),
            production_verifier: None,
        }
    }

    #[must_use]
    pub fn production_without_verifier() -> Self {
        Self {
            mode: RuntimeReceiptSignatureMode::Production,
            production_signer: None,
            production_verifier: None,
        }
    }

    #[must_use]
    pub fn allows_local_pseudo_signatures(&self) -> bool {
        self.mode == RuntimeReceiptSignatureMode::LocalDevelopment
    }

    #[must_use]
    pub fn can_report_production_verified(&self) -> bool {
        self.mode == RuntimeReceiptSignatureMode::Production && self.production_verifier.is_some()
    }

    fn prepare_receipt(self, receipt: &mut Receipt) -> Result<(), RuntimeError> {
        if self.allows_local_pseudo_signatures() {
            receipt.issuer = local_runtime_issuer();
            return Ok(());
        }
        let Some(signer) = self.production_signer else {
            return Err(signing_error(RuntimeReceiptSigningError::MissingSigner));
        };
        if self.production_verifier.is_none() {
            return Err(signing_error(RuntimeReceiptSigningError::MissingVerifier));
        }
        let issuer = signer.issuer();
        validate_production_issuer(&issuer).map_err(signing_error)?;
        receipt.issuer = issuer;
        Ok(())
    }

    fn sign_receipt(self, receipt: &mut Receipt, body_digest: &str) -> Result<(), RuntimeError> {
        if self.allows_local_pseudo_signatures() {
            receipt.signature.value = format!("sig:{body_digest}").into();
            return Ok(());
        }
        let Some(signer) = self.production_signer else {
            return Err(signing_error(RuntimeReceiptSigningError::MissingSigner));
        };
        let Some(verifier) = self.production_verifier else {
            return Err(signing_error(RuntimeReceiptSigningError::MissingVerifier));
        };
        let signature = signer
            .sign_receipt_body(body_digest)
            .map_err(signing_error)?;
        if signature.alg != SignatureAlgorithm::Ed25519 {
            return Err(signing_error(
                RuntimeReceiptSigningError::UnsupportedAlgorithm,
            ));
        }
        if is_local_pseudo_signature(&signature.value) {
            return Err(signing_error(RuntimeReceiptSigningError::PseudoSignature));
        }
        receipt.signature = signature;
        verifier
            .verify(&receipt.issuer, &receipt.signature, body_digest)
            .map_err(RuntimeReceiptSigningError::SignatureVerification)
            .map_err(signing_error)
    }

    fn verifier(self) -> Option<RuntimeReceiptSignatureVerifier<'a>> {
        if self.mode == RuntimeReceiptSignatureMode::Production
            && self.production_verifier.is_none()
        {
            return None;
        }
        Some(RuntimeReceiptSignatureVerifier { policy: self })
    }
}

pub(crate) struct RuntimeReceiptProofContextProvider<'a> {
    signature_verifier: Option<RuntimeReceiptSignatureVerifier<'a>>,
}

impl<'a> RuntimeReceiptProofContextProvider<'a> {
    pub(crate) fn new(signature_policy: RuntimeReceiptSignaturePolicy<'a>) -> Self {
        Self {
            signature_verifier: signature_policy.verifier(),
        }
    }
}

impl ReceiptProofContextProvider for RuntimeReceiptProofContextProvider<'_> {
    fn proof_context<'a>(&'a self, receipt: &Receipt) -> ReceiptProofContext<'a> {
        proof_context(
            self.signature_verifier
                .as_ref()
                .map(|verifier| verifier as &dyn SignatureVerifier),
            receipt,
        )
    }
}

struct RuntimeReceiptSignatureVerifier<'a> {
    policy: RuntimeReceiptSignaturePolicy<'a>,
}

impl SignatureVerifier for RuntimeReceiptSignatureVerifier<'_> {
    fn verify(
        &self,
        issuer: &ReceiptIssuer,
        signature: &ReceiptSignature,
        body_digest: &str,
    ) -> Result<(), SignatureVerificationFailure> {
        if is_local_pseudo_signature(&signature.value) {
            return if self.policy.allows_local_pseudo_signatures()
                && signature.value == format!("sig:{body_digest}")
            {
                Ok(())
            } else if self.policy.allows_local_pseudo_signatures() {
                Err(SignatureVerificationFailure::SignatureMismatch)
            } else {
                Err(SignatureVerificationFailure::MalformedSignature)
            };
        }
        let Some(verifier) = self.policy.production_verifier else {
            return Err(SignatureVerificationFailure::MissingKey);
        };
        verifier.verify(issuer, signature, body_digest)
    }
}

fn signing_error(error: RuntimeReceiptSigningError) -> RuntimeError {
    RuntimeError::ReceiptInvalid {
        message: error.to_string(),
    }
}

fn authority_attenuation_verified(attenuation: &AuthorityAttenuation) -> bool {
    match (&attenuation.parent_authority_ref, &attenuation.subset_proof) {
        (Some(parent), Some(proof)) => {
            proof.parent_authority_ref == *parent
                && matches!(proof.result, AuthoritySubsetResult::Subset)
        }
        (Some(_), None) | (None, Some(_)) => false,
        (None, None) => false,
    }
}

fn receipt_error(verification: runx_receipts::ReceiptVerification) -> RuntimeError {
    RuntimeError::ReceiptInvalid {
        message: format!("{:?}", verification.findings),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::InvocationStatus;
    use runx_contracts::{
        CredentialDeliveryMode, CredentialDeliveryObservationSchema,
        CredentialDeliveryObservationStatus, CredentialDeliveryPurpose, CredentialMaterialRole,
        JsonValue, ProofKind,
    };

    /// Concrete error type for fallible tests, so `?` propagates the receipt and
    /// serialization errors a test exercises without erasing them behind a trait
    /// object.
    #[derive(Debug)]
    struct TestError(String);

    impl std::fmt::Display for TestError {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str(&self.0)
        }
    }

    impl From<RuntimeError> for TestError {
        fn from(error: RuntimeError) -> Self {
            Self(error.to_string())
        }
    }

    impl From<runx_receipts::ReceiptError> for TestError {
        fn from(error: runx_receipts::ReceiptError) -> Self {
            Self(error.to_string())
        }
    }

    impl From<serde_json::Error> for TestError {
        fn from(error: serde_json::Error) -> Self {
            Self(error.to_string())
        }
    }

    #[test]
    fn credential_delivery_refs_are_sealed_as_verification_refs() -> Result<(), TestError> {
        let receipt = step_receipt(
            "credential_graph",
            "credential_step",
            1,
            &credential_output()?,
            "2026-05-28T00:00:00Z",
        )?;

        let verification_refs = &receipt.acts[0].criterion_bindings[0].verification_refs;
        assert_eq!(verification_refs.len(), 1);
        assert_eq!(
            verification_refs[0].reference_type,
            ReferenceType::Credential
        );
        assert_eq!(
            verification_refs[0].uri.as_str(),
            "runx:credential:grant_github_main"
        );
        assert_eq!(
            verification_refs[0].proof_kind,
            Some(ProofKind::CredentialResolution)
        );
        assert_eq!(
            receipt.seal.criteria[0].verification_refs,
            *verification_refs
        );

        let sealed_digest = canonical_receipt_body_digest(&receipt)?;
        let mut without_credential_ref = receipt.clone();
        without_credential_ref.acts[0].criterion_bindings[0]
            .verification_refs
            .clear();
        without_credential_ref.seal.criteria[0]
            .verification_refs
            .clear();
        let unsealed_digest = canonical_receipt_body_digest(&without_credential_ref)?;
        assert_ne!(sealed_digest, unsealed_digest);
        Ok(())
    }

    fn credential_output() -> Result<SkillOutput, TestError> {
        let observation = CredentialDeliveryObservation {
            schema: CredentialDeliveryObservationSchema::V1,
            observation_id: "credential_delivery_observation_1".into(),
            request_id: "credential_delivery_request_1".into(),
            response_id: Some("credential_delivery_response_1".into()),
            status: CredentialDeliveryObservationStatus::Delivered,
            harness_ref: Reference::with_uri(ReferenceType::Harness, "runx:harness:hrn_123"),
            host_ref: Some(Reference::with_uri(
                ReferenceType::Host,
                "runx:host:local-cli",
            )),
            profile_id: "github-api-key-env".into(),
            provider: "github".into(),
            purpose: CredentialDeliveryPurpose::ProviderApi,
            delivery_mode: Some(CredentialDeliveryMode::ProcessEnv),
            credential_refs: vec![Reference {
                reference_type: ReferenceType::Credential,
                uri: "runx:credential:grant_github_main".into(),
                provider: Some("github".into()),
                locator: None,
                label: None,
                observed_at: None,
                proof_kind: Some(ProofKind::CredentialResolution),
            }],
            material_ref_hash: Some("sha256:material-ref-hash".into()),
            delivered_roles: vec![CredentialMaterialRole::ApiKey],
            redaction_refs: None,
            observed_at: "2026-05-28T00:00:00Z".into(),
        };
        let mut metadata = JsonObject::new();
        let observation_json = serde_json::to_string(&vec![observation])?;
        metadata.insert(
            CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA.to_owned(),
            serde_json::from_str::<JsonValue>(&observation_json)?,
        );
        Ok(SkillOutput {
            status: InvocationStatus::Success,
            stdout: "ok".to_owned(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 1,
            metadata,
        })
    }
}

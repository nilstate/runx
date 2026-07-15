// rust-style-allow: large-file because receipt construction, explicit
// signature policy, and local proof sealing stay together until the runtime
// receipt builder is split out.
use std::collections::BTreeMap;

use crate::adapter::{
    CONTRACT_VERIFICATION_METADATA, CREDENTIAL_DELIVERY_OBSERVATIONS_METADATA, SkillOutput,
};
use crate::effects::{RuntimeEffectRegistry, effect_verification_refs};
use crate::execution::output_projection::{
    StepOutputProjection, StepOutputRefs, project_step_output,
};
use crate::{RuntimeError, StepRun};
use runx_contracts::fingerprint::sha256_hex;
use runx_contracts::schema::NonEmptyString;
use runx_contracts::{
    ActForm, AuthorityAttenuation, AuthoritySubsetResult, AuthorityTerm, Closure,
    ClosureDisposition, CredentialDeliveryObservation, CriterionBinding, CriterionStatus, Decision,
    DecisionChoice, DecisionInputs, DecisionJustification, FanoutReceiptSyncPoint, Intent,
    JsonObject, JsonValue, Lineage, RECEIPT_CANONICALIZATION, Receipt, ReceiptAct,
    ReceiptAuthority, ReceiptEnforcement, ReceiptIdempotency, ReceiptIssuer, ReceiptSchema,
    Reference, ReferenceType, Seal, SignatureAlgorithm, Subject, SuccessCriterion,
    json_string_field, receipt_subject_kind,
};
use runx_receipts::{
    ReceiptProofContext, ReceiptProofContextProvider, ReceiptSignature, ReceiptTreeConfig,
    SignatureVerificationFailure, SignatureVerifier, canonical_receipt_body_digest,
    content_addressed_receipt_id,
};

use super::act::{ActOutcome, RuntimeAct};
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
    step_receipt_with_disposition_and_policy(
        StepReceiptWithDisposition::with_default_closure(
            graph_name, step_id, attempt, output, created_at,
        ),
        RuntimeReceiptSignaturePolicy::local_development(),
    )
}

pub fn step_receipt_with_signature_policy(
    graph_name: &str,
    step_id: &str,
    attempt: u32,
    output: &SkillOutput,
    created_at: &str,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    step_receipt_with_disposition_and_policy(
        StepReceiptWithDisposition::with_default_closure(
            graph_name, step_id, attempt, output, created_at,
        ),
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
    let projection = project_step_output(output);
    step_receipt_with_disposition_projection_authority_and_policy(
        StepReceiptWithDisposition::with_default_closure(
            graph_name, step_id, attempt, output, created_at,
        ),
        &projection,
        authority_grant_refs,
        RuntimeReceiptSignaturePolicy::local_development(),
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

impl<'a> StepReceiptWithDisposition<'a> {
    /// A step-receipt request whose closure is derived from the output (the
    /// process-exit default): `Closed`/`Failed` by exit status, the matching
    /// `process_*` reason code, and a generic completion summary. This is the
    /// single source of that derivation for the process-exit step receipts.
    pub(crate) fn with_default_closure(
        graph_name: &'a str,
        step_id: &'a str,
        attempt: u32,
        output: &'a SkillOutput,
        created_at: &'a str,
    ) -> Self {
        let StepSealClosure {
            disposition,
            reason_code,
            summary,
        } = StepSealClosure::default_for(output, step_id);
        Self {
            graph_name,
            step_id,
            attempt,
            output,
            created_at,
            disposition,
            reason_code,
            summary,
        }
    }
}

pub(crate) fn step_receipt_with_disposition_and_policy(
    params: StepReceiptWithDisposition<'_>,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    let projection = project_step_output(params.output);
    step_receipt_with_disposition_projection_authority_and_policy(
        params,
        &projection,
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
    let verification = contract_verification_criteria(&output.metadata)?;
    let act = RuntimeAct::observation(step_id)
        .with_verified_criteria(verification.criteria.clone(), verification.bindings.clone())
        .close(ActOutcome {
            disposition: disposition.clone(),
            succeeded: output.succeeded(),
            summary: output_summary(output),
            performed_at: created_at,
            refs: &output_refs,
        });
    let seal_criterion = process_exit_criterion(output, &output_refs);
    let mut seal_criteria = vec![seal_criterion];
    seal_criteria.extend(verification.bindings);
    let seal = seal(disposition, reason_code, summary, created_at, seal_criteria);
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

/// The single step-receipt seal. Every runtime step (regular skill, tool,
/// approval, agent act, replay, error) seals through here, so the act,
/// decision, and authority assembly lives in exactly one place. `closure` is
/// `None` for process-exit steps (the disposition is derived from the output)
/// and `Some` for steps that carry their own disposition, e.g. an agent act
/// that closes `Deferred` on a successful turn.
pub(crate) struct StepSeal<'a> {
    pub(crate) graph_name: &'a str,
    pub(crate) step_id: &'a str,
    pub(crate) attempt: u32,
    pub(crate) output: &'a SkillOutput,
    pub(crate) projection: &'a StepOutputProjection,
    pub(crate) created_at: &'a str,
    pub(crate) authority_grant_refs: Vec<Reference>,
    pub(crate) operator_refs: Vec<Reference>,
    pub(crate) closure: Option<StepSealClosure>,
}

/// A step's own disposition, reason, and summary when it does not derive them
/// from a process exit.
pub(crate) struct StepSealClosure {
    pub(crate) disposition: ClosureDisposition,
    pub(crate) reason_code: String,
    pub(crate) summary: String,
}

impl StepSealClosure {
    /// The process-exit default closure derived from the output: `Closed`/`Failed`
    /// by exit status, the matching `process_*` reason code, and a generic
    /// completion summary. The single source of this derivation.
    pub(crate) fn default_for(output: &SkillOutput, step_id: &str) -> Self {
        let disposition = disposition(output);
        Self {
            reason_code: process_reason_code(&disposition),
            summary: format!("step {step_id} completed"),
            disposition,
        }
    }
}

pub(crate) fn seal_step(
    params: StepSeal<'_>,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, RuntimeError> {
    let StepSeal {
        graph_name,
        step_id,
        attempt,
        output,
        projection,
        created_at,
        authority_grant_refs,
        operator_refs,
        closure,
    } = params;
    let StepSealClosure {
        disposition,
        reason_code,
        summary,
    } = closure.unwrap_or_else(|| StepSealClosure::default_for(output, step_id));
    let mut projection = StepOutputProjection {
        outputs: projection.outputs.clone(),
        claim: projection.claim.clone(),
        refs: projection.refs.clone(),
    };
    for reference in operator_refs {
        if reference.reference_type == ReferenceType::Artifact {
            projection.refs.artifact_refs.push(reference.clone());
        } else {
            projection.refs.artifact_refs.push(reference.clone());
            projection.refs.verification_refs.push(reference.clone());
        }
        projection.refs.evidence_refs.push(reference);
    }
    step_receipt_with_disposition_projection_authority_and_policy(
        StepReceiptWithDisposition {
            graph_name,
            step_id,
            attempt,
            output,
            created_at,
            disposition,
            reason_code,
            summary,
        },
        &projection,
        authority_grant_refs,
        signature_policy,
    )
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

#[derive(Clone, Debug, Default)]
struct ContractVerificationCriteria {
    criteria: Vec<SuccessCriterion>,
    bindings: Vec<CriterionBinding>,
}

fn contract_verification_criteria(
    metadata: &JsonObject,
) -> Result<ContractVerificationCriteria, RuntimeError> {
    let Some(value) = metadata.get(CONTRACT_VERIFICATION_METADATA) else {
        return Ok(ContractVerificationCriteria::default());
    };
    let JsonValue::Object(verification) = value else {
        return Err(invalid_contract_verification(
            "contract_verification must be an object",
        ));
    };
    const ALLOWED_FIELDS: &[&str] = &[
        "output_contract_sha256",
        "voice_profile_sha256",
        "packet_schemas",
    ];
    if let Some(field) = verification
        .keys()
        .find(|field| !ALLOWED_FIELDS.contains(&field.as_str()))
    {
        return Err(invalid_contract_verification(format!(
            "contract_verification contains undeclared field '{field}'"
        )));
    }

    let output_digest = required_verification_digest(verification, "output_contract_sha256")?;
    let mut result = ContractVerificationCriteria::default();
    push_verified_criterion(
        &mut result,
        "output_contract_verified",
        "Agent result satisfies its declared output contract",
        output_digest,
    );
    if let Some(digest) = optional_verification_digest(verification, "voice_profile_sha256")? {
        push_verified_criterion(
            &mut result,
            "voice_profile_applied",
            "Agent invocation used the resolved voice profile",
            digest,
        );
    }
    append_packet_schema_criterion(&mut result, verification)?;
    Ok(result)
}

fn append_packet_schema_criterion(
    result: &mut ContractVerificationCriteria,
    verification: &JsonObject,
) -> Result<(), RuntimeError> {
    let Some(value) = verification.get("packet_schemas") else {
        return Ok(());
    };
    let JsonValue::Object(entries) = value else {
        return Err(invalid_contract_verification(
            "contract_verification.packet_schemas must be an object",
        ));
    };
    if entries.is_empty() {
        return Err(invalid_contract_verification(
            "contract_verification.packet_schemas must not be empty",
        ));
    }
    let mut references = Vec::with_capacity(entries.len());
    for (output, value) in entries {
        let (packet, digest) = packet_schema_verification(output, value)?;
        references.push(Reference::with_uri(
            ReferenceType::Verification,
            format!("runx:verification:packet_schema_verified:{packet}:{digest}"),
        ));
    }
    let statement = "Agent packet outputs satisfy their declared packet schemas";
    result.criteria.push(SuccessCriterion {
        criterion_id: "packet_schemas_verified".into(),
        statement: statement.into(),
        required: true,
    });
    result.bindings.push(CriterionBinding {
        criterion_id: "packet_schemas_verified".into(),
        status: CriterionStatus::Verified,
        evidence_refs: Vec::new(),
        verification_refs: references,
        summary: Some(statement.into()),
    });
    Ok(())
}

fn packet_schema_verification<'a>(
    output: &str,
    value: &'a JsonValue,
) -> Result<(&'a str, &'a str), RuntimeError> {
    let JsonValue::Object(entry) = value else {
        return Err(invalid_contract_verification(format!(
            "contract_verification.packet_schemas.{output} must be an object"
        )));
    };
    const ALLOWED_FIELDS: &[&str] = &["packet", "schema_sha256"];
    if let Some(field) = entry
        .keys()
        .find(|field| !ALLOWED_FIELDS.contains(&field.as_str()))
    {
        return Err(invalid_contract_verification(format!(
            "contract_verification.packet_schemas.{output} contains undeclared field '{field}'"
        )));
    }
    let packet = required_verification_string(entry, output, "packet")?;
    let digest = required_verification_string(entry, output, "schema_sha256")?;
    if !digest.starts_with("sha256:") {
        return Err(invalid_contract_verification(format!(
            "contract_verification.packet_schemas.{output}.schema_sha256 must be a sha256 digest"
        )));
    }
    Ok((packet, digest))
}

fn required_verification_string<'a>(
    entry: &'a JsonObject,
    output: &str,
    field: &str,
) -> Result<&'a str, RuntimeError> {
    entry
        .get(field)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            invalid_contract_verification(format!(
                "contract_verification.packet_schemas.{output}.{field} must be a non-empty string"
            ))
        })
}

fn required_verification_digest<'a>(
    verification: &'a JsonObject,
    field: &str,
) -> Result<&'a str, RuntimeError> {
    optional_verification_digest(verification, field)?.ok_or_else(|| {
        invalid_contract_verification(format!("contract_verification.{field} is required"))
    })
}

fn optional_verification_digest<'a>(
    verification: &'a JsonObject,
    field: &str,
) -> Result<Option<&'a str>, RuntimeError> {
    let Some(value) = verification.get(field) else {
        return Ok(None);
    };
    let Some(digest) = value.as_str().filter(|value| value.starts_with("sha256:")) else {
        return Err(invalid_contract_verification(format!(
            "contract_verification.{field} must be a sha256 digest"
        )));
    };
    Ok(Some(digest))
}

fn push_verified_criterion(
    result: &mut ContractVerificationCriteria,
    criterion_id: &str,
    statement: &str,
    digest: &str,
) {
    let reference = Reference::with_uri(
        ReferenceType::Verification,
        format!("runx:verification:{criterion_id}:{digest}"),
    );
    result.criteria.push(SuccessCriterion {
        criterion_id: criterion_id.into(),
        statement: statement.into(),
        required: true,
    });
    result.bindings.push(CriterionBinding {
        criterion_id: criterion_id.into(),
        status: CriterionStatus::Verified,
        evidence_refs: Vec::new(),
        verification_refs: vec![reference],
        summary: Some(statement.into()),
    });
}

fn invalid_contract_verification(message: impl Into<String>) -> RuntimeError {
    RuntimeError::ReceiptInvalid {
        message: message.into(),
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
    bind_graph_operator_refs(&mut receipt, steps);
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
    bind_graph_operator_refs(&mut receipt, steps);
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

fn bind_graph_operator_refs(receipt: &mut Receipt, steps: &[StepRun]) {
    let mut refs = Vec::<Reference>::new();
    for reference in steps
        .iter()
        .flat_map(|step| step.receipt.acts.iter())
        .flat_map(|act| act.artifact_refs.iter())
        .filter(|reference| reference.uri.as_str().contains("operator_context"))
    {
        if !refs.iter().any(|existing| existing.uri == reference.uri) {
            refs.push(reference.clone());
        }
    }
    let artifacts = refs
        .iter()
        .filter(|reference| reference.reference_type == ReferenceType::Artifact)
        .cloned()
        .collect::<Vec<_>>();
    let decisions = refs
        .iter()
        .filter(|reference| reference.reference_type == ReferenceType::Decision)
        .cloned()
        .collect::<Vec<_>>();
    for act in &mut receipt.acts {
        act.artifact_refs.extend(artifacts.iter().cloned());
        act.artifact_refs.extend(decisions.iter().cloned());
        for criterion in &mut act.criterion_bindings {
            criterion.evidence_refs.extend(refs.iter().cloned());
            criterion
                .verification_refs
                .extend(decisions.iter().cloned());
        }
    }
    for decision in &mut receipt.decisions {
        decision.artifact_refs.extend(artifacts.iter().cloned());
        decision
            .justification
            .evidence_refs
            .extend(refs.iter().cloned());
    }
    for criterion in &mut receipt.seal.criteria {
        criterion.evidence_refs.extend(refs.iter().cloned());
        criterion
            .verification_refs
            .extend(decisions.iter().cloned());
    }
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

/// The stable identity of the local runtime's enforcement profile. The hash is
/// derived over this id plus the profile's redaction/setup/teardown refs, never
/// over [`ReceiptEnforcement`] itself (which carries the resulting hash).
const RUNTIME_ENFORCEMENT_PROFILE_ID: &str = "runx.runtime.enforcement.profile.v1";

/// Content-address an enforcement profile as `sha256:<digest>` over its stable
/// id plus its redaction/setup/teardown ref inputs in deterministic order. Both
/// runtime `ReceiptEnforcement` build sites (the generic `authority()` helper and
/// the domain-act seal) call this so the profile hash has one source of truth.
fn enforcement_profile_hash(
    redaction_refs: &[Reference],
    setup_refs: &[Reference],
    teardown_refs: &[Reference],
) -> NonEmptyString {
    let identity = serde_json::json!({
        "profile_id": RUNTIME_ENFORCEMENT_PROFILE_ID,
        "redaction_refs": redaction_refs,
        "setup_refs": setup_refs,
        "teardown_refs": teardown_refs,
    });
    let canonical = serde_json::to_vec(&identity).unwrap_or_default();
    format!("sha256:{}", sha256_hex(&canonical)).into()
}

fn authority(grant_refs: Vec<Reference>) -> ReceiptAuthority {
    let redaction_refs = Vec::new();
    let setup_refs = Vec::new();
    let teardown_refs = Vec::new();
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
            profile_hash: enforcement_profile_hash(&redaction_refs, &setup_refs, &teardown_refs),
            redaction_refs,
            setup_refs,
            teardown_refs,
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
    /// The member's own authority term (the child grant minted from the charter).
    /// Empty for an unattenuated turn.
    pub authority_terms: Vec<AuthorityTerm>,
    /// The charter attenuation: the parent authority and the subset proof that the
    /// child term is no broader. `None` for a root (unattenuated) turn.
    pub authority_attenuation: Option<AuthorityAttenuation>,
    pub previous: Option<Reference>,
}

pub(crate) struct DomainActReceiptRequest<'a> {
    pub graph_name: &'a str,
    pub step_id: &'a str,
    pub succeeded: bool,
    pub created_at: &'a str,
    pub disposition: ClosureDisposition,
    pub reason_code: String,
    pub seal_summary: String,
    pub frame: DomainActFrame,
    pub verification_metadata: JsonObject,
    pub signature_policy: RuntimeReceiptSignaturePolicy<'a>,
}

/// Seal a governed turn as its domain act. Reuses the generic receipt assembly
/// (`build_receipt`/`seal`) but fills the act, decision, and authority from the
/// trusted `DomainActFrame`. Transport (tool names, urls, status codes, tokens)
/// never enters the receipt.
// rust-style-allow: long-function - domain-act receipt assembly binds act,
// decision, authority, and signature policy in one auditable receipt boundary.
pub(crate) fn domain_act_receipt(
    request: DomainActReceiptRequest<'_>,
) -> Result<Receipt, RuntimeError> {
    let DomainActReceiptRequest {
        graph_name,
        step_id,
        succeeded,
        created_at,
        disposition,
        reason_code,
        seal_summary,
        frame,
        verification_metadata,
        signature_policy,
    } = request;
    let verification = contract_verification_criteria(&verification_metadata)?;
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
        success_criteria: verification.criteria,
        constraints: Vec::new(),
        derived_from: Vec::new(),
    };
    let mut criterion_bindings = vec![criterion.clone()];
    criterion_bindings.extend(verification.bindings.iter().cloned());
    let act = ReceiptAct {
        id: format!("act_{step_id}").into(),
        form: frame.form,
        intent: intent.clone(),
        summary: frame.summary.clone(),
        criterion_bindings,
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
    let redaction_refs = Vec::new();
    let setup_refs = Vec::new();
    let teardown_refs = Vec::new();
    let authority = ReceiptAuthority {
        actor_ref: frame.actor_ref,
        authority_proof_refs: Vec::new(),
        grant_refs: frame.authority_grant_refs,
        scope_refs: frame.authority_scope_refs,
        terms: frame.authority_terms,
        attenuation: frame.authority_attenuation.unwrap_or(AuthorityAttenuation {
            parent_authority_ref: None,
            subset_proof: None,
        }),
        mandate_ref: None,
        enforcement: ReceiptEnforcement {
            profile_hash: enforcement_profile_hash(&redaction_refs, &setup_refs, &teardown_refs),
            redaction_refs,
            setup_refs,
            teardown_refs,
        },
    };
    let mut seal_criteria = vec![criterion];
    seal_criteria.extend(verification.bindings);
    let seal = seal(
        disposition,
        reason_code,
        seal_summary,
        created_at,
        seal_criteria,
    );
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
            if !self.policy.allows_local_pseudo_signatures() {
                return Err(SignatureVerificationFailure::MalformedSignature);
            }
            return if signature.value.strip_prefix("sig:") == Some(body_digest) {
                Ok(())
            } else {
                Err(SignatureVerificationFailure::SignatureMismatch)
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
        _ => false,
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

    #[test]
    fn contract_verification_is_bound_into_signed_act_and_seal() -> Result<(), TestError> {
        let mut verification = JsonObject::new();
        verification.insert(
            "output_contract_sha256".to_owned(),
            JsonValue::String("sha256:output".to_owned()),
        );
        verification.insert(
            "voice_profile_sha256".to_owned(),
            JsonValue::String("sha256:voice".to_owned()),
        );
        verification.insert(
            "packet_schemas".to_owned(),
            JsonValue::Object(BTreeMap::from([(
                "plan".to_owned(),
                JsonValue::Object(BTreeMap::from([
                    (
                        "packet".to_owned(),
                        JsonValue::String("runx.test.plan.v1".to_owned()),
                    ),
                    (
                        "schema_sha256".to_owned(),
                        JsonValue::String("sha256:packet".to_owned()),
                    ),
                ])),
            )])),
        );
        let mut metadata = JsonObject::new();
        metadata.insert(
            CONTRACT_VERIFICATION_METADATA.to_owned(),
            JsonValue::Object(verification),
        );
        let output = SkillOutput {
            status: InvocationStatus::Success,
            stdout: "{}".to_owned(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 1,
            metadata,
        };

        let receipt = step_receipt(
            "agent_graph",
            "agent_step",
            1,
            &output,
            "2026-05-28T00:00:00Z",
        )?;

        assert_eq!(receipt.acts[0].intent.success_criteria.len(), 4);
        assert_eq!(receipt.acts[0].criterion_bindings.len(), 4);
        assert_eq!(receipt.seal.criteria.len(), 4);
        assert_eq!(
            receipt.seal.criteria[1].criterion_id.as_str(),
            "output_contract_verified"
        );
        assert_eq!(
            receipt.seal.criteria[1].verification_refs[0].reference_type,
            ReferenceType::Verification
        );
        assert!(
            receipt.seal.criteria[1].verification_refs[0]
                .uri
                .as_str()
                .ends_with("sha256:output")
        );
        Ok(())
    }

    #[test]
    fn malformed_contract_verification_fails_closed() {
        let mut metadata = JsonObject::new();
        metadata.insert(
            CONTRACT_VERIFICATION_METADATA.to_owned(),
            JsonValue::String("untrusted".to_owned()),
        );
        let output = SkillOutput {
            status: InvocationStatus::Success,
            stdout: "{}".to_owned(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 1,
            metadata,
        };

        assert!(
            step_receipt(
                "agent_graph",
                "agent_step",
                1,
                &output,
                "2026-05-28T00:00:00Z"
            )
            .is_err()
        );
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

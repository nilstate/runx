//! The act as a first-class object.
//!
//! An act is OPENED with its declared intent and form, and CLOSED with the
//! execution outcome. Separating the intent (fixed up front) from the outcome
//! (criterion status, refs, closure, filled from the result) is what makes the
//! act a unit of its own rather than a value reconstructed at seal time.
//!
//! Today the runtime opens a generic observation act at the seal call; later
//! cuts open it at step admission and carry it through invocation, and a
//! declared `act:` block specializes the opening intent into a domain act.

use runx_contracts::schema::NonEmptyString;
use runx_contracts::{
    ActForm, Closure, ClosureDisposition, CriterionBinding, CriterionStatus, Intent, ReceiptAct,
    SuccessCriterion,
};

use crate::execution::output_projection::StepOutputRefs;

/// The execution outcome that closes an act into its sealed body.
pub(crate) struct ActOutcome<'a> {
    /// How the act closed (`Closed`, `Deferred`, ...). May differ from
    /// `succeeded`: an agent act can close `Deferred` on a successful turn.
    pub(crate) disposition: ClosureDisposition,
    /// Whether the underlying invocation succeeded, driving the criterion status.
    pub(crate) succeeded: bool,
    /// Human summary of the outcome, shared by the criterion and the closure.
    pub(crate) summary: String,
    /// When the act closed.
    pub(crate) performed_at: &'a str,
    /// References projected from the execution output.
    pub(crate) refs: &'a StepOutputRefs,
}

/// An act opened with its intent and form fixed up front.
pub(crate) struct RuntimeAct {
    id: NonEmptyString,
    form: ActForm,
    intent: Intent,
    summary: NonEmptyString,
    criterion_id: NonEmptyString,
    reason_code: NonEmptyString,
}

impl RuntimeAct {
    /// The generic observation act a runtime step opens when it declares no
    /// domain act of its own: "this step ran, admitted by the local harness".
    pub(crate) fn observation(step_id: &str) -> Self {
        Self {
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
            criterion_id: "process_exit".into(),
            reason_code: "process_exit".into(),
        }
    }

    /// Close the act with its execution outcome, producing the sealed act body.
    pub(crate) fn close(self, outcome: ActOutcome<'_>) -> ReceiptAct {
        let mut artifact_refs = outcome.refs.artifact_refs.clone();
        artifact_refs.extend(outcome.refs.surface_refs.iter().cloned());
        ReceiptAct {
            id: self.id,
            form: self.form,
            intent: self.intent,
            summary: self.summary,
            criterion_bindings: vec![CriterionBinding {
                criterion_id: self.criterion_id,
                status: if outcome.succeeded {
                    CriterionStatus::Verified
                } else {
                    CriterionStatus::Failed
                },
                evidence_refs: outcome.refs.evidence_refs.clone(),
                verification_refs: outcome.refs.verification_refs.clone(),
                summary: Some(outcome.summary.clone().into()),
            }],
            by: None,
            source_refs: outcome.refs.source_refs.clone(),
            target_refs: Vec::new(),
            artifact_refs,
            context_ref: None,
            closure: Closure {
                disposition: outcome.disposition,
                reason_code: self.reason_code,
                summary: outcome.summary.into(),
                closed_at: outcome.performed_at.into(),
            },
            revision: None,
            verification: None,
        }
    }
}

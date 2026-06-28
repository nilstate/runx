//! Decision contracts: choices, justifications, and closure dispositions.
use serde::{Deserialize, Serialize};

use crate::schema::{IsoDateTime, NonEmptyString, RunxSchema};
use crate::{Intent, Reference};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum DecisionChoice {
    Open,
    Continue,
    SpawnChild,
    Escalate,
    Defer,
    Close,
    Decline,
    Monitor,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct DecisionInputs {
    #[serde(default)]
    pub signal_refs: Vec<Reference>,
    pub target_ref: Option<Reference>,
    #[serde(default)]
    pub opportunity_refs: Vec<Reference>,
    pub selection_ref: Option<Reference>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct DecisionJustification {
    pub summary: NonEmptyString,
    #[serde(default)]
    pub evidence_refs: Vec<Reference>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClosureDisposition {
    Closed,
    Deferred,
    Superseded,
    Declined,
    Blocked,
    Failed,
    Killed,
    TimedOut,
}

impl ClosureDisposition {
    /// Stable string label, identical to the serde `snake_case` representation.
    /// Single source of truth for the runtime's disposition strings.
    pub fn label(&self) -> &'static str {
        match self {
            ClosureDisposition::Closed => "closed",
            ClosureDisposition::Deferred => "deferred",
            ClosureDisposition::Superseded => "superseded",
            ClosureDisposition::Declined => "declined",
            ClosureDisposition::Blocked => "blocked",
            ClosureDisposition::Failed => "failed",
            ClosureDisposition::Killed => "killed",
            ClosureDisposition::TimedOut => "timed_out",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
pub struct Closure {
    pub disposition: ClosureDisposition,
    pub reason_code: NonEmptyString,
    pub summary: NonEmptyString,
    pub closed_at: IsoDateTime,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, RunxSchema)]
#[serde(deny_unknown_fields)]
#[runx_schema(id = "runx.decision.v1")]
pub struct Decision {
    pub decision_id: NonEmptyString,
    pub choice: DecisionChoice,
    pub inputs: DecisionInputs,
    pub proposed_intent: Intent,
    pub selected_act_id: Option<NonEmptyString>,
    pub selected_harness_ref: Option<Reference>,
    pub justification: DecisionJustification,
    pub closure: Option<Closure>,
    #[serde(default)]
    pub artifact_refs: Vec<Reference>,
}

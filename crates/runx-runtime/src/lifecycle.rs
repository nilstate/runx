// Module rationale: lifecycle event vocabulary and receipt
// record projection stay together while producers converge on one sealed event
// taxonomy.
use runx_contracts::{
    ClosureDisposition, ExecutionEvent, JsonObject, JsonValue, Receipt, Reference,
};

#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    dead_code,
    reason = "phase 5 defines the full lifecycle vocabulary before every producer emits it"
)]
pub(crate) enum LifecycleEvent {
    HarnessOpened {
        harness_id: String,
        graph_name: String,
    },
    DecisionRecorded {
        decision_id: String,
        harness_id: String,
    },
    ActStarted {
        act_id: String,
        step_id: Option<String>,
    },
    ActClosed {
        act_id: String,
        step_id: Option<String>,
        disposition: ClosureDisposition,
    },
    ChildHarnessLinked {
        parent_harness_id: String,
        child_harness_id: String,
        receipt_id: String,
    },
    AdapterInvoked {
        adapter_type: String,
        step_id: String,
    },
    ReceiptSealed {
        receipt_id: String,
        harness_id: String,
        disposition: ClosureDisposition,
        message: String,
    },
    AbnormalSeal {
        receipt_id: String,
        harness_id: String,
        disposition: ClosureDisposition,
        message: String,
    },
    VerificationRecorded {
        receipt_id: String,
        status: String,
    },
    PublicationProjected {
        receipt_id: String,
        projection_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReceiptLifecycleRecord {
    pub(crate) entry_key: String,
    pub(crate) event_kind: &'static str,
    pub(crate) summary: String,
    pub(crate) source_refs: Vec<String>,
    pub(crate) harness_ref: Option<String>,
    pub(crate) act_ref: Option<String>,
    pub(crate) decision_ref: Option<String>,
    pub(crate) artifact_refs: Vec<String>,
    pub(crate) status: Option<String>,
    pub(crate) include_verification: bool,
}

impl LifecycleEvent {
    pub(crate) fn step_started(step_id: &str) -> Self {
        Self::ActStarted {
            act_id: format!("act_{step_id}"),
            step_id: Some(step_id.to_owned()),
        }
    }

    pub(crate) fn step_completed(step_id: &str) -> Self {
        Self::ActClosed {
            act_id: format!("act_{step_id}"),
            step_id: Some(step_id.to_owned()),
            disposition: ClosureDisposition::Closed,
        }
    }

    pub(crate) fn step_failed(step_id: &str) -> Self {
        Self::ActClosed {
            act_id: format!("act_{step_id}"),
            step_id: Some(step_id.to_owned()),
            disposition: ClosureDisposition::Failed,
        }
    }

    pub(crate) fn graph_completed(graph_name: &str, receipt: &Receipt) -> Self {
        Self::ReceiptSealed {
            receipt_id: receipt.id.to_string(),
            harness_id: receipt.subject.reference.uri.clone().into_string(),
            disposition: receipt.seal.disposition.clone(),
            message: format!("graph {graph_name} completed"),
        }
    }

    pub(crate) fn graph_blocked(graph_name: &str, step_id: &str, receipt: &Receipt) -> Self {
        Self::AbnormalSeal {
            receipt_id: receipt.id.to_string(),
            harness_id: receipt.subject.reference.uri.clone().into_string(),
            disposition: receipt.seal.disposition.clone(),
            message: format!("graph {graph_name} blocked at {step_id}"),
        }
    }

    pub(crate) fn graph_failed(graph_name: &str, step_id: &str, receipt: &Receipt) -> Self {
        Self::AbnormalSeal {
            receipt_id: receipt.id.to_string(),
            harness_id: receipt.subject.reference.uri.clone().into_string(),
            disposition: receipt.seal.disposition.clone(),
            message: format!("graph {graph_name} failed at {step_id}"),
        }
    }

    pub(crate) fn graph_deferred(graph_name: &str, step_id: &str, receipt: &Receipt) -> Self {
        Self::AbnormalSeal {
            receipt_id: receipt.id.to_string(),
            harness_id: receipt.subject.reference.uri.clone().into_string(),
            disposition: receipt.seal.disposition.clone(),
            message: format!("graph {graph_name} deferred at {step_id}"),
        }
    }

    // Function rationale: each lifecycle variant maps to
    // exactly one host-facing event shape; splitting the match would hide
    // exhaustiveness across the lifecycle vocabulary.
    pub(crate) fn into_execution_event(self) -> ExecutionEvent {
        match self {
            Self::HarnessOpened {
                harness_id,
                graph_name,
            } => ExecutionEvent::Executing {
                message: format!("harness {harness_id} opened for graph {graph_name}"),
                data: Some(event_data("harness_opened", [("harness_id", harness_id)])),
            },
            Self::DecisionRecorded {
                decision_id,
                harness_id,
            } => ExecutionEvent::ResolutionResolved {
                message: format!("decision {decision_id} recorded"),
                data: Some(event_data(
                    "decision_recorded",
                    [("decision_id", decision_id), ("harness_id", harness_id)],
                )),
            },
            Self::ActStarted { act_id, step_id } => {
                let message = step_id.as_ref().map_or_else(
                    || format!("act {act_id} started"),
                    |step| format!("step {step} started"),
                );
                ExecutionEvent::StepStarted {
                    message,
                    data: Some(optional_step_event_data("act_started", act_id, step_id)),
                }
            }
            Self::ActClosed {
                act_id,
                step_id,
                disposition,
            } => {
                let data = optional_step_event_data("act_closed", act_id.clone(), step_id.clone());
                if disposition == ClosureDisposition::Closed {
                    ExecutionEvent::StepCompleted {
                        message: step_id.as_ref().map_or_else(
                            || format!("act {act_id} closed"),
                            |step| format!("step {step} completed"),
                        ),
                        data: Some(with_disposition(data, disposition)),
                    }
                } else {
                    ExecutionEvent::Warning {
                        message: step_id.as_ref().map_or_else(
                            || {
                                format!(
                                    "act {act_id} closed with {}",
                                    disposition_label(&disposition)
                                )
                            },
                            |step| format!("step {step} failed"),
                        ),
                        data: Some(with_disposition(data, disposition)),
                    }
                }
            }
            Self::ChildHarnessLinked {
                parent_harness_id,
                child_harness_id,
                receipt_id,
            } => ExecutionEvent::StepCompleted {
                message: format!("child harness {child_harness_id} linked"),
                data: Some(event_data(
                    "child_harness_linked",
                    [
                        ("parent_harness_id", parent_harness_id),
                        ("child_harness_id", child_harness_id),
                        ("receipt_id", receipt_id),
                    ],
                )),
            },
            Self::AdapterInvoked {
                adapter_type,
                step_id,
            } => ExecutionEvent::Executing {
                message: format!("adapter {adapter_type} invoked for step {step_id}"),
                data: Some(event_data(
                    "adapter_invoked",
                    [("adapter_type", adapter_type), ("step_id", step_id)],
                )),
            },
            Self::ReceiptSealed {
                receipt_id,
                harness_id,
                disposition,
                message,
            } => ExecutionEvent::Completed {
                message,
                data: Some(receipt_event_data(
                    "receipt_sealed",
                    receipt_id,
                    harness_id,
                    disposition,
                )),
            },
            Self::AbnormalSeal {
                receipt_id,
                harness_id,
                disposition,
                message,
            } => ExecutionEvent::Completed {
                message,
                data: Some(receipt_event_data(
                    "abnormal_seal",
                    receipt_id,
                    harness_id,
                    disposition,
                )),
            },
            Self::VerificationRecorded { receipt_id, status } => ExecutionEvent::Completed {
                message: format!("verification recorded for receipt {receipt_id}"),
                data: Some(event_data(
                    "verification_recorded",
                    [("receipt_id", receipt_id), ("status", status)],
                )),
            },
            Self::PublicationProjected {
                receipt_id,
                projection_id,
            } => ExecutionEvent::Completed {
                message: format!("publication projected for receipt {receipt_id}"),
                data: Some(event_data(
                    "publication_projected",
                    [("receipt_id", receipt_id), ("projection_id", projection_id)],
                )),
            },
        }
    }
}

pub(crate) fn receipt_lifecycle_records(
    receipt: &Receipt,
    receipt_ref: &str,
    harness_ref: &str,
    status: String,
) -> Vec<ReceiptLifecycleRecord> {
    let mut records = vec![ReceiptLifecycleRecord {
        entry_key: "receipt".to_owned(),
        event_kind: receipt_event_kind(&receipt.seal.disposition),
        summary: receipt.seal.summary.to_string(),
        source_refs: vec![receipt_ref.to_owned()],
        harness_ref: Some(harness_ref.to_owned()),
        act_ref: None,
        decision_ref: receipt
            .decisions
            .first()
            .map(|decision| format!("runx:decision:{}", decision.decision_id)),
        artifact_refs: Vec::new(),
        status: Some(status.clone()),
        include_verification: true,
    }];

    records.extend(receipt.acts.iter().map(|act| {
        let act_ref = format!("runx:act:{}", act.id);
        ReceiptLifecycleRecord {
            entry_key: format!("act:{}", act.id),
            event_kind: "act_closed",
            summary: act.summary.to_string(),
            source_refs: vec![receipt_ref.to_owned(), act_ref.clone()],
            harness_ref: Some(harness_ref.to_owned()),
            act_ref: Some(act_ref),
            decision_ref: None,
            artifact_refs: reference_uris(&act.artifact_refs),
            status: Some(status.clone()),
            include_verification: false,
        }
    }));
    records
}

fn receipt_event_kind(disposition: &ClosureDisposition) -> &'static str {
    if matches!(
        disposition,
        ClosureDisposition::Blocked
            | ClosureDisposition::Failed
            | ClosureDisposition::Killed
            | ClosureDisposition::TimedOut
    ) {
        "abnormal_seal"
    } else {
        "receipt_sealed"
    }
}

fn optional_step_event_data(
    kind: &'static str,
    act_id: String,
    step_id: Option<String>,
) -> JsonValue {
    let mut object = JsonObject::new();
    object.insert("kind".to_owned(), JsonValue::String(kind.to_owned()));
    object.insert("act_id".to_owned(), JsonValue::String(act_id));
    if let Some(step_id) = step_id {
        object.insert("step_id".to_owned(), JsonValue::String(step_id));
    }
    JsonValue::Object(object)
}

fn with_disposition(mut value: JsonValue, disposition: ClosureDisposition) -> JsonValue {
    let JsonValue::Object(object) = &mut value else {
        return value;
    };
    object.insert(
        "disposition".to_owned(),
        JsonValue::String(disposition_label(&disposition).to_owned()),
    );
    value
}

fn receipt_event_data(
    kind: &'static str,
    receipt_id: String,
    harness_id: String,
    disposition: ClosureDisposition,
) -> JsonValue {
    let mut object = JsonObject::new();
    object.insert("kind".to_owned(), JsonValue::String(kind.to_owned()));
    object.insert("receipt_id".to_owned(), JsonValue::String(receipt_id));
    object.insert("harness_id".to_owned(), JsonValue::String(harness_id));
    object.insert(
        "disposition".to_owned(),
        JsonValue::String(disposition_label(&disposition).to_owned()),
    );
    JsonValue::Object(object)
}

fn event_data<const N: usize>(
    kind: &'static str,
    fields: [(&'static str, String); N],
) -> JsonValue {
    let mut object = JsonObject::new();
    object.insert("kind".to_owned(), JsonValue::String(kind.to_owned()));
    for (key, value) in fields {
        object.insert(key.to_owned(), JsonValue::String(value));
    }
    JsonValue::Object(object)
}

fn reference_uris(refs: &[Reference]) -> Vec<String> {
    refs.iter()
        .map(|reference| reference.uri.clone().into_string())
        .collect()
}

fn disposition_label(disposition: &ClosureDisposition) -> &'static str {
    match disposition {
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

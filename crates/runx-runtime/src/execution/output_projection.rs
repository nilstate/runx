use runx_contracts::operational_policy_source_provider;
use runx_contracts::{JsonObject, JsonValue, Reference, ReferenceType};

use crate::adapter::SkillOutput;

pub(crate) struct StepOutputProjection {
    pub(crate) outputs: JsonObject,
    pub(crate) claim: JsonObject,
    pub(crate) refs: StepOutputRefs,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct StepOutputRefs {
    pub(crate) signal_refs: Vec<Reference>,
    pub(crate) source_refs: Vec<Reference>,
    pub(crate) evidence_refs: Vec<Reference>,
    pub(crate) surface_refs: Vec<Reference>,
    pub(crate) artifact_refs: Vec<Reference>,
    pub(crate) verification_refs: Vec<Reference>,
}

/// The diagnostic/base fields `project_step_output` injects into a step's `outputs`
/// map. Re-exported from `runx_contracts::output` so the runtime projection/resolver
/// and the parser's parse-time context-edge validation share one source of truth and
/// the addressable surface cannot drift between layers.
pub(crate) use runx_contracts::output::BASE_OUTPUT_FIELDS;

#[must_use]
pub(crate) fn project_step_output(output: &SkillOutput) -> StepOutputProjection {
    let mut outputs = JsonObject::new();
    let parsed_stdout = serde_json::from_slice::<JsonValue>(output.stdout.as_bytes()).ok();
    let refs = stdout_refs(parsed_stdout.as_ref());
    let stdout = JsonValue::String(output.stdout.clone());
    if let Some(parsed) = parsed_stdout.as_ref() {
        outputs.insert("raw".to_owned(), stdout.clone());
        outputs.insert("skill_claim".to_owned(), parsed.clone());
    }
    outputs.insert("stdout".to_owned(), stdout);
    outputs.insert(
        "stderr".to_owned(),
        JsonValue::String(output.stderr.clone()),
    );
    outputs.insert(
        "status".to_owned(),
        JsonValue::String(if output.succeeded() {
            "success".to_owned()
        } else {
            "failure".to_owned()
        }),
    );
    let claim = match parsed_stdout {
        Some(JsonValue::Object(object)) => object,
        _ => JsonObject::new(),
    };
    StepOutputProjection {
        outputs,
        claim,
        refs,
    }
}

/// Wrap a value in the canonical `{ "data": ... }` artifact envelope, idempotently.
///
/// This is the single owner of the envelope convention: a value that is already an
/// object carrying a `data` key is returned untouched, so the envelope is applied at
/// most once no matter how many layers (catalog adapter, step projection) handle the
/// same payload. Without this guard a payload wrapped by one layer is re-wrapped by the
/// next, producing the `data.data` depth drift that silently breaks context-edge paths.
#[must_use]
pub(crate) fn data_envelope(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(object) if object.contains_key("data") => JsonValue::Object(object),
        other => {
            let mut wrapper = JsonObject::new();
            wrapper.insert("data".to_owned(), other);
            JsonValue::Object(wrapper)
        }
    }
}

fn stdout_refs(value: Option<&JsonValue>) -> StepOutputRefs {
    let mut refs = StepOutputRefs::default();
    let Some(value) = value else {
        return refs;
    };
    collect_stdout_artifact_refs(value, &mut refs);
    collect_stdout_signal_refs(value, &mut refs);
    collect_stdout_change_set_refs(value, &mut refs);
    refs
}

fn collect_stdout_artifact_refs(value: &JsonValue, refs: &mut StepOutputRefs) {
    let Some(object) = value.as_object() else {
        return;
    };
    if let Some(artifact) = object.get("artifact") {
        collect_artifact_reference(artifact, refs);
    }
    if let Some(artifacts) = object.get("artifacts") {
        collect_artifact_reference(artifacts, refs);
    }
}

fn collect_artifact_reference(value: &JsonValue, refs: &mut StepOutputRefs) {
    match value {
        JsonValue::Array(items) => {
            for item in items {
                collect_artifact_reference(item, refs);
            }
        }
        JsonValue::Object(object) => {
            let Some(artifact_id) = object
                .get("artifact_id")
                .or_else(|| object.get("id"))
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
            else {
                return;
            };
            let artifact_type = object
                .get("artifact_type")
                .or_else(|| object.get("type"))
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty());
            let mut reference = Reference::runx(ReferenceType::Artifact, artifact_id);
            reference.locator = Some(artifact_id.to_owned().into());
            reference.label = artifact_type.map(Into::into);
            refs.artifact_refs.push(reference);
        }
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_) => {}
    }
}

fn collect_stdout_signal_refs(value: &JsonValue, refs: &mut StepOutputRefs) {
    let Some(object) = value.as_object() else {
        return;
    };
    if let Some(signal) = object.get("signal") {
        collect_signal_reference(signal, refs);
    }
    if let Some(signals) = object.get("signals") {
        collect_signal_reference(signals, refs);
    }
}

fn collect_stdout_change_set_refs(value: &JsonValue, refs: &mut StepOutputRefs) {
    let Some(object) = value.as_object() else {
        return;
    };
    if let Some(change_set) = object.get("change_set") {
        collect_change_set_reference(change_set, refs);
    }
}

fn collect_change_set_reference(value: &JsonValue, refs: &mut StepOutputRefs) {
    match value {
        JsonValue::Array(items) => {
            for item in items {
                collect_change_set_reference(item, refs);
            }
        }
        JsonValue::Object(object) => {
            if let Some(target_surfaces) = object.get("target_surfaces") {
                collect_target_surface_reference(target_surfaces, refs);
            }
        }
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_) => {}
    }
}

fn collect_target_surface_reference(value: &JsonValue, refs: &mut StepOutputRefs) {
    match value {
        JsonValue::Array(items) => {
            for item in items {
                collect_target_surface_reference(item, refs);
            }
        }
        JsonValue::Object(object) => {
            let Some(surface) = object
                .get("surface")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
            else {
                return;
            };
            let mut reference = Reference::runx(ReferenceType::Surface, surface);
            reference.locator = Some(surface.to_owned().into());
            reference.label = object
                .get("kind")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(|value| value.to_owned().into());
            refs.surface_refs.push(reference);
        }
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_) => {}
    }
}

fn collect_signal_reference(value: &JsonValue, refs: &mut StepOutputRefs) {
    match value {
        JsonValue::Array(items) => {
            for item in items {
                collect_signal_reference(item, refs);
            }
        }
        JsonValue::Object(object) => {
            if let Some(signal_id) = object
                .get("signal_id")
                .or_else(|| object.get("id"))
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
            {
                refs.signal_refs
                    .push(Reference::runx(ReferenceType::Signal, signal_id));
            }
            if let Some(source_events) = object.get("source_events") {
                collect_source_event_reference(source_events, refs);
            }
            if let Some(artifact) = object.get("artifact") {
                collect_artifact_reference(artifact, refs);
            }
            if let Some(artifacts) = object.get("artifacts") {
                collect_artifact_reference(artifacts, refs);
            }
        }
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_) => {}
    }
}

fn collect_source_event_reference(value: &JsonValue, refs: &mut StepOutputRefs) {
    match value {
        JsonValue::Array(items) => {
            for item in items {
                collect_source_event_reference(item, refs);
            }
        }
        JsonValue::Object(object) => {
            let Some(locator) = object
                .get("source_locator")
                .or_else(|| object.get("locator"))
                .or_else(|| object.get("thread_locator"))
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
            else {
                return;
            };
            let provider = object
                .get("provider")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty());
            let label = object
                .get("title")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty());
            refs.source_refs.push(Reference {
                uri: locator.to_owned().into(),
                reference_type: reference_type_for_source(provider, locator),
                provider: provider.map(|value| value.to_owned().into()),
                locator: Some(locator.to_owned().into()),
                label: label.map(|value| value.to_owned().into()),
                observed_at: None,
                proof_kind: None,
            });
        }
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_) => {}
    }
}

fn reference_type_for_source(provider: Option<&str>, locator: &str) -> ReferenceType {
    match provider {
        Some(operational_policy_source_provider::GITHUB) => ReferenceType::GithubIssue,
        Some(operational_policy_source_provider::SLACK) => ReferenceType::SlackThread,
        Some(operational_policy_source_provider::SENTRY) => ReferenceType::SentryEvent,
        _ if locator.starts_with("github://") || locator.contains("github.com/") => {
            ReferenceType::GithubIssue
        }
        _ if locator.starts_with("slack://") => ReferenceType::SlackThread,
        _ if locator.starts_with("sentry://") => ReferenceType::SentryEvent,
        _ => ReferenceType::ExternalUrl,
    }
}

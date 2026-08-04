use std::collections::BTreeSet;

use runx_contracts::{JsonObject, JsonValue};

use super::{
    MAX_EVIDENCE, MAX_PROVES_BYTES, MAX_REF_BYTES, bounded_item_text, gap, opaque_reference,
    valid_sha256,
};

pub(super) fn parse_evidence(evidence: &[JsonValue], gaps: &mut Vec<JsonValue>) -> Vec<JsonValue> {
    if evidence.is_empty() {
        gap(
            gaps,
            "attestation.evidence.missing",
            "at least one evidence reference is required",
        );
    }
    if evidence.len() > MAX_EVIDENCE {
        gap(
            gaps,
            "attestation.evidence.limit",
            "evidence is limited to 100 references",
        );
    }
    let mut seen_refs = BTreeSet::new();
    evidence
        .iter()
        .take(MAX_EVIDENCE)
        .enumerate()
        .filter_map(|(index, candidate)| {
            parse_evidence_item(candidate, index, &mut seen_refs, gaps)
        })
        .collect()
}

fn parse_evidence_item(
    candidate: &JsonValue,
    index: usize,
    seen_refs: &mut BTreeSet<String>,
    gaps: &mut Vec<JsonValue>,
) -> Option<JsonValue> {
    let Some(item) = candidate.as_object() else {
        gap(
            gaps,
            "attestation.evidence.object",
            format!("evidence[{index}] must be an object"),
        );
        return None;
    };
    let extras = item
        .keys()
        .filter(|key| !matches!(key.as_str(), "ref" | "digest" | "proves"))
        .cloned()
        .collect::<Vec<_>>();
    if !extras.is_empty() {
        gap(
            gaps,
            "attestation.evidence.raw_fields",
            format!(
                "evidence[{index}] contains unsupported fields: {}",
                extras.join(", ")
            ),
        );
    }
    let reference = bounded_item_text(item, index, "ref", MAX_REF_BYTES, gaps);
    let digest = bounded_item_text(item, index, "digest", 80, gaps);
    let proves = bounded_item_text(item, index, "proves", MAX_PROVES_BYTES, gaps);
    validate_evidence_item(index, &reference, &digest, &proves, seen_refs, gaps);
    Some(JsonValue::Object(JsonObject::from([
        ("ref".to_owned(), JsonValue::String(reference)),
        ("digest".to_owned(), JsonValue::String(digest)),
        ("proves".to_owned(), JsonValue::String(proves)),
    ])))
}

fn validate_evidence_item(
    index: usize,
    reference: &str,
    digest: &str,
    proves: &str,
    seen_refs: &mut BTreeSet<String>,
    gaps: &mut Vec<JsonValue>,
) {
    if reference.is_empty() {
        gap(
            gaps,
            "attestation.evidence.ref",
            format!("evidence[{index}].ref is required"),
        );
    } else if !opaque_reference(reference) {
        gap(
            gaps,
            "attestation.evidence.ref",
            format!("evidence[{index}].ref must be an opaque non-secret reference"),
        );
    }
    if !valid_sha256(digest) {
        gap(
            gaps,
            "attestation.evidence.digest",
            format!("evidence[{index}].digest must be sha256"),
        );
    }
    if proves.is_empty() {
        gap(
            gaps,
            "attestation.evidence.proves",
            format!("evidence[{index}].proves is required"),
        );
    }
    if !reference.is_empty() && !seen_refs.insert(reference.to_owned()) {
        gap(
            gaps,
            "attestation.evidence.duplicate",
            format!("duplicate evidence ref: {reference}"),
        );
    }
}

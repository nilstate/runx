use runx_contracts::JsonValue;

use super::Finding;

pub(super) fn verify(value: &JsonValue, path: &str, findings: &mut Vec<Finding>) {
    match value {
        JsonValue::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                verify(value, &format!("{path}[{index}]"), findings);
            }
        }
        JsonValue::Object(values) => {
            for (key, value) in values {
                let child_path = format!("{path}.{key}");
                if effect_status_key(key) {
                    if !allowed_status(key, value) {
                        findings.push(Finding::new(
                            "artifact.effect.unsupported",
                            format!("{key} claims an external effect without provider evidence"),
                            Some(child_path.clone()),
                        ));
                    }
                } else if forbidden_key(key) && proof_claimed(value) {
                    findings.push(Finding::new(
                        "artifact.effect.proofless",
                        format!("{key} is not allowed on an evidence-only artifact"),
                        Some(child_path.clone()),
                    ));
                }
                verify(value, &child_path, findings);
            }
        }
        _ => {}
    }
}

fn effect_status_key(key: &str) -> bool {
    matches!(
        key,
        "provider_status"
            | "delivery_status"
            | "publication_status"
            | "receipt_status"
            | "executed"
            | "sent"
            | "published"
    )
}

fn allowed_status(key: &str, value: &JsonValue) -> bool {
    match (key, value) {
        ("provider_status", JsonValue::String(value)) => matches!(
            value.as_str(),
            "not_called" | "not_requested" | "not_started"
        ),
        ("delivery_status", JsonValue::String(value)) => {
            matches!(value.as_str(), "not_sent" | "not_delivered" | "not_started")
        }
        ("publication_status", JsonValue::String(value)) => {
            matches!(value.as_str(), "not_published" | "not_started")
        }
        ("receipt_status", JsonValue::String(value)) => {
            matches!(value.as_str(), "not_sealed" | "pending_parent_receipt")
        }
        ("executed" | "sent" | "published", JsonValue::Bool(false)) => true,
        _ => false,
    }
}

fn forbidden_key(key: &str) -> bool {
    matches!(
        key,
        "provider_id"
            | "provider_ref"
            | "provider_receipt"
            | "delivery_id"
            | "delivery_ref"
            | "delivery_receipt"
            | "publication_id"
            | "publication_ref"
            | "publication_receipt"
            | "effect_receipt"
    )
}

fn proof_claimed(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null | JsonValue::Bool(false) => false,
        JsonValue::String(value) => !value.is_empty(),
        _ => true,
    }
}

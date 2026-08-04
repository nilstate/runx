use std::collections::BTreeSet;

use runx_contracts::{JsonObject, JsonValue, Receipt, ReferenceType};

use super::MAX_TREE_RECEIPTS;
use crate::receipts::RuntimeReceiptSignaturePolicy;
use crate::receipts::store::{LocalReceiptStore, ReceiptStoreError};

pub(super) fn load_children(
    store: &LocalReceiptStore,
    root: &Receipt,
    policy: RuntimeReceiptSignaturePolicy<'_>,
) -> (Vec<Receipt>, Vec<JsonValue>) {
    let mut children = Vec::new();
    let mut findings = Vec::new();
    let mut seen = BTreeSet::new();
    let mut pending = root
        .lineage
        .as_ref()
        .map(|lineage| lineage.children.clone())
        .unwrap_or_default();
    while let Some(reference) = pending.pop() {
        if children.len() >= MAX_TREE_RECEIPTS {
            finding(
                &mut findings,
                "receipt.tree.limit",
                "receipt tree exceeds the native proof limit",
            );
            break;
        }
        if reference.reference_type != ReferenceType::Receipt {
            finding(
                &mut findings,
                "receipt.tree.reference",
                "child reference is not a typed receipt reference",
            );
            continue;
        }
        let Some(receipt_id) = reference.uri.strip_prefix("runx:receipt:") else {
            finding(
                &mut findings,
                "receipt.tree.reference",
                "child receipt reference has an invalid URI",
            );
            continue;
        };
        if !seen.insert(receipt_id.to_owned()) {
            continue;
        }
        match store.read_exact_with_policy(receipt_id, policy) {
            Ok(receipt) => {
                if let Some(lineage) = &receipt.lineage {
                    pending.extend(lineage.children.clone());
                }
                children.push(receipt);
            }
            Err(error) => finding(
                &mut findings,
                "receipt.tree.child_unreadable",
                format!(
                    "child receipt {receipt_id} could not be verified: {}",
                    public_error(&error)
                ),
            ),
        }
    }
    (children, findings)
}

pub(super) fn store_finding(
    findings: &mut Vec<JsonValue>,
    receipt_id: &str,
    error: &ReceiptStoreError,
    label: &crate::ReceiptStoreLabel,
) {
    finding(
        findings,
        "receipt.store.unresolved",
        format!(
            "receipt {receipt_id} could not be resolved: {}",
            error.public_message(label)
        ),
    );
}

fn public_error(error: &ReceiptStoreError) -> &'static str {
    match error {
        ReceiptStoreError::MissingStore { .. } => "receipt store is missing",
        ReceiptStoreError::MissingReceipt { .. } => "receipt is missing",
        ReceiptStoreError::ReceiptProofInvalid { .. } => "receipt proof is invalid",
        ReceiptStoreError::InvalidReceiptId { .. } => "receipt id is invalid",
        _ => "receipt store evidence is invalid or unreadable",
    }
}

fn finding(findings: &mut Vec<JsonValue>, code: &str, message: impl Into<String>) {
    findings.push(JsonValue::Object(JsonObject::from([
        ("code".to_owned(), JsonValue::String(code.to_owned())),
        ("message".to_owned(), JsonValue::String(message.into())),
    ])));
}

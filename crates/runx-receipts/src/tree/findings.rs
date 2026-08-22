use std::collections::BTreeMap;

use runx_contracts::{
    Receipt, ReceiptClass, ReceiptPaidInvocationBinding, Reference, ReferenceType,
};

use super::{ReceiptTreeConfig, ResolvedReceipt};
use crate::{ReceiptFinding, ReceiptFindingCode, validate_receipt};

pub(super) fn duplicate_child_findings(children: &[ResolvedReceipt<'_>]) -> Vec<ReceiptFinding> {
    let mut seen = BTreeMap::new();
    children
        .iter()
        .filter_map(|child| {
            if seen
                .insert(child.receipt.id.as_str(), child.path.as_str())
                .is_some()
            {
                Some(ReceiptFinding {
                    code: ReceiptFindingCode::DuplicateChildReceipt,
                    path: format!("{}.id", child.path),
                    message: "child receipt ids must be unique".to_owned(),
                })
            } else {
                None
            }
        })
        .collect()
}

pub(super) fn child_receipt_findings(children: &[ResolvedReceipt<'_>]) -> Vec<ReceiptFinding> {
    children
        .iter()
        .flat_map(|child| {
            validate_receipt(child.receipt)
                .err()
                .map_or_else(Vec::new, |verification| {
                    verification
                        .findings
                        .into_iter()
                        .map(|finding| child_finding(&child.path, finding))
                        .collect()
                })
        })
        .collect()
}

pub(super) fn orphan_child_findings(
    children: &[ResolvedReceipt<'_>],
    reached: &std::collections::BTreeSet<String>,
) -> Vec<ReceiptFinding> {
    children
        .iter()
        .filter(|child| !reached.contains(child.receipt.id.as_str()))
        .map(|child| ReceiptFinding {
            code: ReceiptFindingCode::OrphanChildReceipt,
            path: format!("{}.id", child.path),
            message: "supplied child receipts must be reachable from the root receipt".to_owned(),
        })
        .collect()
}

pub(super) fn missing_child(path: &str) -> ReceiptFinding {
    ReceiptFinding {
        code: ReceiptFindingCode::ChildReceiptMissing,
        path: path.to_owned(),
        message: "child receipt ref must resolve to a supplied child receipt".to_owned(),
    }
}

pub(super) fn malformed_child_ref(path: &str) -> ReceiptFinding {
    ReceiptFinding {
        code: ReceiptFindingCode::ChildReceiptRefMalformed,
        path: path.to_owned(),
        message: "child receipt ref must be a typed runx receipt URI".to_owned(),
    }
}

pub(super) fn ambiguous_child(path: &str) -> ReceiptFinding {
    ReceiptFinding {
        code: ReceiptFindingCode::ChildReceiptAmbiguous,
        path: path.to_owned(),
        message: "child receipt ref resolved to multiple supplied receipts".to_owned(),
    }
}

pub(super) fn resolver_error(path: &str) -> ReceiptFinding {
    ReceiptFinding {
        code: ReceiptFindingCode::ChildReceiptResolverError,
        path: path.to_owned(),
        message: "child receipt ref resolver failed before proof verification".to_owned(),
    }
}

pub(super) fn parent_link_findings(
    path: &str,
    parent: &Receipt,
    child: &Receipt,
    config: ReceiptTreeConfig,
) -> Vec<ReceiptFinding> {
    let parent_uri = format!("runx:receipt:{}", parent.id);
    let child_parent = child
        .lineage
        .as_ref()
        .and_then(|lineage| lineage.parent.as_ref());
    match child_parent {
        Some(parent_ref) if parent_ref.uri == parent_uri => Vec::new(),
        Some(_) => vec![ReceiptFinding {
            code: ReceiptFindingCode::ChildReceiptParentMismatch,
            path: format!("{path}.lineage.parent"),
            message: "child lineage parent ref must match the parent receipt".to_owned(),
        }],
        None if config.require_parent_links => vec![ReceiptFinding {
            code: ReceiptFindingCode::ChildReceiptParentMismatch,
            path: format!("{path}.lineage.parent"),
            message: "strict tree verification requires child lineage parent refs".to_owned(),
        }],
        None => Vec::new(),
    }
}

pub(super) fn child_digest_link_findings(
    path: &str,
    reference: &Reference,
    child: &Receipt,
) -> Vec<ReceiptFinding> {
    if reference.locator.as_deref() == Some(child.digest.as_str()) {
        return Vec::new();
    }
    vec![ReceiptFinding {
        code: ReceiptFindingCode::ChildReceiptDigestMismatch,
        path: format!("{path}.locator"),
        message:
            "strict tree proof requires child receipt refs to carry the exact child receipt digest"
                .to_owned(),
    }]
}

pub(super) fn inner_receipt_link_findings(
    path: &str,
    outer: &Receipt,
    inner: &Receipt,
    expected: &ReceiptPaidInvocationBinding,
) -> Vec<ReceiptFinding> {
    let mut findings = Vec::new();
    if inner.class != ReceiptClass::Executed {
        findings.push(ReceiptFinding {
            code: ReceiptFindingCode::InnerReceiptClassMismatch,
            path: format!("{path}.class"),
            message: "inner receipt evidence must resolve to an executed receipt".to_owned(),
        });
    }
    if inner.subject.paid_invocation.as_ref() != Some(expected) {
        findings.push(ReceiptFinding {
            code: ReceiptFindingCode::InnerReceiptBindingMismatch,
            path: format!("{path}.subject.paid_invocation"),
            message: "resolved inner receipt binding must equal the signed outer expectation"
                .to_owned(),
        });
    }

    if let Some(parent_binding) = expected.parent_binding.as_ref()
        && let Some(outer_binding) = outer.subject.paid_invocation.as_ref()
    {
        if parent_binding.invocation_id != outer_binding.invocation_id {
            findings.push(ReceiptFinding {
                code: ReceiptFindingCode::InnerReceiptParentInvocationMismatch,
                path: format!("{path}.subject.paid_invocation.parent_binding.invocation_id"),
                message: "inner parent invocation id must equal the outer paid invocation id"
                    .to_owned(),
            });
        }
        if parent_binding.execution_digest != outer_binding.package_digest {
            findings.push(ReceiptFinding {
                code: ReceiptFindingCode::InnerReceiptParentDigestMismatch,
                path: format!("{path}.subject.paid_invocation.parent_binding.execution_digest"),
                message: "inner parent execution digest must equal the outer package digest"
                    .to_owned(),
            });
        }
    }

    let outer_uri = format!("runx:receipt:{}", outer.id);
    if inner
        .lineage
        .as_ref()
        .and_then(|lineage| lineage.parent.as_ref())
        .is_some_and(|parent| parent.uri == outer_uri)
    {
        findings.push(ReceiptFinding {
            code: ReceiptFindingCode::InnerReceiptLineageConflict,
            path: format!("{path}.lineage.parent"),
            message: "composite inner receipts bind the outer invocation, not the outer receipt id"
                .to_owned(),
        });
    }
    findings
}

pub(super) fn child_finding(path: &str, finding: ReceiptFinding) -> ReceiptFinding {
    ReceiptFinding {
        path: format!("{path}.{}", finding.path),
        ..finding
    }
}

pub(super) fn join(path: &str, segment: &str) -> String {
    if path.is_empty() {
        segment.to_owned()
    } else {
        format!("{path}.{segment}")
    }
}

pub(super) fn referenced_receipt_id(reference: &Reference) -> Option<&str> {
    if reference.reference_type != ReferenceType::Receipt {
        return None;
    }
    reference
        .uri
        .strip_prefix("runx:receipt:")
        .filter(|id| !id.is_empty())
}

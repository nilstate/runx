use std::collections::BTreeSet;

use runx_contracts::{
    Receipt, ReceiptEvidence, ReceiptPaidInvocationBinding, Reference, ReferenceType,
};

use super::{ReceiptResolveResult, ReceiptResolver, ReceiptTreeConfig};
use crate::tree::findings::{
    ambiguous_child, inner_receipt_link_findings, join, malformed_child_ref, missing_child,
    parent_link_findings, resolver_error,
};
use crate::tree::proof::ChildProofPolicy;
use crate::{ReceiptFinding, ReceiptFindingCode};

pub(super) struct TreeTraversal<'a, R: ReceiptResolver, P: ChildProofPolicy> {
    pub(super) resolver: &'a R,
    pub(super) config: ReceiptTreeConfig,
    pub(super) proof_policy: P,
    pub(super) visiting: BTreeSet<String>,
    pub(super) reached: BTreeSet<String>,
}

#[derive(Clone, Copy)]
enum ReceiptEdge<'a> {
    Lineage(&'a Reference),
    InnerEvidence {
        reference: &'a Reference,
        expected: &'a ReceiptPaidInvocationBinding,
    },
}

impl<'a> ReceiptEdge<'a> {
    fn reference(self) -> &'a Reference {
        match self {
            Self::Lineage(reference) | Self::InnerEvidence { reference, .. } => reference,
        }
    }
}

impl<R: ReceiptResolver, P: ChildProofPolicy> TreeTraversal<'_, R, P> {
    pub(super) fn subtree_findings(
        &mut self,
        path: &str,
        receipt: &Receipt,
        depth: usize,
    ) -> Vec<ReceiptFinding> {
        if !self.visiting.insert(receipt.id.to_string()) {
            return vec![ReceiptFinding {
                code: ReceiptFindingCode::ChildReceiptCycle,
                path: join(path, "id"),
                message: "child receipt refs must not form cycles".to_owned(),
            }];
        }

        let mut findings = Vec::new();
        let mut edges = receipt
            .lineage
            .as_ref()
            .into_iter()
            .flat_map(|lineage| lineage.children.iter())
            .map(ReceiptEdge::Lineage)
            .collect::<Vec<_>>();
        edges.extend(receipt.evidence.iter().map(|evidence| match evidence {
            ReceiptEvidence::InnerReceipt {
                receipt_ref,
                expected,
            } => ReceiptEdge::InnerEvidence {
                reference: receipt_ref,
                expected,
            },
        }));
        if edges.len() > self.config.max_breadth {
            let breadth_path = if receipt.evidence.is_empty() {
                "lineage.children"
            } else {
                "receipt_edges"
            };
            findings.push(ReceiptFinding {
                code: ReceiptFindingCode::ChildReceiptBreadthLimit,
                path: join(path, breadth_path),
                message: "receipt refs exceed configured breadth limit".to_owned(),
            });
        }

        let child_findings = edges
            .iter()
            .take(self.config.max_breadth)
            .enumerate()
            .flat_map(|(index, edge)| {
                let edge_path = match edge {
                    ReceiptEdge::Lineage(_) => {
                        let lineage_index = edges[..index]
                            .iter()
                            .filter(|candidate| matches!(candidate, ReceiptEdge::Lineage(_)))
                            .count();
                        format!("lineage.children[{lineage_index}]")
                    }
                    ReceiptEdge::InnerEvidence { .. } => {
                        let evidence_index = edges[..index]
                            .iter()
                            .filter(|candidate| {
                                matches!(candidate, ReceiptEdge::InnerEvidence { .. })
                            })
                            .count();
                        format!("evidence[{evidence_index}].receipt_ref")
                    }
                };
                self.child_ref_findings(&join(path, &edge_path), receipt, *edge, depth)
            })
            .collect::<Vec<_>>();
        findings.extend(child_findings);
        self.visiting.remove(receipt.id.as_str());
        findings
    }

    fn child_ref_findings(
        &mut self,
        path: &str,
        parent: &Receipt,
        edge: ReceiptEdge<'_>,
        depth: usize,
    ) -> Vec<ReceiptFinding> {
        let reference = edge.reference();
        if reference.reference_type != ReferenceType::Receipt {
            return vec![malformed_child_ref(path)];
        };
        let next_depth = depth.saturating_add(1);
        if next_depth > self.config.max_depth {
            return vec![ReceiptFinding {
                code: ReceiptFindingCode::ChildReceiptDepthLimit,
                path: path.to_owned(),
                message: "child receipt refs exceed configured depth limit".to_owned(),
            }];
        };
        let resolved = match self.resolver.resolve_child(reference) {
            ReceiptResolveResult::Found(resolved) => resolved,
            ReceiptResolveResult::Missing => return vec![missing_child(path)],
            ReceiptResolveResult::Malformed => return vec![malformed_child_ref(path)],
            ReceiptResolveResult::Ambiguous => return vec![ambiguous_child(path)],
            ReceiptResolveResult::ResolverError => return vec![resolver_error(path)],
        };
        let child = resolved.receipt;
        if self.visiting.contains(child.id.as_str()) {
            return vec![ReceiptFinding {
                code: ReceiptFindingCode::ChildReceiptCycle,
                path: path.to_owned(),
                message: "child receipt refs must not point to an ancestor".to_owned(),
            }];
        }
        let child_path = resolved.path.clone();
        let mut findings = self.proof_policy.findings(&resolved.path, reference, child);
        findings.extend(match edge {
            ReceiptEdge::Lineage(_) => parent_link_findings(path, parent, child, self.config),
            ReceiptEdge::InnerEvidence { expected, .. } => {
                inner_receipt_link_findings(&resolved.path, parent, child, expected)
            }
        });
        if self.reached.contains(child.id.as_str()) {
            return findings;
        }
        findings.extend(self.subtree_findings(&child_path, child, next_depth));
        self.reached.insert(child.id.to_string());
        findings
    }
}

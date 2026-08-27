//! Deterministic language-neutral receipt-composition vectors.

#![allow(clippy::print_stdout)]

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::{
    OfferRevisionRef, ParentInvocationBinding, PrincipalReference, Receipt, ReceiptClass,
    ReceiptEvidence, ReceiptIssuer, ReceiptPaidInvocationBinding, Reference, ReferenceType,
    Sha256Digest, sha256_prefixed,
};
use runx_receipts::{
    ReceiptProofContext, ReceiptProofContextProvider, ReceiptSignature as PublicReceiptSignature,
    ReceiptVerification, SignatureVerificationFailure, SignatureVerifier,
    canonical_receipt_body_digest, content_addressed_receipt_id, verify_receipt_tree_proof,
};
use serde::Deserialize;
use serde_json::json;

const BASE_RECEIPT: &str =
    include_str!("../../../fixtures/contracts/harness-spine/receipt-success.json");

#[derive(Deserialize)]
struct BaseFixture {
    expected: Receipt,
}

struct Vector {
    name: &'static str,
    description: &'static str,
    expected_valid: bool,
    outer: Receipt,
    inner_receipts: Vec<Receipt>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let (out, check) = args()?;
    let mut files = BTreeMap::new();
    for vector in vectors()? {
        let verification =
            verify_receipt_tree_proof(&vector.outer, &vector.inner_receipts, &FixtureProofContexts);
        if verification.valid != vector.expected_valid {
            return Err(format!(
                "{} expected valid={} but verifier returned {:?}",
                vector.name, vector.expected_valid, verification.findings
            )
            .into());
        }
        let document = json!({
            "description": vector.description,
            "expectation": if vector.expected_valid { "valid" } else { "invalid" },
            "expected_findings": finding_names(&verification),
            "inner_receipts": vector.inner_receipts,
            "name": vector.name,
            "outer": vector.outer,
        });
        files.insert(
            format!("{}.json", vector.name),
            format!("{}\n", serde_json::to_string(&document)?),
        );
    }

    let manifest_vectors = files
        .iter()
        .map(|(file, bytes)| {
            json!({
                "file": file,
                "sha256": sha256_prefixed(bytes.as_bytes()),
            })
        })
        .collect::<Vec<_>>();
    files.insert(
        "manifest.json".to_owned(),
        format!(
            "{}\n",
            serde_json::to_string(&json!({
                "canonicalization": "exact-file-bytes-v1",
                "vectors": manifest_vectors,
            }))?
        ),
    );
    reconcile(&out, &files, check)?;
    println!(
        "{} {} receipt composition fixtures",
        if check { "checked" } else { "generated" },
        files.len() - 1
    );
    Ok(())
}

fn vectors() -> Result<Vec<Vector>, Box<dyn Error>> {
    let direct = executed("paid_direct", '7', None)?;
    let mut bare = direct.clone();
    bare.class = ReceiptClass::Mediated;
    seal(&mut bare, true)?;

    let (outer, inner) = composite()?;
    let mut swapped = inner.clone();
    swapped
        .subject
        .paid_invocation
        .as_mut()
        .ok_or("inner binding missing")?
        .input_digest = digest('9')?;
    seal(&mut swapped, false)?;

    let mut wrong_vendor = inner.clone();
    wrong_vendor
        .subject
        .paid_invocation
        .as_mut()
        .ok_or("inner binding missing")?
        .vendor_ref = principal("vendor-2")?;
    seal(&mut wrong_vendor, false)?;

    let mut wrong_package = inner.clone();
    wrong_package
        .subject
        .paid_invocation
        .as_mut()
        .ok_or("inner binding missing")?
        .package_digest = digest('6')?;
    seal(&mut wrong_package, false)?;

    let mut wrong_parent_outer = outer.clone();
    let ReceiptEvidence::InnerReceipt { expected, .. } = wrong_parent_outer
        .evidence
        .first_mut()
        .ok_or("outer evidence missing")?;
    expected
        .parent_binding
        .as_mut()
        .ok_or("expected parent missing")?
        .execution_digest = digest('6')?;
    let mut wrong_parent_inner = inner.clone();
    wrong_parent_inner.subject.paid_invocation = Some(expected.clone());
    seal(&mut wrong_parent_inner, false)?;
    seal(&mut wrong_parent_outer, true)?;

    Ok(vec![
        Vector {
            name: "direct-executed",
            description: "A direct paid execution carries an executed class and atomic provenance.",
            expected_valid: true,
            outer: direct,
            inner_receipts: Vec::new(),
        },
        Vector {
            name: "bare-mediated",
            description: "A mediated receipt without verified inner evidence makes no composite claim.",
            expected_valid: true,
            outer: bare,
            inner_receipts: Vec::new(),
        },
        Vector {
            name: "marketplace-composite",
            description: "A mediated outer receipt is digest-bound to one executed inner receipt.",
            expected_valid: true,
            outer: outer.clone(),
            inner_receipts: vec![inner.clone()],
        },
        Vector {
            name: "missing-inner",
            description: "Typed inner evidence fails closed when the referenced receipt is absent.",
            expected_valid: false,
            outer: outer.clone(),
            inner_receipts: Vec::new(),
        },
        Vector {
            name: "swapped-inner",
            description: "An alternate same-id receipt with a different input cannot satisfy the outer evidence.",
            expected_valid: false,
            outer: outer.clone(),
            inner_receipts: vec![swapped],
        },
        Vector {
            name: "wrong-vendor",
            description: "An inner receipt for a different vendor principal is rejected.",
            expected_valid: false,
            outer: outer.clone(),
            inner_receipts: vec![wrong_vendor],
        },
        Vector {
            name: "wrong-package",
            description: "An inner receipt for different package bytes is rejected.",
            expected_valid: false,
            outer: outer.clone(),
            inner_receipts: vec![wrong_package],
        },
        Vector {
            name: "wrong-parent",
            description: "An inner parent digest that does not equal the outer package digest is rejected.",
            expected_valid: false,
            outer: wrong_parent_outer,
            inner_receipts: vec![wrong_parent_inner],
        },
    ])
}

fn composite() -> Result<(Receipt, Receipt), Box<dyn Error>> {
    let mut outer = executed("paid_outer", '7', None)?;
    outer.class = ReceiptClass::Mediated;
    outer
        .subject
        .paid_invocation
        .as_mut()
        .ok_or("missing outer paid binding")?
        .mediation = Some(serde_json::from_value(serde_json::json!({
        "listing_ref": "runx:listing:ausca/document-ocr@1.0.0#invoke",
        "endpoint_url": "https://vendor.example/v1/invocations",
        "vendor_offer_revision": {
            "offer_id": "ocr-v1",
            "revision": "2026-08-22.1",
            "revision_digest": format!("sha256:{}", "4".repeat(64)),
            "input_schema_digest": format!("sha256:{}", "2".repeat(64)),
            "output_schema_digest": format!("sha256:{}", "3".repeat(64))
        },
        "vendor_package_digest": format!("sha256:{}", "8".repeat(64)),
        "vendor_amount_minor": 100,
        "platform_fee_minor": 25,
        "currency": "USD",
        "settlement_family": "x402",
        "expected_receipt_class": "executed"
    }))?);
    let expected = binding(
        "paid_inner",
        '8',
        Some(ParentInvocationBinding {
            invocation_id: "paid_outer".into(),
            execution_digest: digest('7')?,
        }),
    )?;
    let mut inner = executed("paid_inner", '8', expected.parent_binding.clone())?;
    let mut receipt_ref = Reference::runx(ReferenceType::Receipt, &inner.id);
    receipt_ref.locator = Some(inner.digest.clone());
    outer.evidence = vec![ReceiptEvidence::InnerReceipt {
        receipt_ref,
        expected,
    }];
    seal(&mut outer, true)?;
    seal(&mut inner, true)?;
    Ok((outer, inner))
}

fn executed(
    invocation_id: &str,
    package: char,
    parent: Option<ParentInvocationBinding>,
) -> Result<Receipt, Box<dyn Error>> {
    let mut receipt = serde_json::from_str::<BaseFixture>(BASE_RECEIPT)?.expected;
    receipt.class = ReceiptClass::Executed;
    receipt
        .lineage
        .get_or_insert_with(Default::default)
        .children
        .clear();
    receipt.subject.paid_invocation = Some(binding(invocation_id, package, parent)?);
    receipt.evidence.clear();
    seal(&mut receipt, true)?;
    Ok(receipt)
}

fn binding(
    invocation_id: &str,
    package: char,
    parent: Option<ParentInvocationBinding>,
) -> Result<ReceiptPaidInvocationBinding, Box<dyn Error>> {
    Ok(ReceiptPaidInvocationBinding {
        invocation_id: invocation_id.into(),
        vendor_ref: principal("vendor-1")?,
        offer_revision: OfferRevisionRef {
            offer_id: "ocr-v1".into(),
            revision: "2026-08-22.1".into(),
            revision_digest: digest('4')?,
            input_schema_digest: digest('2')?,
            output_schema_digest: digest('3')?,
        },
        package_digest: digest(package)?,
        input_digest: digest('1')?,
        mediation: None,
        parent_binding: parent,
    })
}

fn principal(id: &str) -> Result<PrincipalReference, Box<dyn Error>> {
    PrincipalReference::new(Reference::runx(ReferenceType::Principal, id))
        .ok_or_else(|| "principal fixture is invalid".into())
}

fn digest(value: char) -> Result<Sha256Digest, Box<dyn Error>> {
    Sha256Digest::new(format!("sha256:{}", value.to_string().repeat(64)))
        .ok_or_else(|| "digest fixture is invalid".into())
}

fn seal(receipt: &mut Receipt, address: bool) -> Result<(), Box<dyn Error>> {
    if address {
        receipt.id = content_addressed_receipt_id(receipt)?.into();
    }
    let digest = canonical_receipt_body_digest(receipt)?;
    receipt.digest = digest.clone().into();
    receipt.signature.value = format!("sig:{digest}").into();
    Ok(())
}

fn finding_names(verification: &ReceiptVerification) -> Vec<String> {
    verification
        .findings
        .iter()
        .map(|finding| format!("{:?}", finding.code))
        .collect()
}

fn args() -> Result<(PathBuf, bool), Box<dyn Error>> {
    let mut out = None;
    let mut check = false;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => out = args.next().map(PathBuf::from),
            "--check" => check = true,
            other => return Err(format!("unknown argument {other}").into()),
        }
    }
    Ok((out.ok_or("--out is required")?, check))
}

fn reconcile(
    out: &Path,
    files: &BTreeMap<String, String>,
    check: bool,
) -> Result<(), Box<dyn Error>> {
    if !check {
        fs::create_dir_all(out)?;
    }
    for (name, expected) in files {
        let path = out.join(name);
        if check {
            if fs::read_to_string(&path)? != *expected {
                return Err(format!("fixture is stale: {}", path.display()).into());
            }
        } else {
            fs::write(path, expected)?;
        }
    }
    if check {
        let expected = files.keys().cloned().collect::<BTreeSet<_>>();
        for entry in fs::read_dir(out)? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if name.ends_with(".json") && !expected.contains(&name) {
                return Err(format!("orphan fixture: {name}").into());
            }
        }
    }
    Ok(())
}

struct FixtureProofContexts;

impl ReceiptProofContextProvider for FixtureProofContexts {
    fn proof_context<'a>(&'a self, _receipt: &Receipt) -> ReceiptProofContext<'a> {
        ReceiptProofContext {
            signature_verifier: Some(self),
            authority_verified: true,
            external_attestations_verified: true,
            verified_redaction_refs: BTreeSet::new(),
            verified_hash_commitments: BTreeSet::new(),
        }
    }
}

impl SignatureVerifier for FixtureProofContexts {
    fn verify(
        &self,
        _issuer: &ReceiptIssuer,
        signature: &PublicReceiptSignature,
        body_digest: &str,
    ) -> Result<(), SignatureVerificationFailure> {
        if signature.value == format!("sig:{body_digest}") {
            Ok(())
        } else {
            Err(SignatureVerificationFailure::SignatureMismatch)
        }
    }
}

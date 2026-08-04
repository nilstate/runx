use std::fs;

use runx_contracts::{JsonObject, JsonValue, Receipt};

use super::prove_receipts;
use crate::{
    RUNX_CWD_ENV, RUNX_RECEIPT_DIR_ENV,
    receipts::{RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64_ENV, RUNX_RECEIPT_VERIFY_KID_ENV},
};

const RECEIPT_ID: &str = "sha256:fc1bb8c2027c1b0a76d8095a1d6c112e37a4f4d144991be4d505ec21314ccd39";

#[test]
fn proves_exact_production_receipt_without_a_store_scan() -> Result<(), String> {
    let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
    let receipt_dir = temp.path().join("receipts");
    fs::create_dir_all(&receipt_dir).map_err(|error| error.to_string())?;
    fs::write(
        receipt_dir.join(format!("sha256-{}.json", &RECEIPT_ID[7..])),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/receipt-verify/valid-production/receipt.json"
        )),
    )
    .map_err(|error| error.to_string())?;
    let env = std::collections::BTreeMap::from([
        (
            RUNX_CWD_ENV.to_owned(),
            temp.path().to_string_lossy().into_owned(),
        ),
        (
            RUNX_RECEIPT_DIR_ENV.to_owned(),
            receipt_dir.to_string_lossy().into_owned(),
        ),
        (
            RUNX_RECEIPT_VERIFY_KID_ENV.to_owned(),
            "runx-cli-verify-fixture-key".to_owned(),
        ),
        (
            RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64_ENV.to_owned(),
            "4oqJcHUzMr1y/vQT5rCy7xtKrdp6osFB8jNxKmh2s1E=".to_owned(),
        ),
    ]);
    let proof = prove_receipts(&inputs(RECEIPT_ID), &env, temp.path())
        .map_err(|error| error.to_string())?;
    assert_eq!(text(&proof, &["decision"]), Some("verified"));
    assert_eq!(
        text(&proof, &["verification", "signature_mode"]),
        Some("production")
    );
    assert_eq!(boolean(&proof, &["verification", "intact"]), Some(true));
    Ok(())
}

#[test]
fn local_receipt_proof_never_claims_production_verification() -> Result<(), String> {
    let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
    let env = std::collections::BTreeMap::from([
        (
            RUNX_CWD_ENV.to_owned(),
            temp.path().to_string_lossy().into_owned(),
        ),
        (
            RUNX_RECEIPT_DIR_ENV.to_owned(),
            temp.path().join("receipts").to_string_lossy().into_owned(),
        ),
    ]);
    let proof = prove_receipts(&inputs(RECEIPT_ID), &env, temp.path())
        .map_err(|error| error.to_string())?;
    assert_eq!(text(&proof, &["decision"]), Some("needs_more_evidence"));
    assert_eq!(
        text(&proof, &["verification", "signature_mode"]),
        Some("local-development")
    );
    Ok(())
}

#[test]
fn valid_local_receipt_remains_explicitly_unverified() -> Result<(), String> {
    const LOCAL_RECEIPT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/harness/oracle/echo-skill.receipt.json"
    ));
    let receipt: Receipt =
        serde_json::from_str(LOCAL_RECEIPT).map_err(|error| error.to_string())?;
    let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
    let receipt_dir = temp.path().join("receipts");
    fs::create_dir_all(&receipt_dir).map_err(|error| error.to_string())?;
    fs::write(
        receipt_dir.join(format!("sha256-{}.json", &receipt.id[7..])),
        LOCAL_RECEIPT,
    )
    .map_err(|error| error.to_string())?;
    let env = std::collections::BTreeMap::from([(
        RUNX_RECEIPT_DIR_ENV.to_owned(),
        receipt_dir.to_string_lossy().into_owned(),
    )]);

    let proof = prove_receipts(&inputs(&receipt.id), &env, temp.path())
        .map_err(|error| error.to_string())?;

    assert_eq!(text(&proof, &["decision"]), Some("unverified"));
    assert_eq!(
        text(&proof, &["verification", "signature_mode"]),
        Some("local-development")
    );
    assert_eq!(boolean(&proof, &["verification", "intact"]), None);
    Ok(())
}

fn inputs(receipt_id: &str) -> Vec<String> {
    vec![receipt_id.to_owned()]
}

fn text<'a>(object: &'a JsonObject, path: &[&str]) -> Option<&'a str> {
    at(object, path)?.as_str()
}

fn boolean(object: &JsonObject, path: &[&str]) -> Option<bool> {
    at(object, path)?.as_bool()
}

fn at<'a>(object: &'a JsonObject, path: &[&str]) -> Option<&'a JsonValue> {
    let (first, rest) = path.split_first()?;
    let mut value = object.get(*first)?;
    for key in rest {
        value = value.as_object()?.get(*key)?;
    }
    Some(value)
}

// Test oracle: asserting via expect/unwrap is the intended failure mode, so the
// workspace expect/unwrap bans are lifted for this test target.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use runx_contracts::{JsonObject, Receipt};
use runx_runtime::receipts::{RuntimeReceiptSignaturePolicy, step_receipt};
use runx_runtime::{InvocationStatus, LocalReceiptStore, ReceiptStoreError, SkillOutput};
use serde_json::json;

// Receipt ids are content-addressed (`id = hash(canonical_body)`), so the
// store fixtures derive their ids from the sealed receipt rather than a literal.
fn success_receipt_id() -> String {
    success_receipt().expect("success receipt").id.into_string()
}

#[test]
fn missing_store_fails_closed() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    let store = LocalReceiptStore::new(temp.path().join("missing"));

    let result = store.list();

    assert!(matches!(
        result,
        Err(ReceiptStoreError::MissingStore { .. })
    ));
    Ok(())
}

#[test]
fn file_instead_of_directory_is_typed_error() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    let store_path = temp.path().join("receipts");
    fs::write(&store_path, "not a directory")?;
    let store = LocalReceiptStore::new(&store_path);

    let result = store.list();

    assert!(matches!(
        result,
        Err(ReceiptStoreError::StoreNotDirectory { .. })
    ));
    Ok(())
}

#[test]
fn malformed_receipt_json_is_typed_error() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    fs::write(temp.path().join("hrn_rcpt_bad.json"), "{")?;
    let store = LocalReceiptStore::new(temp.path());

    let result = store.read_exact("hrn_rcpt_bad");

    assert!(matches!(
        result,
        Err(ReceiptStoreError::MalformedJson { .. })
    ));
    Ok(())
}

#[test]
fn wrong_receipt_schema_is_typed_error() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    write_json(
        temp.path(),
        "hrn_rcpt_wrong.json",
        &json!({
            "schema": "runx.not_receipt.v1",
            "id": "hrn_rcpt_wrong"
        }),
    )?;
    let store = LocalReceiptStore::new(temp.path());

    let result = store.read_exact("hrn_rcpt_wrong");

    assert!(matches!(result, Err(ReceiptStoreError::WrongSchema { .. })));
    Ok(())
}

#[test]
fn receipt_id_must_match_file_name() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    write_json(temp.path(), "hrn_rcpt_other.json", &success_receipt()?)?;
    let store = LocalReceiptStore::new(temp.path());

    let result = store.read_exact("hrn_rcpt_other");

    assert!(matches!(
        result,
        Err(ReceiptStoreError::IdFilenameMismatch { .. })
    ));
    Ok(())
}

#[test]
fn receipt_id_must_match_content_address() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    let mut receipt = success_receipt()?;
    receipt.id = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        .to_owned()
        .into();
    write_json(temp.path(), &receipt_file_name(&receipt.id), &receipt)?;
    let store = LocalReceiptStore::new(temp.path());

    let result = store.read_exact(&receipt.id);

    assert!(matches!(
        result,
        Err(ReceiptStoreError::ReceiptProofInvalid { .. })
    ));
    Ok(())
}

#[test]
fn exact_read_does_not_use_partial_or_suffix_lookup() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    write_json(
        temp.path(),
        &receipt_file_name(&success_receipt_id()),
        &success_receipt()?,
    )?;
    let store = LocalReceiptStore::new(temp.path());

    let result = store.read_exact("alpha");

    assert!(matches!(
        result,
        Err(ReceiptStoreError::MissingReceipt { .. })
    ));
    Ok(())
}

#[test]
fn exact_read_list_and_rebuild_index_succeed() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    let success = success_receipt()?;
    let abnormal = abnormal_receipt()?;
    write_json(temp.path(), &receipt_file_name(&success.id), &success)?;
    write_json(temp.path(), &receipt_file_name(&abnormal.id), &abnormal)?;
    fs::write(temp.path().join("notes.txt"), "ignored")?;
    write_json(
        temp.path(),
        "effect-state.json",
        &json!({
            "schema_version": "runx.effect_state.v1",
            "families": {}
        }),
    )?;
    let store = LocalReceiptStore::new(temp.path());

    let receipt = store.read_exact(&success.id)?;
    let listed = store.list()?;
    let index = store.rebuild_index()?;
    let loaded_index = store.load_index()?;

    let mut expected_ids = vec![success.id.clone(), abnormal.id.clone()];
    expected_ids.sort();

    assert_eq!(receipt.id, success.id);
    assert_eq!(
        listed
            .iter()
            .map(|receipt| receipt.id.clone())
            .collect::<Vec<_>>(),
        expected_ids
    );
    assert_eq!(
        index
            .entries
            .iter()
            .map(|entry| entry.receipt_id.clone())
            .collect::<Vec<_>>(),
        expected_ids
    );
    assert_eq!(
        index.entries[0].file_name,
        receipt_file_name(&expected_ids[0])
    );
    assert_eq!(loaded_index.entries, index.entries);
    assert!(temp.path().join("index.json").exists());
    Ok(())
}

#[test]
fn list_and_index_ignore_non_receipt_json_files() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    let receipt = success_receipt()?;
    write_json(temp.path(), &receipt_file_name(&receipt.id), &receipt)?;
    fs::write(temp.path().join("sealed.json"), "")?;
    write_json(
        temp.path(),
        "answers.json",
        &json!({
            "answers": {}
        }),
    )?;
    write_json(
        temp.path(),
        "sha256:not-a-digest.json",
        &json!({
            "schema": "runx.receipt.v1",
            "id": "sha256:not-a-digest"
        }),
    )?;
    let store = LocalReceiptStore::new(temp.path());

    let listed = store.list()?;
    let index = store.rebuild_index()?;

    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, receipt.id);
    assert_eq!(index.entries.len(), 1);
    assert_eq!(index.entries[0].receipt_id, receipt.id);
    Ok(())
}

#[test]
fn valid_runtime_generated_receipt_is_accepted_by_read_list_and_index()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    let receipt = success_receipt()?;
    write_json(temp.path(), &receipt_file_name(&receipt.id), &receipt)?;
    let store = LocalReceiptStore::new(temp.path());

    assert_eq!(store.read_exact(&receipt.id)?.id, receipt.id);
    assert_eq!(store.list()?.len(), 1);
    assert_eq!(store.rebuild_index()?.entries[0].receipt_id, receipt.id);
    assert_eq!(store.load_index()?.entries[0].receipt_id, receipt.id);
    Ok(())
}

#[test]
fn production_read_policy_without_verifier_rejects_local_pseudo_receipt()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    let receipt = success_receipt()?;
    write_json(temp.path(), &receipt_file_name(&receipt.id), &receipt)?;
    let store = LocalReceiptStore::new(temp.path());

    let result = store.read_exact_with_policy(
        &receipt.id,
        RuntimeReceiptSignaturePolicy::production_without_verifier(),
    );

    assert!(matches!(
        &result,
        Err(ReceiptStoreError::ReceiptProofInvalid { .. })
    ));
    if let Err(ReceiptStoreError::ReceiptProofInvalid { message, .. }) = &result {
        assert!(
            message.contains("SignatureVerifierMissing"),
            "expected missing production verifier finding, got {message}"
        );
    }
    Ok(())
}

#[test]
fn exact_read_rejects_structural_receipt_with_tampered_signature()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    let mut receipt = success_receipt()?;
    receipt.signature.value = "sig:tampered".into();
    write_json(temp.path(), &receipt_file_name(&receipt.id), &receipt)?;
    let store = LocalReceiptStore::new(temp.path());

    let result = store.read_exact(&receipt.id);

    assert!(matches!(
        result,
        Err(ReceiptStoreError::ReceiptProofInvalid { .. })
    ));
    Ok(())
}

#[test]
fn list_rejects_structural_receipt_with_tampered_digest() -> Result<(), Box<dyn std::error::Error>>
{
    let temp = TestDir::new()?;
    let mut receipt = success_receipt()?;
    receipt.digest = "sha256:tampered".into();
    write_json(temp.path(), &receipt_file_name(&receipt.id), &receipt)?;
    let store = LocalReceiptStore::new(temp.path());

    let result = store.list();

    assert!(matches!(
        result,
        Err(ReceiptStoreError::ReceiptProofInvalid { .. })
    ));
    Ok(())
}

#[test]
fn load_index_rejects_indexed_structural_receipt_with_invalid_proof()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    let mut receipt = success_receipt()?;
    receipt.signature.value = "sig:tampered".into();
    write_json(temp.path(), &receipt_file_name(&receipt.id), &receipt)?;
    write_json(
        temp.path(),
        "index.json",
        &json!({
            "schema": "runx.receipt_store_index.v1",
            "generated_at": "1",
            "entries": [{
                "receipt_id": receipt.id,
                "file_name": receipt_file_name(&receipt.id),
                "created_at": receipt.created_at
            }]
        }),
    )?;
    let store = LocalReceiptStore::new(temp.path());

    let result = store.load_index();

    assert!(matches!(
        result,
        Err(ReceiptStoreError::ReceiptProofInvalid { .. })
    ));
    Ok(())
}

#[test]
fn write_receipt_commits_readable_receipt_and_index() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    let store = LocalReceiptStore::new(temp.path().join("receipts"));
    let receipt = success_receipt()?;

    store.write_receipt(&receipt)?;

    let stored = store.read_exact(&receipt.id)?;
    let index = store.load_index()?;
    assert_eq!(stored.id, receipt.id);
    assert_eq!(index.entries.len(), 1);
    assert_eq!(index.entries[0].receipt_id, receipt.id);
    assert!(store.root().join(format!("{}.json", receipt.id)).exists());
    assert!(store.root().join("index.json").exists());
    Ok(())
}

#[test]
fn write_receipt_rejects_invalid_proof_without_writing() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    let store = LocalReceiptStore::new(temp.path().join("receipts"));
    let mut receipt = success_receipt()?;
    receipt.signature.value = "sig:tampered".into();

    let result = store.write_receipt(&receipt);

    assert!(matches!(
        result,
        Err(ReceiptStoreError::ReceiptProofInvalid { .. })
    ));
    assert!(!store.root().join(format!("{}.json", receipt.id)).exists());
    Ok(())
}

#[test]
fn write_receipt_allows_identical_and_rejects_divergent_rewrite()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    let store = LocalReceiptStore::new(temp.path());
    let receipt = success_receipt()?;
    let mut changed = receipt.clone();
    changed.signature.value = "sig:different".into();

    store.write_receipt(&receipt)?;
    store.write_receipt(&receipt)?;
    let result = store.write_receipt(&changed);

    assert!(matches!(
        result,
        Err(ReceiptStoreError::ReceiptAlreadyExists { .. })
    ));
    Ok(())
}

#[test]
fn index_write_failure_reports_stale_but_receipt_stays_readable()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    fs::create_dir(temp.path().join("index.json"))?;
    let store = LocalReceiptStore::new(temp.path());
    let receipt = success_receipt()?;

    let result = store.write_receipt(&receipt);

    assert!(matches!(
        result,
        Err(ReceiptStoreError::ReceiptIndexStale { .. })
    ));
    assert_eq!(store.read_exact(&receipt.id)?.id, receipt.id);
    Ok(())
}

#[test]
fn malformed_index_is_typed_error() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    fs::write(temp.path().join("index.json"), "{")?;
    let store = LocalReceiptStore::new(temp.path());

    let result = store.load_index();

    assert!(matches!(
        result,
        Err(ReceiptStoreError::MalformedIndex { .. })
    ));
    Ok(())
}

#[test]
fn stale_index_is_typed_error() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TestDir::new()?;
    write_json(
        temp.path(),
        &receipt_file_name(&success_receipt_id()),
        &success_receipt()?,
    )?;
    write_json(
        temp.path(),
        "index.json",
        &json!({
            "schema": "runx.receipt_store_index.v1",
            "generated_at": "1",
            "entries": []
        }),
    )?;
    let store = LocalReceiptStore::new(temp.path());

    let result = store.load_index();

    assert!(matches!(
        result,
        Err(ReceiptStoreError::ReceiptIndexStale { .. })
    ));
    Ok(())
}

#[test]
fn receipt_store_error_display_does_not_leak_absolute_paths()
-> Result<(), Box<dyn std::error::Error>> {
    let external = PathBuf::from("/Users/kam/private/runx-receipts");
    let errors = [
        ReceiptStoreError::MissingStore {
            path: external.clone(),
        }
        .to_string(),
        ReceiptStoreError::MalformedIndex {
            path: external,
            message: "bad".to_owned(),
        }
        .to_string(),
        ReceiptStoreError::ReceiptProofInvalid {
            path: PathBuf::from("/Users/kam/private/runx-receipts"),
            receipt_id: success_receipt_id(),
            message: "bad".to_owned(),
        }
        .to_string(),
    ];

    for message in errors {
        assert_redacts_external_path(&message);
    }
    Ok(())
}

#[test]
fn store_public_projection_redacts_external_absolute_root() {
    let workspace = PathBuf::from("/workspace/runx");
    let project_runx_dir = workspace.join(".runx");
    let external = PathBuf::from("/Users/kam/private/runx-receipts");
    let store = LocalReceiptStore::new(&external);

    let projection = store.public_projection(&workspace, &project_runx_dir);
    let summary = projection.summary();
    let label = projection.label().as_str();

    assert!(label.starts_with("external-receipt-store:"));
    assert!(summary.contains(label));
    assert_redacts_external_path(&summary);
}

#[test]
fn store_public_projection_uses_project_relative_root() {
    let workspace = PathBuf::from("/workspace/runx");
    let project_runx_dir = workspace.join(".runx");
    let store = LocalReceiptStore::new(project_runx_dir.join("receipts"));

    let projection = store.public_projection(&workspace, &project_runx_dir);

    assert_eq!(projection.label().as_str(), ".runx/receipts");
    assert_eq!(projection.summary(), "receipt store: .runx/receipts");
}

#[test]
fn receipt_store_error_public_message_uses_safe_label() {
    let workspace = PathBuf::from("/workspace/runx");
    let project_runx_dir = workspace.join(".runx");
    let external = PathBuf::from("/Users/kam/private/runx-receipts");
    let store = LocalReceiptStore::new(&external);
    let projection = store.public_projection(&workspace, &project_runx_dir);
    let error = ReceiptStoreError::MissingStore { path: external };

    let message = error.public_message(projection.label());

    assert!(message.contains(projection.label().as_str()));
    assert_redacts_external_path(&message);
}

#[test]
fn receipt_store_error_public_message_redacts_path_like_fields() {
    let workspace = PathBuf::from("/workspace/runx");
    let project_runx_dir = workspace.join(".runx");
    let external = PathBuf::from("/Users/kam/private/runx-receipts");
    let store = LocalReceiptStore::new(&external);
    let projection = store.public_projection(&workspace, &project_runx_dir);
    let invalid_id = ReceiptStoreError::InvalidReceiptId {
        receipt_id: external.to_string_lossy().into_owned(),
    };
    let mismatch = ReceiptStoreError::IdFilenameMismatch {
        path: external,
        receipt_id: "/Users/kam/private/runx-receipts".to_owned(),
        file_stem: "runx-receipts".to_owned(),
    };

    let invalid_id_message = invalid_id.public_message(projection.label());
    let mismatch_message = mismatch.public_message(projection.label());

    assert_redacts_external_path(&invalid_id_message);
    assert_redacts_external_path(&mismatch_message);
}

fn success_receipt() -> Result<Receipt, Box<dyn std::error::Error>> {
    runtime_receipt("store", "alpha", InvocationStatus::Success)
}

fn abnormal_receipt() -> Result<Receipt, Box<dyn std::error::Error>> {
    runtime_receipt("store", "beta", InvocationStatus::Failure)
}

fn runtime_receipt(
    graph_name: &str,
    step_id: &str,
    status: InvocationStatus,
) -> Result<Receipt, Box<dyn std::error::Error>> {
    step_receipt(
        graph_name,
        step_id,
        1,
        &skill_output(status),
        "2026-05-18T00:01:00Z",
    )
    .map_err(Into::into)
}

fn skill_output(status: InvocationStatus) -> SkillOutput {
    let (stdout, stderr, exit_code) = match status {
        InvocationStatus::Success => ("ok".to_owned(), String::new(), Some(0)),
        InvocationStatus::Failure => (String::new(), "failed".to_owned(), Some(1)),
    };
    SkillOutput {
        status,
        stdout,
        stderr,
        exit_code,
        duration_ms: 1,
        metadata: JsonObject::new(),
    }
}

fn receipt_file_name(receipt_id: &str) -> String {
    format!("{receipt_id}.json")
}

fn write_json<T: serde::Serialize>(
    dir: &Path,
    file_name: &str,
    value: &T,
) -> Result<(), Box<dyn std::error::Error>> {
    fs::write(dir.join(file_name), serde_json::to_string(value)?)?;
    Ok(())
}

struct TestDir {
    path: PathBuf,
}

static NEXT_TEST_DIR: AtomicUsize = AtomicUsize::new(0);

impl TestDir {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let serial = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let path = std::env::temp_dir().join(format!(
            "runx-runtime-receipt-store-{}-{serial}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ignored = fs::remove_dir_all(&self.path);
    }
}

fn assert_redacts_external_path(text: &str) {
    assert!(!text.contains("/Users"));
    assert!(!text.contains("kam"));
    assert!(!text.contains("private"));
    assert!(!text.contains("runx-receipts"));
}

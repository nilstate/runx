// rust-style-allow: large-file -- local store read/write/index semantics stay
// together until the receipt-store API finishes the hard-cutover review.
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
#[cfg(not(windows))]
use std::fs::File;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use runx_contracts::{RECEIPT_SCHEMA, Receipt};
use runx_receipts::{
    ReceiptProofContextProvider, content_addressed_receipt_id, verify_receipt_proof,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::paths::{
    ReceiptStoreLabel, ReceiptStorePublicProjection, safe_receipt_store_projection,
};
use super::seal::{RuntimeReceiptProofContextProvider, RuntimeReceiptSignaturePolicy};

const RECEIPT_STORE_INDEX_SCHEMA: &str = "runx.receipt_store_index.v1";
const INDEX_FILE_NAME: &str = "index.json";
const EFFECT_STATE_FILE_NAME: &str = "effect-state.json";
const SHA256_RECEIPT_ID_PREFIX: &str = "sha256:";
const SHA256_RECEIPT_FILE_PREFIX: &str = "sha256-";

#[derive(Clone, Debug)]
pub struct LocalReceiptStore {
    root: PathBuf,
}

impl LocalReceiptStore {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    #[must_use]
    pub fn public_projection(
        &self,
        workspace_base: &Path,
        project_runx_dir: &Path,
    ) -> ReceiptStorePublicProjection {
        safe_receipt_store_projection(&self.root, workspace_base, project_runx_dir)
    }

    pub fn receipt_path(&self, receipt_id: &str) -> Result<PathBuf, ReceiptStoreError> {
        Ok(self.root.join(receipt_file_name(receipt_id)?))
    }

    pub fn read_exact(&self, receipt_id: &str) -> Result<Receipt, ReceiptStoreError> {
        self.read_exact_with_policy(
            receipt_id,
            RuntimeReceiptSignaturePolicy::local_development(),
        )
    }

    pub fn read_exact_with_policy(
        &self,
        receipt_id: &str,
        signature_policy: RuntimeReceiptSignaturePolicy<'_>,
    ) -> Result<Receipt, ReceiptStoreError> {
        let file_path = self.receipt_path(receipt_id)?;
        self.ensure_store_dir()?;
        read_receipt_file(&file_path, receipt_id, signature_policy)
    }

    pub fn write_receipt(&self, receipt: &Receipt) -> Result<(), ReceiptStoreError> {
        self.write_receipt_with_policy(receipt, RuntimeReceiptSignaturePolicy::local_development())
    }

    pub fn write_receipt_with_policy(
        &self,
        receipt: &Receipt,
        signature_policy: RuntimeReceiptSignaturePolicy<'_>,
    ) -> Result<(), ReceiptStoreError> {
        let file_name = receipt_file_name(&receipt.id)?;
        self.ensure_or_create_store_dir()?;
        let file_path = self.root.join(&file_name);
        let contents =
            serde_json::to_vec(receipt).map_err(|source| ReceiptStoreError::MalformedReceipt {
                path: file_path.clone(),
                message: source.to_string(),
            })?;

        if file_path.exists() {
            let existing =
                fs::read(&file_path).map_err(|source| ReceiptStoreError::ReceiptUnreadable {
                    path: file_path.clone(),
                    source,
                })?;
            if existing == contents {
                verify_stored_receipt_proof(&file_path, receipt, signature_policy)?;
                return Ok(());
            }
            return Err(ReceiptStoreError::ReceiptAlreadyExists {
                receipt_id: receipt.id.to_string(),
            });
        }

        verify_stored_receipt_proof(&file_path, receipt, signature_policy)?;
        write_atomic(&self.root, &file_name, &contents)?;
        self.update_index_after_write(receipt, signature_policy)
    }

    pub fn list(&self) -> Result<Vec<Receipt>, ReceiptStoreError> {
        self.list_with_policy(RuntimeReceiptSignaturePolicy::local_development())
    }

    pub fn list_with_policy(
        &self,
        signature_policy: RuntimeReceiptSignaturePolicy<'_>,
    ) -> Result<Vec<Receipt>, ReceiptStoreError> {
        self.ensure_store_dir()?;
        let mut receipts = Vec::new();
        for entry in
            fs::read_dir(&self.root).map_err(|source| ReceiptStoreError::StoreUnreadable {
                path: self.root.clone(),
                source,
            })?
        {
            let entry = entry.map_err(|source| ReceiptStoreError::StoreUnreadable {
                path: self.root.clone(),
                source,
            })?;
            let path = entry.path();
            if !is_receipt_json_path(&path) {
                continue;
            }
            let Some(receipt_id) = path
                .file_stem()
                .and_then(OsStr::to_str)
                .and_then(receipt_id_from_file_stem)
            else {
                continue;
            };
            receipts.push(read_receipt_file(&path, &receipt_id, signature_policy)?);
        }
        receipts.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(receipts)
    }

    pub(crate) fn list_without_proof_for_history(&self) -> Result<Vec<Receipt>, ReceiptStoreError> {
        self.ensure_store_dir()?;
        let mut receipts = Vec::new();
        for entry in
            fs::read_dir(&self.root).map_err(|source| ReceiptStoreError::StoreUnreadable {
                path: self.root.clone(),
                source,
            })?
        {
            let entry = entry.map_err(|source| ReceiptStoreError::StoreUnreadable {
                path: self.root.clone(),
                source,
            })?;
            let path = entry.path();
            if !is_receipt_json_path(&path) {
                continue;
            }
            let Some(receipt_id) = path
                .file_stem()
                .and_then(OsStr::to_str)
                .and_then(receipt_id_from_file_stem)
            else {
                continue;
            };
            receipts.push(read_receipt_file_without_proof(&path, &receipt_id)?);
        }
        receipts.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(receipts)
    }

    pub fn load_index(&self) -> Result<ReceiptStoreIndex, ReceiptStoreError> {
        self.load_index_with_policy(RuntimeReceiptSignaturePolicy::local_development())
    }

    pub fn load_index_with_policy(
        &self,
        signature_policy: RuntimeReceiptSignaturePolicy<'_>,
    ) -> Result<ReceiptStoreIndex, ReceiptStoreError> {
        self.ensure_store_dir()?;
        let index_path = self.index_path();
        let contents = match fs::read_to_string(&index_path) {
            Ok(contents) => contents,
            Err(source) if source.kind() == ErrorKind::NotFound => {
                return self.rebuild_index_with_policy(signature_policy);
            }
            Err(source) => {
                return Err(ReceiptStoreError::StoreUnreadable {
                    path: index_path,
                    source,
                });
            }
        };
        let index = parse_index(&contents, &index_path)?;
        self.verify_index(&index, signature_policy)?;
        Ok(index)
    }

    pub fn rebuild_index(&self) -> Result<ReceiptStoreIndex, ReceiptStoreError> {
        self.rebuild_index_with_policy(RuntimeReceiptSignaturePolicy::local_development())
    }

    pub fn rebuild_index_with_policy(
        &self,
        signature_policy: RuntimeReceiptSignaturePolicy<'_>,
    ) -> Result<ReceiptStoreIndex, ReceiptStoreError> {
        let entries = self
            .list_with_policy(signature_policy)?
            .into_iter()
            .map(|receipt| {
                let receipt_id = receipt.id.to_string();
                Ok(ReceiptStoreIndexEntry {
                    file_name: receipt_file_name(&receipt_id)?,
                    receipt_id,
                    created_at: receipt.created_at.to_string(),
                })
            })
            .collect::<Result<Vec<_>, ReceiptStoreError>>()?;
        let index = ReceiptStoreIndex {
            schema: RECEIPT_STORE_INDEX_SCHEMA.to_owned(),
            generated_at: generated_at_nanos(),
            entries,
        };
        self.write_index(&index)?;
        Ok(index)
    }

    fn verify_index(
        &self,
        index: &ReceiptStoreIndex,
        signature_policy: RuntimeReceiptSignaturePolicy<'_>,
    ) -> Result<(), ReceiptStoreError> {
        let listed = self.list_with_policy(signature_policy)?;
        let listed_entries = listed
            .iter()
            .map(|receipt| {
                let receipt_id = receipt.id.to_string();
                Ok(ReceiptStoreIndexEntry {
                    file_name: receipt_file_name(&receipt_id)?,
                    receipt_id,
                    created_at: receipt.created_at.to_string(),
                })
            })
            .collect::<Result<Vec<_>, ReceiptStoreError>>()?;
        if listed_entries != index.entries {
            return Err(ReceiptStoreError::ReceiptIndexStale {
                path: self.index_path(),
                message: "index entries do not match receipt JSON files".to_owned(),
            });
        }
        Ok(())
    }

    fn update_index_after_write(
        &self,
        receipt: &Receipt,
        signature_policy: RuntimeReceiptSignaturePolicy<'_>,
    ) -> Result<(), ReceiptStoreError> {
        match self.append_index_entry(receipt) {
            Ok(()) => Ok(()),
            Err(_) => match self.rebuild_index_with_policy(signature_policy) {
                Ok(_) => Ok(()),
                Err(error) => Err(ReceiptStoreError::ReceiptIndexStale {
                    path: self.index_path(),
                    message: error.to_string(),
                }),
            },
        }
    }

    fn append_index_entry(&self, receipt: &Receipt) -> Result<(), ReceiptStoreError> {
        let mut index = self.read_index_without_verification()?;
        ensure_index_shape_for_append(&index)?;
        let receipt_id = receipt.id.to_string();
        if index
            .entries
            .iter()
            .any(|entry| entry.receipt_id == receipt_id)
        {
            return Err(ReceiptStoreError::ReceiptIndexStale {
                path: self.index_path(),
                message: "index already contains receipt id".to_owned(),
            });
        }
        if self.receipt_file_count()? != index.entries.len().saturating_add(1) {
            return Err(ReceiptStoreError::ReceiptIndexStale {
                path: self.index_path(),
                message: "index entry count does not match receipt JSON files".to_owned(),
            });
        }
        index.entries.push(ReceiptStoreIndexEntry {
            receipt_id: receipt_id.clone(),
            file_name: receipt_file_name(&receipt_id)?,
            created_at: receipt.created_at.to_string(),
        });
        index
            .entries
            .sort_by(|left, right| left.receipt_id.cmp(&right.receipt_id));
        index.generated_at = generated_at_nanos();
        self.write_index(&index)
    }

    fn read_index_without_verification(&self) -> Result<ReceiptStoreIndex, ReceiptStoreError> {
        let index_path = self.index_path();
        let contents = fs::read_to_string(&index_path).map_err(|source| {
            ReceiptStoreError::StoreUnreadable {
                path: index_path.clone(),
                source,
            }
        })?;
        parse_index(&contents, &index_path)
    }

    fn receipt_file_count(&self) -> Result<usize, ReceiptStoreError> {
        let mut count = 0usize;
        for entry in
            fs::read_dir(&self.root).map_err(|source| ReceiptStoreError::StoreUnreadable {
                path: self.root.clone(),
                source,
            })?
        {
            let entry = entry.map_err(|source| ReceiptStoreError::StoreUnreadable {
                path: self.root.clone(),
                source,
            })?;
            let path = entry.path();
            if is_receipt_json_path(&path) {
                count += 1;
            }
        }
        Ok(count)
    }

    fn write_index(&self, index: &ReceiptStoreIndex) -> Result<(), ReceiptStoreError> {
        let contents =
            serde_json::to_vec(index).map_err(|source| ReceiptStoreError::MalformedIndex {
                path: self.index_path(),
                message: source.to_string(),
            })?;
        // `index.json` is a recoverable projection of receipt files. Receipt
        // writes remain durable; index writes stay atomic but skip fsync so an
        // append does not pay the full durability cost twice.
        write_atomic_cache(&self.root, INDEX_FILE_NAME, &contents)
    }

    fn index_path(&self) -> PathBuf {
        self.root.join(INDEX_FILE_NAME)
    }

    fn ensure_store_dir(&self) -> Result<(), ReceiptStoreError> {
        match fs::metadata(&self.root) {
            Ok(metadata) if metadata.is_dir() => Ok(()),
            Ok(_) => Err(ReceiptStoreError::StoreNotDirectory {
                path: self.root.clone(),
            }),
            Err(source) if source.kind() == ErrorKind::NotFound => {
                Err(ReceiptStoreError::MissingStore {
                    path: self.root.clone(),
                })
            }
            Err(source) => Err(ReceiptStoreError::StoreUnreadable {
                path: self.root.clone(),
                source,
            }),
        }
    }

    fn ensure_or_create_store_dir(&self) -> Result<(), ReceiptStoreError> {
        match fs::metadata(&self.root) {
            Ok(metadata) if metadata.is_dir() => Ok(()),
            Ok(_) => Err(ReceiptStoreError::StoreNotDirectory {
                path: self.root.clone(),
            }),
            Err(source) if source.kind() == ErrorKind::NotFound => fs::create_dir_all(&self.root)
                .map_err(|source| ReceiptStoreError::StoreUnreadable {
                    path: self.root.clone(),
                    source,
                }),
            Err(source) => Err(ReceiptStoreError::StoreUnreadable {
                path: self.root.clone(),
                source,
            }),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptStoreIndex {
    pub schema: String,
    pub generated_at: String,
    pub entries: Vec<ReceiptStoreIndexEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptStoreIndexEntry {
    pub receipt_id: String,
    pub file_name: String,
    pub created_at: String,
}

#[derive(Debug, Error)]
pub enum ReceiptStoreError {
    #[error("receipt store is missing")]
    MissingStore { path: PathBuf },
    #[error("receipt store path is not a directory")]
    StoreNotDirectory { path: PathBuf },
    #[error("receipt store is unreadable: {source}")]
    StoreUnreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("receipt id is invalid for local store lookup: {receipt_id}")]
    InvalidReceiptId { receipt_id: String },
    #[error("receipt is missing")]
    MissingReceipt { path: PathBuf },
    #[error("receipt is unreadable: {source}")]
    ReceiptUnreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("receipt JSON is malformed: {message}")]
    MalformedJson { path: PathBuf, message: String },
    #[error("receipt has unsupported schema: {schema}")]
    WrongSchema { path: PathBuf, schema: String },
    #[error("receipt shape is invalid: {message}")]
    MalformedReceipt { path: PathBuf, message: String },
    #[error("receipt id '{receipt_id}' does not match file name '{file_stem}'")]
    IdFilenameMismatch {
        path: PathBuf,
        receipt_id: String,
        file_stem: String,
    },
    #[error("receipt proof is invalid for {receipt_id}: {message}")]
    ReceiptProofInvalid {
        path: PathBuf,
        receipt_id: String,
        message: String,
    },
    #[error("receipt already exists with different content: {receipt_id}")]
    ReceiptAlreadyExists { receipt_id: String },
    #[error("receipt store index is malformed: {message}")]
    MalformedIndex { path: PathBuf, message: String },
    #[error("receipt store index is stale: {message}")]
    ReceiptIndexStale { path: PathBuf, message: String },
    #[error("receipt store path cannot be projected safely: {reason}")]
    UnsafePathProjection { reason: String },
}

impl ReceiptStoreError {
    #[must_use]
    pub fn public_message(&self, store_label: &ReceiptStoreLabel) -> String {
        match self {
            Self::MissingStore { .. } => format!("receipt store {store_label} is missing"),
            Self::StoreNotDirectory { .. } => {
                format!("receipt store {store_label} is not a directory")
            }
            Self::StoreUnreadable { .. } => format!("receipt store {store_label} is unreadable"),
            Self::InvalidReceiptId { .. } => {
                "receipt id is invalid for local store lookup".to_owned()
            }
            Self::MissingReceipt { .. } => format!("receipt is missing in store {store_label}"),
            Self::ReceiptUnreadable { .. } => {
                format!("receipt is unreadable in store {store_label}")
            }
            Self::MalformedJson { .. } => {
                format!("receipt JSON is malformed in store {store_label}")
            }
            Self::WrongSchema { schema, .. } => {
                format!("receipt has unsupported schema in store {store_label}: {schema}")
            }
            Self::MalformedReceipt { .. } => {
                format!("receipt shape is invalid in store {store_label}")
            }
            Self::IdFilenameMismatch { .. } => {
                format!("receipt id does not match file name in store {store_label}")
            }
            Self::ReceiptProofInvalid { .. } => {
                format!("receipt proof is invalid in store {store_label}")
            }
            Self::ReceiptAlreadyExists { .. } => {
                format!("receipt already exists with different content in store {store_label}")
            }
            Self::MalformedIndex { .. } => {
                format!("receipt store index is malformed in store {store_label}")
            }
            Self::ReceiptIndexStale { .. } => {
                format!("receipt store index is stale in store {store_label}")
            }
            Self::UnsafePathProjection { .. } => {
                "receipt store path cannot be projected safely".to_owned()
            }
        }
    }
}

fn receipt_file_name(receipt_id: &str) -> Result<String, ReceiptStoreError> {
    if let Some(digest) = receipt_id.strip_prefix(SHA256_RECEIPT_ID_PREFIX) {
        if is_sha256_hex_digest(digest) {
            return Ok(format!("{SHA256_RECEIPT_FILE_PREFIX}{digest}.json"));
        }
    } else if is_safe_literal_receipt_file_stem(receipt_id) {
        return Ok(format!("{receipt_id}.json"));
    }
    Err(ReceiptStoreError::InvalidReceiptId {
        receipt_id: receipt_id.to_owned(),
    })
}

fn is_receipt_json_path(path: &Path) -> bool {
    path.extension() == Some(OsStr::new("json"))
        && path.file_name().is_some_and(|file_name| {
            file_name != OsStr::new(INDEX_FILE_NAME)
                && file_name != OsStr::new(EFFECT_STATE_FILE_NAME)
        })
        && path
            .file_stem()
            .and_then(OsStr::to_str)
            .and_then(receipt_id_from_file_stem)
            .is_some()
}

fn receipt_id_from_file_stem(stem: &str) -> Option<String> {
    if let Some(digest) = stem.strip_prefix(SHA256_RECEIPT_FILE_PREFIX) {
        return is_sha256_hex_digest(digest).then(|| format!("{SHA256_RECEIPT_ID_PREFIX}{digest}"));
    };
    None
}

fn is_sha256_hex_digest(digest: &str) -> bool {
    digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_safe_literal_receipt_file_stem(stem: &str) -> bool {
    !(stem.is_empty() || stem == "." || stem == "..")
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn read_receipt_file(
    path: &Path,
    expected_id: &str,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, ReceiptStoreError> {
    let contents = fs::read_to_string(path).map_err(|source| {
        if source.kind() == ErrorKind::NotFound {
            ReceiptStoreError::MissingReceipt {
                path: path.to_path_buf(),
            }
        } else {
            ReceiptStoreError::ReceiptUnreadable {
                path: path.to_path_buf(),
                source,
            }
        }
    })?;
    parse_receipt_contents(&contents, path, expected_id, signature_policy)
}

fn read_receipt_file_without_proof(
    path: &Path,
    expected_id: &str,
) -> Result<Receipt, ReceiptStoreError> {
    let contents = fs::read_to_string(path).map_err(|source| {
        if source.kind() == ErrorKind::NotFound {
            ReceiptStoreError::MissingReceipt {
                path: path.to_path_buf(),
            }
        } else {
            ReceiptStoreError::ReceiptUnreadable {
                path: path.to_path_buf(),
                source,
            }
        }
    })?;
    parse_receipt_contents_without_proof(&contents, path, expected_id)
}

fn parse_index(contents: &str, path: &Path) -> Result<ReceiptStoreIndex, ReceiptStoreError> {
    let index = serde_json::from_str::<ReceiptStoreIndex>(contents).map_err(|source| {
        ReceiptStoreError::MalformedIndex {
            path: path.to_path_buf(),
            message: source.to_string(),
        }
    })?;
    if index.schema != RECEIPT_STORE_INDEX_SCHEMA {
        return Err(ReceiptStoreError::MalformedIndex {
            path: path.to_path_buf(),
            message: format!("unsupported index schema {}", index.schema),
        });
    }
    Ok(index)
}

fn ensure_index_shape_for_append(index: &ReceiptStoreIndex) -> Result<(), ReceiptStoreError> {
    let mut previous_id: Option<&str> = None;
    for entry in &index.entries {
        let expected_file_name = receipt_file_name(&entry.receipt_id)?;
        if entry.file_name != expected_file_name {
            return Err(ReceiptStoreError::ReceiptIndexStale {
                path: PathBuf::from(INDEX_FILE_NAME),
                message: "index file name does not match receipt id".to_owned(),
            });
        }
        if previous_id.is_some_and(|previous| previous >= entry.receipt_id.as_str()) {
            return Err(ReceiptStoreError::ReceiptIndexStale {
                path: PathBuf::from(INDEX_FILE_NAME),
                message: "index receipt ids must be sorted and unique".to_owned(),
            });
        }
        previous_id = Some(entry.receipt_id.as_str());
    }
    Ok(())
}

fn parse_receipt_contents(
    contents: &str,
    path: &Path,
    expected_id: &str,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<Receipt, ReceiptStoreError> {
    let receipt = parse_receipt_contents_without_proof(contents, path, expected_id)?;
    verify_stored_receipt_proof(path, &receipt, signature_policy)?;
    Ok(receipt)
}

fn parse_receipt_contents_without_proof(
    contents: &str,
    path: &Path,
    expected_id: &str,
) -> Result<Receipt, ReceiptStoreError> {
    let probe = serde_json::from_str::<ReceiptSchemaProbe>(contents).map_err(|source| {
        ReceiptStoreError::MalformedJson {
            path: path.to_path_buf(),
            message: source.to_string(),
        }
    })?;
    let schema = probe.schema.as_deref().unwrap_or("<missing>");
    if schema != RECEIPT_SCHEMA {
        return Err(ReceiptStoreError::WrongSchema {
            path: path.to_path_buf(),
            schema: schema.to_owned(),
        });
    }
    let receipt = serde_json::from_str::<Receipt>(contents).map_err(|source| {
        ReceiptStoreError::MalformedReceipt {
            path: path.to_path_buf(),
            message: source.to_string(),
        }
    })?;
    if receipt.id != expected_id {
        return Err(ReceiptStoreError::IdFilenameMismatch {
            path: path.to_path_buf(),
            receipt_id: receipt.id.into_string(),
            file_stem: expected_id.to_owned(),
        });
    }
    Ok(receipt)
}

#[derive(Debug, Deserialize)]
struct ReceiptSchemaProbe {
    schema: Option<String>,
}

fn verify_stored_receipt_proof(
    path: &Path,
    receipt: &Receipt,
    signature_policy: RuntimeReceiptSignaturePolicy<'_>,
) -> Result<(), ReceiptStoreError> {
    let expected_id = content_addressed_receipt_id(receipt).map_err(|error| {
        ReceiptStoreError::ReceiptProofInvalid {
            path: path.to_path_buf(),
            receipt_id: receipt.id.to_string(),
            message: format!("receipt content address could not be recomputed: {error}"),
        }
    })?;
    if receipt.id != expected_id {
        return Err(ReceiptStoreError::ReceiptProofInvalid {
            path: path.to_path_buf(),
            receipt_id: receipt.id.to_string(),
            message: format!(
                "receipt id must match content address: expected {expected_id}, got {}",
                receipt.id
            ),
        });
    }
    let proof_contexts = RuntimeReceiptProofContextProvider::new(signature_policy);
    let context = proof_contexts.proof_context(receipt);
    let verification = verify_receipt_proof(receipt, &context);
    if verification.valid {
        Ok(())
    } else {
        Err(ReceiptStoreError::ReceiptProofInvalid {
            path: path.to_path_buf(),
            receipt_id: receipt.id.to_string(),
            message: format!("{:?}", verification.findings),
        })
    }
}

fn write_atomic(dir: &Path, file_name: &str, contents: &[u8]) -> Result<(), ReceiptStoreError> {
    write_atomic_with(dir, file_name, contents, true)
}

fn write_atomic_cache(
    dir: &Path,
    file_name: &str,
    contents: &[u8],
) -> Result<(), ReceiptStoreError> {
    write_atomic_with(dir, file_name, contents, false)
}

fn write_atomic_with(
    dir: &Path,
    file_name: &str,
    contents: &[u8],
    durable: bool,
) -> Result<(), ReceiptStoreError> {
    let temp_name = temp_file_name(file_name);
    let temp_path = dir.join(&temp_name);
    let final_path = dir.join(file_name);
    let write_result = write_temp_file(&temp_path, contents, durable)
        .and_then(|()| fs::rename(&temp_path, &final_path))
        .and_then(|()| if durable { sync_directory(dir) } else { Ok(()) });
    if let Err(source) = write_result {
        let _ignored = fs::remove_file(&temp_path);
        return Err(ReceiptStoreError::StoreUnreadable {
            path: final_path,
            source,
        });
    }
    Ok(())
}

fn write_temp_file(path: &Path, contents: &[u8], durable: bool) -> Result<(), std::io::Error> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents)?;
    file.flush()?;
    if durable {
        file.sync_all()?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), std::io::Error> {
    // On Windows, opening a directory handle and calling sync_all fails with
    // ERROR_ACCESS_DENIED (os error 5). Receipt bytes are already durable via
    // file.sync_all() in write_temp_file; skip directory fsync on Windows.
    #[cfg(windows)]
    {
        let _ = path;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        File::open(path)?.sync_all()
    }
}

fn temp_file_name(file_name: &str) -> String {
    format!(".{file_name}.tmp.{}-{}", std::process::id(), unix_nanos())
}

fn generated_at_nanos() -> String {
    unix_nanos().to_string()
}

fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos())
}

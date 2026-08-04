use std::collections::BTreeMap;
use std::path::Path;

use runx_contracts::Receipt;

use super::receipts::production_receipt_verifier;
use crate::receipts::paths::{ReceiptPathInputs, RuntimeReceiptConfig, resolve_receipt_path};
use crate::{
    Ed25519ReceiptVerifier, LocalReceiptStore, ReceiptStoreError, RuntimeError,
    RuntimeReceiptSignaturePolicy,
};

/// Exact, proof-verifying access to the receipt store selected by the current
/// workspace. Consumers receive receipts only after content-address, signature,
/// and schema verification under the same policy as the native receipt tools.
pub struct VerifiedReceiptStore {
    store: LocalReceiptStore,
    verifier: Option<Ed25519ReceiptVerifier>,
}

impl VerifiedReceiptStore {
    pub fn resolve(env: &BTreeMap<String, String>, cwd: &Path) -> Result<Self, RuntimeError> {
        let verifier = production_receipt_verifier(env)?;
        let resolved = resolve_receipt_path(ReceiptPathInputs {
            explicit_dir: None,
            runtime_config: Some(&RuntimeReceiptConfig::default()),
            env,
            cwd,
        });
        Ok(Self {
            store: LocalReceiptStore::new(resolved.path),
            verifier,
        })
    }

    pub fn read_exact(&self, receipt_id: &str) -> Result<Receipt, ReceiptStoreError> {
        self.store
            .read_exact_with_policy(receipt_id, self.signature_policy())
    }

    pub fn list(&self) -> Result<Vec<Receipt>, ReceiptStoreError> {
        self.store.list_with_policy(self.signature_policy())
    }

    pub(crate) fn write_all<'a>(
        &self,
        receipts: impl IntoIterator<Item = &'a Receipt>,
    ) -> Result<(), ReceiptStoreError> {
        self.store
            .write_receipts_with_policy(receipts, self.signature_policy())
    }

    fn signature_policy(&self) -> RuntimeReceiptSignaturePolicy<'_> {
        self.verifier.as_ref().map_or_else(
            RuntimeReceiptSignaturePolicy::local_development,
            |verifier| RuntimeReceiptSignaturePolicy::production(verifier),
        )
    }
}

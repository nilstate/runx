//! Receipts cluster.
//!
//! - `seal`: step and graph receipt sealing helpers.
//! - `store`: the local on-disk receipt store and index.
//! - `tree`: receipt-tree resolution and proof validation.
//! - `paths`: workspace and receipt-store path resolution.

pub(crate) mod issuer;
pub mod paths;
pub mod seal;
pub mod signing;
pub mod store;
pub mod tree;

pub(crate) use issuer::local_runtime_issuer;
pub(crate) use seal::{
    DomainActFrame, GraphClosure, RuntimeReceiptProofContextProvider, StepReceiptWithDisposition,
    StepReceiptWithProjectionAuthority, domain_act_receipt,
    graph_receipt_with_disposition_and_policy,
    graph_receipt_with_effects_and_signature_policy, step_receipt_with_disposition_and_policy,
    step_receipt_with_disposition_projection_and_policy,
    step_receipt_with_projection_and_signature_policy,
    step_receipt_with_projection_authority_and_signature_policy,
};
pub use seal::{
    RuntimeReceiptSignaturePolicy, graph_receipt, graph_receipt_with_signature_policy,
    step_receipt, step_receipt_with_authority_grant_refs, step_receipt_with_signature_policy,
};
pub use signing::{
    Ed25519ReceiptSigner, Ed25519ReceiptVerifier, ProductionReceiptKey,
    RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV, RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV,
    RUNX_RECEIPT_SIGN_KID_ENV, RuntimeReceiptSignatureConfig, RuntimeReceiptSigner,
    RuntimeReceiptSigningError,
};

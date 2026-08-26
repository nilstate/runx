use serde::{Deserialize, Serialize};

use runx_contracts::ExternalReceiptVerification;

use crate::{
    CapabilityApproval, CapabilityArtifacts, CapabilityContract, CapabilityDefinition,
    CapabilityEffect, CapabilityField, CapabilityInput, CapabilityOutput, TypedCapability,
};

use super::EXTERNAL_RECEIPT_VERIFY_TOOL;

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ExternalReceiptVerifyInput {
    pub receipt_path: String,
    pub target: String,
    pub contract_digest: String,
    #[serde(default = "default_repo_root")]
    pub repo_root: String,
}

impl CapabilityInput for ExternalReceiptVerifyInput {
    fn defaults() -> runx_contracts::JsonObject {
        runx_contracts::JsonObject::from([(
            "repo_root".to_owned(),
            runx_contracts::JsonValue::String(default_repo_root()),
        )])
    }
}

fn default_repo_root() -> String {
    ".".to_owned()
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ExternalReceiptVerifyOutput {
    pub external_receipt_verification: ExternalReceiptVerification,
}

impl CapabilityOutput for ExternalReceiptVerifyOutput {}

const FIELDS: &[CapabilityField] = &[
    CapabilityField {
        name: "receipt_path",
        description: "Workspace-scoped path to the external signed accountability receipt.",
    },
    CapabilityField {
        name: "target",
        description: "Exact Git commit or bounded commit-ish the receipt must bind.",
    },
    CapabilityField {
        name: "contract_digest",
        description: "Exact sha256 contract fingerprint expected in the verified receipt.",
    },
    CapabilityField {
        name: "repo_root",
        description: "Repository root used by the canonical external verifier.",
    },
];

static VERIFY: TypedCapability<ExternalReceiptVerifyInput> = TypedCapability::new(
    CapabilityDefinition {
        id: EXTERNAL_RECEIPT_VERIFY_TOOL,
        owner: "runx-runtime/external-receipt",
        summary: "Verify an external signed accountability receipt with its canonical verifier and bind it to an exact target and contract.",
        scopes: &["receipt.read"],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Named {
            output: "external_receipt_verification",
            packet: "runx.external_receipt.verification.v1",
        },
        fields: FIELDS,
    },
);

pub(super) const CAPABILITIES: &[&dyn CapabilityContract] = &[&VERIFY];

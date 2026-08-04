use runx_contracts::JsonObject;
use serde::{Deserialize, Serialize};

use crate::CapabilityOutput;

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct AttestationOutput {
    attestation: Attestation,
}

impl CapabilityOutput for AttestationOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct Attestation {
    schema: String,
    decision: String,
    action: String,
    claim: String,
    principal: String,
    evidence_refs: Vec<EvidenceReference>,
    scope: JsonObject,
    attestation_digest: String,
    gaps: Vec<Finding>,
    proof_boundary: ProofBoundary,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct EvidenceReference {
    #[serde(rename = "ref")]
    reference: String,
    digest: String,
    proves: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct Finding {
    code: String,
    message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct ProofBoundary {
    external_action_verified: bool,
    provider_status: String,
    external_ledger_status: String,
    runtime_seal_status: String,
}

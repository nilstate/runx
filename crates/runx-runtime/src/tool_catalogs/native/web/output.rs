use serde::{Deserialize, Serialize};

use crate::CapabilityOutput;

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct WebFetchOutput {
    fetch_result: FetchResult,
}

impl CapabilityOutput for WebFetchOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct FetchResult {
    decision: String,
    final_url: String,
    status: u64,
    content_digest: String,
    extract_mode: String,
    extracted: ExtractedContent,
    provenance: Provenance,
    policy: FetchPolicy,
    blockers: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(untagged)]
enum ExtractedContent {
    Text(String),
    Metadata(Metadata),
    Links(Vec<String>),
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct Metadata {
    title: Option<String>,
    description: Option<String>,
    canonical: Option<String>,
    declared_language: Option<String>,
    content_type: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct Provenance {
    fetched_at: String,
    redirects: Vec<Redirect>,
    bytes: u64,
    truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct Redirect {
    status: u64,
    from: String,
    to: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct FetchPolicy {
    allowlist_decision: String,
    attempted_host: String,
    allowlist_checked: Vec<String>,
}

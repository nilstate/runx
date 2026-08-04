use std::collections::BTreeMap;

use runx_contracts::JsonValue;
use serde::{Deserialize, Serialize};

use crate::CapabilityOutput;

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct HttpBatchOutput {
    http_execution: HttpExecution,
}

impl CapabilityOutput for HttpBatchOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct HttpExecution {
    schema: String,
    decision: String,
    responses: Vec<HttpResponse>,
    request_count: u64,
    stopped: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(untagged)]
enum HttpResponse {
    Paginated(PaginatedResponse),
    Standard(StandardResponse),
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct StandardResponse {
    id: String,
    performed: bool,
    status: u64,
    ok: bool,
    json: JsonValue,
    body: String,
    body_digest: String,
    body_bytes: u64,
    truncated: bool,
    headers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skip_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
struct PaginatedResponse {
    id: String,
    performed: bool,
    status: u64,
    ok: bool,
    json: JsonValue,
    body: String,
    body_digest: String,
    body_bytes: u64,
    truncated: bool,
    headers: BTreeMap<String, String>,
    page_count: u64,
    pages: Vec<StandardResponse>,
    item_count: u64,
    next_cursor: Option<String>,
}

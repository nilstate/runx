use runx_contracts::{JsonNumber, JsonObject, JsonValue};
use serde::{Deserialize, Serialize};

use crate::{
    CapabilityAdmission, CapabilityApproval, CapabilityArtifacts, CapabilityDefinition,
    CapabilityEffect, CapabilityField, CapabilityInput,
};

use super::super::capability::{NativeCapability, TypedNativeCapability};
use super::output::WebFetchOutput;

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct WebFetchInput {
    pub(super) url: String,
    pub(super) allowlist: Vec<String>,
    pub(super) extract: String,
    pub(super) max_bytes: u64,
}

impl CapabilityInput for WebFetchInput {
    fn defaults() -> JsonObject {
        JsonObject::from([
            ("url".to_owned(), JsonValue::String(String::new())),
            ("allowlist".to_owned(), JsonValue::Array(Vec::new())),
            ("extract".to_owned(), JsonValue::String("text".to_owned())),
            (
                "max_bytes".to_owned(),
                JsonValue::Number(JsonNumber::U64(1_000_000)),
            ),
        ])
    }
}

const FIELDS: &[CapabilityField] = &[
    CapabilityField {
        name: "url",
        description: "Single public HTTP(S) URL to fetch.",
    },
    CapabilityField {
        name: "allowlist",
        description: "Exact or leading-wildcard hosts admitted at every redirect hop.",
    },
    CapabilityField {
        name: "extract",
        description: "Extraction mode: text, metadata, or links.",
    },
    CapabilityField {
        name: "max_bytes",
        description: "Positive decoded response-body cap up to eight MiB.",
    },
];

static FETCH: TypedNativeCapability<WebFetchInput, WebFetchOutput> = TypedNativeCapability::new(
    CapabilityDefinition {
        id: "web.fetch",
        owner: "runx-runtime/web",
        summary: "Fetch and extract one allowlisted public web source through native transport.",
        scopes: &["net:allowlist"],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Named {
            output: "fetch_result",
            packet: "runx.fetch.v1",
        },
        admission: CapabilityAdmission::ReusedBy(&["research", "deep-research"]),
        fields: FIELDS,
    },
    super::fetch,
);

pub(in crate::tool_catalogs::native) const CAPABILITIES: &[&dyn NativeCapability] = &[&FETCH];

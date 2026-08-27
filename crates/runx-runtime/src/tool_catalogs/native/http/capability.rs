use runx_contracts::{JsonObject, JsonValue};
use serde::{Deserialize, Serialize};

use crate::{
    CapabilityApproval, CapabilityArtifacts, CapabilityDefinition, CapabilityEffect,
    CapabilityField, CapabilityInput,
};

use super::super::capability::{NativeCapability, TypedNativeCapability};
use super::output::HttpBatchOutput;

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct HttpBatchInput {
    pub(super) requests: Vec<JsonValue>,
    pub(super) allowed_hosts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) auth: Option<JsonObject>,
    pub(super) stop_on_error: bool,
}

impl CapabilityInput for HttpBatchInput {
    fn defaults() -> JsonObject {
        JsonObject::from([("stop_on_error".to_owned(), JsonValue::Bool(true))])
    }
}

const FIELDS: &[CapabilityField] = &[
    CapabilityField {
        name: "requests",
        description: "One to fifty typed request records.",
    },
    CapabilityField {
        name: "allowed_hosts",
        description: "Exact public hosts the batch may contact.",
    },
    CapabilityField {
        name: "auth",
        description: "Optional bearer or OAuth1 binding to delivered credential material.",
    },
    CapabilityField {
        name: "stop_on_error",
        description: "Stop before the next request after a non-success response.",
    },
];

static READ: TypedNativeCapability<HttpBatchInput, HttpBatchOutput> = TypedNativeCapability::new(
    CapabilityDefinition {
        id: "http.read",
        owner: "runx-runtime/http",
        summary: "Execute a bounded allowlisted GET batch through the governed native transport.",
        scopes: &["net:http"],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Named {
            output: "http_execution",
            packet: "runx.http.execution.v1",
        },
        fields: FIELDS,
    },
    super::read,
);

static QUERY: TypedNativeCapability<HttpBatchInput, HttpBatchOutput> = TypedNativeCapability::new(
    CapabilityDefinition {
        id: "http.query",
        owner: "runx-runtime/http",
        summary: "Execute a bounded allowlisted semantically read-only JSON POST batch.",
        scopes: &["net:http"],
        effect: CapabilityEffect::Read,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Named {
            output: "http_execution",
            packet: "runx.http.execution.v1",
        },
        fields: FIELDS,
    },
    super::query,
);

static EXECUTE: TypedNativeCapability<HttpBatchInput, HttpBatchOutput> = TypedNativeCapability::new(
    CapabilityDefinition {
        id: "http.execute",
        owner: "runx-runtime/http",
        summary: "Execute a bounded allowlisted HTTP mutation batch through the governed transport.",
        scopes: &["net:http"],
        effect: CapabilityEffect::Mutate,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Named {
            output: "http_execution",
            packet: "runx.http.execution.v1",
        },
        fields: FIELDS,
    },
    super::execute,
);

pub(in crate::tool_catalogs::native) const CAPABILITIES: &[&dyn NativeCapability] =
    &[&READ, &QUERY, &EXECUTE];

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use crate::{CapabilityContract, CapabilityEffect};

    use super::{EXECUTE, QUERY, READ};

    #[test]
    fn native_http_capabilities_share_one_typed_input_and_declare_effects() {
        let read_schema = READ.input_schema().expect("http.read schema");
        assert_eq!(
            read_schema,
            QUERY.input_schema().expect("http.query schema")
        );
        assert_eq!(
            read_schema,
            EXECUTE.input_schema().expect("http.execute schema")
        );
        assert_eq!(READ.definition().effect, CapabilityEffect::Read);
        assert_eq!(QUERY.definition().effect, CapabilityEffect::Read);
        assert_eq!(EXECUTE.definition().effect, CapabilityEffect::Mutate);
    }
}

//! Typed event-store capabilities. The public operation contract lives here;
//! storage selection remains a runtime-owned binding decision.

use runx_contracts::{DataOperationResult, JsonObject, JsonValue};

use crate::{
    CapabilityApproval, CapabilityArtifacts, CapabilityDefinition, CapabilityEffect,
    CapabilityField, RuntimeError,
};

use super::capability::{NativeCapability, TypedNativeCapability, decode_typed_output};
use super::{NativeInvocation, invalid_input};

mod input;
mod migration;
mod model;
#[cfg(feature = "catalog")]
mod prepare;
#[cfg(feature = "catalog")]
mod result;
mod sqlite;

use input::{AppendInput, ListHeadsInput, ReadEventsInput, ReadProjectionInput};
pub use migration::{
    EventStoreMigrationProof, EventStoreMigrationRequest, EventStoreMigrationStatus,
    migrate_event_store,
};
#[cfg(feature = "catalog")]
pub(crate) use prepare::{PreparedOperation, prepare_operation};

pub(crate) const APPEND_TOOL: &str = "data.append_event";
pub(crate) const READ_EVENTS_TOOL: &str = "data.read_events";
pub(crate) const READ_PROJECTION_TOOL: &str = "data.read_projection";
pub(crate) const LIST_HEADS_TOOL: &str = "data.list_stream_heads";
#[cfg(feature = "catalog")]
pub(crate) const MAX_DATA_OPERATION_RESULT_BYTES: usize = 16 * 1024 * 1024;

#[cfg(feature = "catalog")]
pub(crate) fn operation_name(tool_ref: &str) -> Option<&'static str> {
    match tool_ref {
        APPEND_TOOL => Some("append_event"),
        READ_EVENTS_TOOL => Some("read_events"),
        READ_PROJECTION_TOOL => Some("read_projection"),
        LIST_HEADS_TOOL => Some("list_stream_heads"),
        _ => None,
    }
}

#[cfg(feature = "catalog")]
pub(crate) fn native_adapter(adapter: &str) -> bool {
    adapter == "data.sqlite"
}

const APPEND_FIELDS: &[CapabilityField] = &[
    field(
        "data_source_ref",
        "Stable logical data-source reference resolved by runtime configuration.",
    ),
    field("resource", "Declared event resource or stream family."),
    field("aggregate_id", "Event stream or partition identifier."),
    field(
        "expected_version",
        "Exact current stream version required before append, within the portable JSON integer range.",
    ),
    field(
        "idempotency_key",
        "Stable retry identity for this exact event.",
    ),
    field("event", "Domain event object to append."),
    field("observed_at", "Optional RFC 3339 event observation time."),
];

const READ_EVENTS_FIELDS: &[CapabilityField] = &[
    field(
        "data_source_ref",
        "Stable logical data-source reference resolved by runtime configuration.",
    ),
    field("resource", "Declared event resource or stream family."),
    field("aggregate_id", "Event stream or partition identifier."),
    field("limit", "Maximum events returned, from one to 500."),
    field(
        "after_version",
        "Optional exclusive version cursor for ascending reads, within the portable JSON integer range.",
    ),
];

const READ_PROJECTION_FIELDS: &[CapabilityField] = &[
    field(
        "data_source_ref",
        "Stable logical data-source reference resolved by runtime configuration.",
    ),
    field("resource", "Declared event resource or projection family."),
    field("aggregate_id", "Event stream or partition identifier."),
];

const LIST_HEADS_FIELDS: &[CapabilityField] = &[
    field(
        "data_source_ref",
        "Stable logical data-source reference resolved by runtime configuration.",
    ),
    field(
        "resource",
        "Declared event resource whose latest stream events are listed.",
    ),
    field(
        "event_types",
        "Up to twenty exact latest event types to include.",
    ),
    field("limit", "Maximum stream heads returned, from one to 100."),
    field(
        "cursor",
        "Optional opaque keyset cursor returned by the prior page.",
    ),
];

const fn field(name: &'static str, description: &'static str) -> CapabilityField {
    CapabilityField { name, description }
}

static APPEND: TypedNativeCapability<AppendInput, DataOperationResult> = TypedNativeCapability::new(
    definition(
        APPEND_TOOL,
        "Append one event under optimistic concurrency and idempotency.",
        &["runx:data:append"],
        CapabilityEffect::Mutate,
        APPEND_FIELDS,
    ),
    append,
);

static READ_EVENTS: TypedNativeCapability<ReadEventsInput, DataOperationResult> =
    TypedNativeCapability::new(
        definition(
            READ_EVENTS_TOOL,
            "Read one bounded event-stream page from a configured data source.",
            &["runx:data:read"],
            CapabilityEffect::Read,
            READ_EVENTS_FIELDS,
        ),
        read_events,
    );

static READ_PROJECTION: TypedNativeCapability<ReadProjectionInput, DataOperationResult> =
    TypedNativeCapability::new(
        definition(
            READ_PROJECTION_TOOL,
            "Read the canonical metadata projection for one event stream.",
            &["runx:data:read"],
            CapabilityEffect::Read,
            READ_PROJECTION_FIELDS,
        ),
        read_projection,
    );

static LIST_HEADS: TypedNativeCapability<ListHeadsInput, DataOperationResult> =
    TypedNativeCapability::new(
        definition(
            LIST_HEADS_TOOL,
            "List a bounded keyset page of latest event-stream heads.",
            &["runx:data:read"],
            CapabilityEffect::Read,
            LIST_HEADS_FIELDS,
        ),
        list_heads,
    );

const fn definition(
    id: &'static str,
    summary: &'static str,
    scopes: &'static [&'static str],
    effect: CapabilityEffect,
    fields: &'static [CapabilityField],
) -> CapabilityDefinition {
    CapabilityDefinition {
        id,
        owner: "runx-runtime/event-store",
        summary,
        scopes,
        effect,
        approval: CapabilityApproval::None,
        artifacts: CapabilityArtifacts::Wrapped {
            output: "data_operation_result",
            packet: "runx.data.operation_result.v1",
        },
        fields,
    }
}

pub(in crate::tool_catalogs::native) const CAPABILITIES: &[&dyn NativeCapability] =
    &[&APPEND, &READ_EVENTS, &READ_PROJECTION, &LIST_HEADS];

fn append(
    invocation: &NativeInvocation<'_, AppendInput>,
) -> Result<DataOperationResult, RuntimeError> {
    let binding = resolved_binding(APPEND_TOOL, invocation.data_source_binding)?;
    let request = invocation.inputs.validate()?;
    decode_typed_output(APPEND_TOOL, sqlite::append(invocation, binding, request)?)
}

fn read_events(
    invocation: &NativeInvocation<'_, ReadEventsInput>,
) -> Result<DataOperationResult, RuntimeError> {
    let binding = resolved_binding(READ_EVENTS_TOOL, invocation.data_source_binding)?;
    let request = invocation.inputs.validate()?;
    decode_typed_output(
        READ_EVENTS_TOOL,
        sqlite::read_events(invocation, binding, request)?,
    )
}

fn read_projection(
    invocation: &NativeInvocation<'_, ReadProjectionInput>,
) -> Result<DataOperationResult, RuntimeError> {
    let binding = resolved_binding(READ_PROJECTION_TOOL, invocation.data_source_binding)?;
    let request = invocation.inputs.validate()?;
    decode_typed_output(
        READ_PROJECTION_TOOL,
        sqlite::read_projection(invocation, binding, request)?,
    )
}

fn list_heads(
    invocation: &NativeInvocation<'_, ListHeadsInput>,
) -> Result<DataOperationResult, RuntimeError> {
    let binding = resolved_binding(LIST_HEADS_TOOL, invocation.data_source_binding)?;
    let request = invocation.inputs.validate()?;
    decode_typed_output(
        LIST_HEADS_TOOL,
        sqlite::list_heads(invocation, binding, request)?,
    )
}

fn resolved_binding<'a>(
    tool: &str,
    binding: Option<&'a JsonObject>,
) -> Result<&'a JsonObject, RuntimeError> {
    let binding = binding
        .ok_or_else(|| invalid_input(tool, "runtime did not resolve the requested data source"))?;
    match binding.get("adapter").and_then(JsonValue::as_str) {
        Some("data.sqlite") => Ok(binding),
        Some(adapter) => Err(invalid_input(
            tool,
            format!("adapter {adapter:?} was not routed to its external provider implementation"),
        )),
        None => Err(invalid_input(
            tool,
            "resolved data-source binding is missing adapter",
        )),
    }
}

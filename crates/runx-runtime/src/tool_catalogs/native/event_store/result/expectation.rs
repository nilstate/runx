use std::collections::BTreeSet;

use super::super::{
    APPEND_TOOL, LIST_HEADS_TOOL, READ_EVENTS_TOOL, READ_PROJECTION_TOOL, input::SourceIdentity,
};

pub(in crate::tool_catalogs::native::event_store) struct Expectation {
    tool_ref: &'static str,
    operation: &'static str,
    pub(super) data_source_ref: String,
    pub(super) resource: String,
    pub(super) aggregate_id: String,
    pub(super) limit: usize,
    pub(super) after_version: Option<u64>,
    expected_version: Option<u64>,
    idempotency_key: Option<String>,
    event_digest: Option<String>,
    pub(super) event_types: BTreeSet<String>,
}

impl Expectation {
    pub(in crate::tool_catalogs::native::event_store) fn append(
        source: SourceIdentity<'_>,
        expected_version: u64,
        idempotency_key: &str,
        event_digest: String,
    ) -> Self {
        Self {
            tool_ref: APPEND_TOOL,
            operation: "append_event",
            data_source_ref: source.data_source_ref.to_owned(),
            resource: source.resource.to_owned(),
            aggregate_id: source.aggregate_id.to_owned(),
            limit: 0,
            after_version: None,
            expected_version: Some(expected_version),
            idempotency_key: Some(idempotency_key.to_owned()),
            event_digest: Some(event_digest),
            event_types: BTreeSet::new(),
        }
    }

    pub(in crate::tool_catalogs::native::event_store) fn read_events(
        source: SourceIdentity<'_>,
        limit: usize,
        after_version: Option<u64>,
    ) -> Self {
        Self::read(READ_EVENTS_TOOL, source, limit, after_version)
    }

    pub(in crate::tool_catalogs::native::event_store) fn read_projection(
        source: SourceIdentity<'_>,
    ) -> Self {
        Self::read(READ_PROJECTION_TOOL, source, 0, None)
    }

    pub(in crate::tool_catalogs::native::event_store) fn list_heads(
        data_source_ref: &str,
        resource: &str,
        event_types: Vec<&str>,
        limit: usize,
    ) -> Self {
        Self {
            tool_ref: LIST_HEADS_TOOL,
            operation: "list_stream_heads",
            data_source_ref: data_source_ref.to_owned(),
            resource: resource.to_owned(),
            aggregate_id: "stream-heads".to_owned(),
            limit,
            after_version: None,
            expected_version: None,
            idempotency_key: None,
            event_digest: None,
            event_types: event_types.into_iter().map(str::to_owned).collect(),
        }
    }

    fn read(
        tool_ref: &'static str,
        source: SourceIdentity<'_>,
        limit: usize,
        after_version: Option<u64>,
    ) -> Self {
        Self {
            tool_ref,
            operation: if tool_ref == READ_EVENTS_TOOL {
                "read_events"
            } else {
                "read_projection"
            },
            data_source_ref: source.data_source_ref.to_owned(),
            resource: source.resource.to_owned(),
            aggregate_id: source.aggregate_id.to_owned(),
            limit,
            after_version,
            expected_version: None,
            idempotency_key: None,
            event_digest: None,
            event_types: BTreeSet::new(),
        }
    }

    pub(in crate::tool_catalogs::native::event_store) fn tool_ref(&self) -> &'static str {
        self.tool_ref
    }

    pub(super) fn operation(&self) -> &'static str {
        self.operation
    }

    pub(super) fn expected_version(&self) -> Option<u64> {
        self.expected_version
    }

    pub(super) fn idempotency_key(&self) -> Option<&str> {
        self.idempotency_key.as_deref()
    }

    pub(super) fn event_digest(&self) -> Option<&str> {
        self.event_digest.as_deref()
    }
}

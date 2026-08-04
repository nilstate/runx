//! Pure parsing for Runx packet-schema documents.
//!
//! Filesystem discovery and catalog policy belong to the runtime. This module
//! owns the document contract so listing, execution, and publication cannot
//! disagree about packet identity or digests.

use runx_contracts::{JsonValue, sha256_prefixed};
use thiserror::Error;

pub const PACKET_ID_FIELD: &str = "x-runx-packet-id";

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedPacketSchema {
    pub packet_id: String,
    pub value: JsonValue,
    pub sha256: String,
}

#[derive(Debug, Error)]
pub enum PacketSchemaError {
    #[error("{path}: packet schema is not valid JSON: {source}")]
    InvalidJson {
        path: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("{path}: {PACKET_ID_FIELD} must be a non-empty string")]
    InvalidPacketId { path: String },
}

/// Parse one JSON document as a Runx packet schema.
///
/// JSON without `x-runx-packet-id` is not a packet schema and returns `None`.
/// Once the field is present it is strict: wrong types and empty identifiers
/// are rejected rather than silently creating divergent identities.
pub fn parse_packet_schema_document(
    path: impl Into<String>,
    source: &str,
) -> Result<Option<ValidatedPacketSchema>, PacketSchemaError> {
    let path = path.into();
    let value = serde_json::from_str::<JsonValue>(source).map_err(|source| {
        PacketSchemaError::InvalidJson {
            path: path.clone(),
            source,
        }
    })?;
    let Some(raw_packet_id) = value
        .as_object()
        .and_then(|object| object.get(PACKET_ID_FIELD))
    else {
        return Ok(None);
    };
    let packet_id = raw_packet_id
        .as_str()
        .filter(|packet_id| !packet_id.trim().is_empty())
        .ok_or(PacketSchemaError::InvalidPacketId { path })?;
    Ok(Some(ValidatedPacketSchema {
        packet_id: packet_id.to_owned(),
        value,
        sha256: sha256_prefixed(source.as_bytes()),
    }))
}

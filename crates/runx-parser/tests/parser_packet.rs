use runx_parser::{PacketSchemaError, parse_packet_schema_document};

#[test]
fn packet_schema_parser_owns_identity_and_source_digest() -> Result<(), PacketSchemaError> {
    let source = r#"{"x-runx-packet-id":"runx.test.plan.v1","type":"object"}"#;
    let schema = parse_packet_schema_document("plan.schema.json", source)?.ok_or_else(|| {
        PacketSchemaError::InvalidPacketId {
            path: "plan.schema.json".to_owned(),
        }
    })?;

    assert_eq!(schema.packet_id, "runx.test.plan.v1");
    assert!(schema.sha256.starts_with("sha256:"));
    Ok(())
}

#[test]
fn json_without_packet_identity_is_not_a_packet_schema() -> Result<(), PacketSchemaError> {
    assert!(parse_packet_schema_document("plain.json", r#"{"type":"object"}"#)?.is_none());
    Ok(())
}

#[test]
fn present_packet_identity_must_be_a_non_empty_string() {
    for source in [
        r#"{"x-runx-packet-id":""}"#,
        r#"{"x-runx-packet-id":"   "}"#,
        r#"{"x-runx-packet-id":42}"#,
    ] {
        assert!(matches!(
            parse_packet_schema_document("invalid.json", source),
            Err(PacketSchemaError::InvalidPacketId { .. })
        ));
    }
}

use crate::ReceiptError;
use runx_contracts::{Receipt, sha256_prefixed, write_canonical_json_fragment};
use serde::Serialize;

pub fn canonical_receipt_json(receipt: &Receipt) -> Result<String, ReceiptError> {
    let value = receipt_value(receipt)?;
    canonical_receipt_value(&value)
}

pub fn canonical_receipt_digest(receipt: &Receipt) -> Result<String, ReceiptError> {
    canonical_receipt_json(receipt).map(|json| sha256_prefixed(json.as_bytes()))
}

pub fn canonical_receipt_body_json(receipt: &Receipt) -> Result<String, ReceiptError> {
    let mut value = receipt_value(receipt)?;
    strip_body_proof_fields(&mut value);
    canonical_receipt_value(&value)
}

pub fn canonical_receipt_body_digest(receipt: &Receipt) -> Result<String, ReceiptError> {
    canonical_receipt_body_json(receipt).map(|json| sha256_prefixed(json.as_bytes()))
}

/// The canonical body that the content-addressed `id` commits: every intrinsic
/// run field except the envelope's `id` (which it derives), `signature`,
/// `digest`, the runtime-local `metadata` read aid, and `lineage`. `lineage` is
/// post-hoc graph wiring (parent/children refs) attached after the children's
/// own ids are known; excluding it breaks the parent<->child id circularity
/// while keeping the address stable. The full `digest` still commits `lineage`.
pub fn canonical_receipt_identity_json(receipt: &Receipt) -> Result<String, ReceiptError> {
    let mut value = receipt_value(receipt)?;
    strip_body_proof_fields(&mut value);
    if let serde_json::Value::Object(map) = &mut value {
        map.remove("id");
        map.remove("lineage");
    }
    canonical_receipt_value(&value)
}

/// `id = hash(canonical_body)` under `runx.receipt.c14n.v1`: the content address
/// of this receipt. References to a receipt use this id.
pub fn content_addressed_receipt_id(receipt: &Receipt) -> Result<String, ReceiptError> {
    canonical_receipt_identity_json(receipt).map(|json| sha256_prefixed(json.as_bytes()))
}

fn receipt_value(receipt: &Receipt) -> Result<serde_json::Value, ReceiptError> {
    serde_json::to_value(receipt).map_err(|source| ReceiptError::Serialization {
        message: source.to_string(),
    })
}

/// The signed body commits every flat field except the envelope's own
/// `signature` and `digest`. `metadata` is a runtime-local read aid and is not
/// part of the signed body.
fn strip_body_proof_fields(value: &mut serde_json::Value) {
    if let serde_json::Value::Object(map) = value {
        map.remove("signature");
        map.remove("digest");
        map.remove("metadata");
    }
}

fn canonical_receipt_value(value: &serde_json::Value) -> Result<String, ReceiptError> {
    let mut output = String::new();
    write_canonical_receipt_value(value, &mut output)?;
    Ok(output)
}

/// Receipt structs already serialize into a key-sorted `serde_json::Value`.
/// Writing that tree directly avoids the former serialize-to-text/reparse or
/// second value-tree conversion while preserving the byte-pinned canonical
/// JSON oracle.
fn write_canonical_receipt_value(
    value: &serde_json::Value,
    output: &mut String,
) -> Result<(), ReceiptError> {
    match value {
        serde_json::Value::Null => output.push_str("null"),
        serde_json::Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        serde_json::Value::Number(value) => write_receipt_json_fragment(value, output)?,
        serde_json::Value::String(value) => write_receipt_json_fragment(value, output)?,
        serde_json::Value::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical_receipt_value(item, output)?;
            }
            output.push(']');
        }
        serde_json::Value::Object(map) => {
            output.push('{');
            for (index, (key, value)) in map.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_receipt_json_fragment(key, output)?;
                output.push(':');
                write_canonical_receipt_value(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn write_receipt_json_fragment<T: Serialize + ?Sized>(
    value: &T,
    output: &mut String,
) -> Result<(), ReceiptError> {
    write_canonical_json_fragment(value, output).map_err(|source| ReceiptError::Serialization {
        message: source.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use runx_contracts::{JsonValue, Receipt};
    use serde::Deserialize;

    use super::{
        ReceiptError, canonical_receipt_body_digest, canonical_receipt_body_json,
        canonical_receipt_digest, canonical_receipt_json,
    };

    const SUCCESS_RECEIPT: &str =
        include_str!("../../../fixtures/contracts/harness-spine/receipt-success.json");
    const ABNORMAL_RECEIPT: &str =
        include_str!("../../../fixtures/contracts/harness-spine/receipt-abnormal.json");
    const RECEIPT_ORACLE: &str = include_str!(
        "../../../fixtures/contracts/canonical-json/runx-receipt-c14n-v1.oracles.json"
    );
    #[derive(Debug, Deserialize)]
    struct Fixture {
        expected: Receipt,
    }

    #[derive(Debug, Deserialize)]
    struct ReceiptOracleFixture {
        canonicalization: String,
        cases: Vec<ReceiptOracleCase>,
    }

    #[derive(Debug, Deserialize)]
    struct ReceiptOracleCase {
        name: String,
        fixture: String,
        full_canonical_json: String,
        full_sha256: String,
        body_canonical_json: String,
        body_sha256: String,
    }

    #[test]
    fn canonical_receipt_json_is_stable_and_sorted() -> Result<(), ReceiptError> {
        let receipt = fixture()?;
        let first = canonical_receipt_json(&receipt)?;
        let second = canonical_receipt_json(&receipt)?;

        assert_eq!(first, second);
        assert!(first.contains("\"created_at\":\""));
        assert!(canonical_receipt_digest(&receipt)?.starts_with("sha256:"));
        Ok(())
    }

    #[test]
    fn body_commitment_excludes_signature_and_seal_derived_fields() -> Result<(), ReceiptError> {
        let mut receipt = fixture()?;
        let baseline_json = canonical_receipt_body_json(&receipt)?;
        let baseline_digest = canonical_receipt_body_digest(&receipt)?;

        receipt.signature.value = "base64:changed".into();
        receipt.digest = "sha256:changed".into();

        assert_eq!(canonical_receipt_body_json(&receipt)?, baseline_json);
        assert_eq!(canonical_receipt_body_digest(&receipt)?, baseline_digest);
        Ok(())
    }

    #[test]
    fn body_commitment_excludes_metadata_read_aid() -> Result<(), ReceiptError> {
        let mut receipt = fixture()?;
        let baseline_digest = canonical_receipt_body_digest(&receipt)?;

        receipt.metadata.get_or_insert_default().insert(
            "skill_name".to_owned(),
            JsonValue::String("changed-read-aid".to_owned()),
        );

        assert_eq!(canonical_receipt_body_digest(&receipt)?, baseline_digest);
        Ok(())
    }

    #[test]
    fn receipt_oracle_matches_rust_canonical_json() -> Result<(), ReceiptError> {
        let oracle: ReceiptOracleFixture =
            serde_json::from_str(RECEIPT_ORACLE).map_err(|source| ReceiptError::Serialization {
                message: source.to_string(),
            })?;
        assert_eq!(oracle.canonicalization, "runx.receipt.c14n.v1");

        for case in oracle.cases {
            let receipt = fixture_by_path(&case.fixture)?;
            assert_eq!(
                canonical_receipt_json(&receipt)?,
                case.full_canonical_json,
                "{} full canonical JSON drifted",
                case.name
            );
            assert_eq!(
                canonical_receipt_digest(&receipt)?,
                case.full_sha256,
                "{} full digest drifted",
                case.name
            );
            assert_eq!(
                canonical_receipt_body_json(&receipt)?,
                case.body_canonical_json,
                "{} body canonical JSON drifted",
                case.name
            );
            assert_eq!(
                canonical_receipt_body_digest(&receipt)?,
                case.body_sha256,
                "{} body digest drifted",
                case.name
            );
        }
        Ok(())
    }

    fn fixture() -> Result<Receipt, ReceiptError> {
        serde_json::from_str::<Fixture>(SUCCESS_RECEIPT)
            .map(|fixture| fixture.expected)
            .map_err(|source| ReceiptError::Serialization {
                message: source.to_string(),
            })
    }

    fn fixture_by_path(path: &str) -> Result<Receipt, ReceiptError> {
        let json = match path {
            "harness-spine/receipt-abnormal.json" => ABNORMAL_RECEIPT,
            "harness-spine/receipt-success.json" => SUCCESS_RECEIPT,
            _ => {
                return Err(ReceiptError::Serialization {
                    message: format!("unknown receipt oracle fixture: {path}"),
                });
            }
        };
        serde_json::from_str::<Fixture>(json)
            .map(|fixture| fixture.expected)
            .map_err(|source| ReceiptError::Serialization {
                message: source.to_string(),
            })
    }
}

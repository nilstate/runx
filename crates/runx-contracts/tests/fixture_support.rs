//! Shared helpers for the fixture-parity test modules.

/// Asserts that `expected` (a checked-in wire fixture) deserializes into `T`
/// and serializes back to exactly the same JSON, pinning the cross-language
/// wire shape of the type.
pub(crate) fn roundtrip<T>(expected: serde_json::Value) -> Result<(), serde_json::Error>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let parsed: T = serde_json::from_value(expected.clone())?;
    let actual = serde_json::to_value(parsed)?;
    assert_eq!(actual, expected);
    Ok(())
}

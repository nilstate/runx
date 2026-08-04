#[cfg(feature = "mcp")]
use runx_contracts::JsonNumber;

#[cfg(feature = "mcp")]
pub(crate) fn json_number_string(value: &JsonNumber) -> String {
    match value {
        JsonNumber::I64(value) => value.to_string(),
        JsonNumber::U64(value) => value.to_string(),
        JsonNumber::F64(value) if value.fract() == 0.0 => format!("{value:.0}"),
        JsonNumber::F64(value) => value.to_string(),
    }
}

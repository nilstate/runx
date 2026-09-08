//! Development-only batch driver for cross-language kernel differential tests.
//! It calls the existing evaluator and is excluded from the published crate.

use std::io;

use runx_core::kernel_eval::evaluate_kernel_document_str;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let inputs: Vec<serde_json::Value> = serde_json::from_reader(io::stdin().lock())?;
    let outputs = inputs
        .iter()
        .map(|input| evaluate_kernel_document_str(&input.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    serde_json::to_writer(io::stdout().lock(), &outputs)?;
    Ok(())
}

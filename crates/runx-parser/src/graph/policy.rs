use runx_contracts::JsonValue;

use super::helpers::{
    optional_object, required_array, required_object, required_string, validation_error,
};
use super::types::{GraphGuard, GraphPolicy};
use crate::ValidationError;

pub fn validate_graph_policy(
    value: Option<&JsonValue>,
    field: &str,
) -> Result<Option<GraphPolicy>, ValidationError> {
    let Some(policy) = optional_object(value, field)? else {
        return Ok(None);
    };
    let Some(guards_value) = policy.get("guards") else {
        return Ok(None);
    };
    if matches!(guards_value, JsonValue::Null) {
        return Ok(None);
    }
    let guards = required_array(Some(guards_value), &format!("{field}.guards"))?
        .iter()
        .enumerate()
        .map(|(index, raw_gate)| guard(raw_gate, &format!("{field}.guards.{index}")))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(GraphPolicy { guards }))
}

fn guard(raw_gate: &JsonValue, gate_field: &str) -> Result<GraphGuard, ValidationError> {
    let gate = required_object(Some(raw_gate), gate_field)?;
    let equals = gate.get("equals").cloned();
    let not_equals = gate.get("not_equals").cloned();
    if equals.is_some() && not_equals.is_some() {
        return Err(validation_error(format!(
            "{gate_field} must not declare both equals and not_equals."
        )));
    }
    if equals.is_none() && not_equals.is_none() {
        return Err(validation_error(format!(
            "{gate_field} must declare equals or not_equals."
        )));
    }
    Ok(GraphGuard {
        step: required_string(gate.get("step"), &format!("{gate_field}.step"))?,
        field: required_string(gate.get("field"), &format!("{gate_field}.field"))?,
        equals,
        not_equals,
    })
}

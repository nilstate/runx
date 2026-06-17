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
    // Fail closed on unknown policy fields: `guards` is the only supported key.
    // Silently ignoring others drops gates without warning; a stale `transitions`
    // key (since renamed to `guards`) once disabled every payment gate this way.
    for key in policy.keys() {
        if key.as_str() != "guards" {
            return Err(validation_error(format!(
                "{field} has unknown field '{key}'; only 'guards' is supported."
            )));
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_value(json: &str) -> JsonValue {
        serde_json::from_str(json).expect("valid json")
    }

    #[test]
    fn rejects_unknown_policy_field() {
        // A stale `transitions` key (the pre-rename name) must be rejected, not
        // silently dropped: dropping it would disable the gate it declares.
        let policy = policy_value(
            r#"{"transitions":[{"step":"fulfill","field":"approve-spend.data.approved","equals":true}]}"#,
        );
        let error = validate_graph_policy(Some(&policy), "policy")
            .expect_err("unknown policy field must be rejected");
        assert!(
            error.to_string().contains("transitions"),
            "error should name the unknown field, got: {error}"
        );
    }

    #[test]
    fn accepts_guards_policy() {
        let policy = policy_value(
            r#"{"guards":[{"step":"fulfill","field":"approve-spend.data.approved","equals":true}]}"#,
        );
        let parsed = validate_graph_policy(Some(&policy), "policy")
            .expect("a guards policy must parse")
            .expect("guards present");
        assert_eq!(parsed.guards.len(), 1);
    }
}

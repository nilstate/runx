use std::collections::{BTreeMap, BTreeSet};

use runx_contracts::{JsonObject, JsonValue};
use runx_core::policy::admit_agent_tool_ref;

use super::helpers::{
    number_to_non_negative_integer, number_to_positive_integer, optional_bool,
    optional_non_empty_string, optional_number, optional_object, optional_string,
    optional_string_array, optional_string_object, required_string, validation_error,
};
use super::types::{GraphContextEdge, GraphRetryPolicy, GraphStep};
use crate::ValidationError;

struct StepTarget {
    skill: Option<String>,
    tool: Option<String>,
    run: Option<JsonObject>,
}

pub fn validate_step(
    raw_step: &JsonObject,
    field: &str,
    previous_step_ids: &BTreeSet<String>,
) -> Result<GraphStep, ValidationError> {
    reject_unsupported_step_fields(raw_step, field)?;

    let id = validate_step_id(raw_step, field, previous_step_ids)?;
    let target = validate_step_target(raw_step, field)?;
    let runner = validate_runner(raw_step, field, &target)?;
    let context = optional_string_object(raw_step.get("context"), &format!("{field}.context"))?
        .unwrap_or_default();
    let context_skills = optional_string_array(
        raw_step.get("context_skills"),
        &format!("{field}.context_skills"),
    )?
    .unwrap_or_default();
    validate_context_skills(&context_skills, field, &target)?;

    Ok(GraphStep {
        id,
        label: optional_non_empty_string(raw_step.get("label"), &format!("{field}.label"))?,
        skill: target.skill,
        tool: target.tool,
        run: target.run,
        instructions: optional_string(
            raw_step.get("instructions"),
            &format!("{field}.instructions"),
        )?,
        artifacts: optional_object(raw_step.get("artifacts"), &format!("{field}.artifacts"))?,
        runner,
        inputs: optional_object(raw_step.get("inputs"), &format!("{field}.inputs"))?
            .unwrap_or_default(),
        context_edges: context_edges(&context, previous_step_ids, field)?,
        context,
        context_skills,
        scopes: optional_string_array(raw_step.get("scopes"), &format!("{field}.scopes"))?
            .unwrap_or_default(),
        allowed_tools: validate_allowed_tools(raw_step.get("allowed_tools"), field)?,
        retry: validate_retry(raw_step.get("retry"), &format!("{field}.retry"))?,
        policy: optional_object(raw_step.get("policy"), &format!("{field}.policy"))?,
        fanout_group: optional_string(
            raw_step.get("fanout_group"),
            &format!("{field}.fanout_group"),
        )?,
        mutating: optional_bool(raw_step.get("mutation"), &format!("{field}.mutation"))?
            .unwrap_or(false),
        idempotency_key: optional_non_empty_string(
            raw_step.get("idempotency_key"),
            &format!("{field}.idempotency_key"),
        )?,
    })
}

fn validate_allowed_tools(
    value: Option<&JsonValue>,
    field: &str,
) -> Result<Option<Vec<String>>, ValidationError> {
    let Some(allowed_tools) = optional_string_array(value, &format!("{field}.allowed_tools"))?
    else {
        return Ok(None);
    };
    for tool in &allowed_tools {
        let admission = admit_agent_tool_ref(tool);
        if !admission.allowed {
            return Err(validation_error(format!(
                "{field}.allowed_tools entry {tool:?} is not an admissible agent tool ref: {}.",
                admission.reason
            )));
        }
    }
    Ok(Some(allowed_tools))
}

fn validate_context_skills(
    context_skills: &[String],
    field: &str,
    target: &StepTarget,
) -> Result<(), ValidationError> {
    if context_skills.is_empty() || target.skill.is_some() {
        return Ok(());
    }
    if let Some(run) = &target.run {
        if matches!(run.get("type"), Some(JsonValue::String(value)) if value == "agent-task") {
            return Ok(());
        }
    }
    Err(validation_error(format!(
        "{field}.context_skills is only valid for agent-task steps or nested agent skills."
    )))
}

fn validate_step_id(
    raw_step: &JsonObject,
    field: &str,
    previous_step_ids: &BTreeSet<String>,
) -> Result<String, ValidationError> {
    let id = required_string(raw_step.get("id"), &format!("{field}.id"))?;
    if previous_step_ids.contains(&id) {
        return Err(validation_error(format!(
            "{field}.id '{id}' must be unique."
        )));
    }
    Ok(id)
}

fn validate_step_target(raw_step: &JsonObject, field: &str) -> Result<StepTarget, ValidationError> {
    let target = StepTarget {
        skill: optional_non_empty_string(raw_step.get("skill"), &format!("{field}.skill"))?,
        tool: optional_non_empty_string(raw_step.get("tool"), &format!("{field}.tool"))?,
        run: optional_object(raw_step.get("run"), &format!("{field}.run"))?,
    };
    let target_count = usize::from(target.skill.is_some())
        + usize::from(target.tool.is_some())
        + usize::from(target.run.is_some());
    if target_count != 1 {
        return Err(validation_error(format!(
            "{field} must declare exactly one of skill, tool, or run."
        )));
    }
    validate_run_type(field, &target.run)?;
    Ok(target)
}

fn validate_runner(
    raw_step: &JsonObject,
    field: &str,
    target: &StepTarget,
) -> Result<Option<String>, ValidationError> {
    let runner = optional_non_empty_string(raw_step.get("runner"), &format!("{field}.runner"))?;
    if (target.run.is_some() || target.tool.is_some()) && runner.is_some() {
        return Err(validation_error(format!(
            "{field}.runner is only valid for nested skill steps."
        )));
    }
    Ok(runner)
}

fn validate_run_type(field: &str, run: &Option<JsonObject>) -> Result<(), ValidationError> {
    let Some(run) = run else {
        return Ok(());
    };
    if matches!(run.get("type"), Some(JsonValue::String(_))) {
        return Ok(());
    }
    Err(validation_error(format!("{field}.run.type is required.")))
}

fn reject_unsupported_step_fields(
    raw_step: &JsonObject,
    field: &str,
) -> Result<(), ValidationError> {
    if raw_step.contains_key("sync") {
        return Err(validation_error(format!(
            "{field}.sync is not supported by the local sequential graph runner."
        )));
    }
    if raw_step.contains_key("stage") {
        return Err(validation_error(format!(
            "{field}.stage is not supported by the local sequential graph runner."
        )));
    }
    validate_mode(raw_step, field)?;
    if ["run", "skill", "tool"]
        .into_iter()
        .filter(|key| raw_step.contains_key(*key))
        .count()
        > 1
    {
        return Err(validation_error(format!(
            "{field} must not declare more than one of run, skill, or tool."
        )));
    }
    Ok(())
}

fn validate_mode(raw_step: &JsonObject, field: &str) -> Result<(), ValidationError> {
    let mode = optional_string(raw_step.get("mode"), &format!("{field}.mode"))?;
    match mode.as_deref() {
        None | Some("sequential") => Ok(()),
        Some("fanout") if matches!(raw_step.get("fanout_group"), Some(JsonValue::String(_))) => {
            Ok(())
        }
        Some("fanout") => Err(validation_error(format!(
            "{field}.fanout_group is required when mode is fanout."
        ))),
        Some(mode) => Err(validation_error(format!(
            "{field}.mode '{mode}' is not supported by the local graph runner."
        ))),
    }
}

fn context_edges(
    context: &BTreeMap<String, String>,
    previous_step_ids: &BTreeSet<String>,
    field: &str,
) -> Result<Vec<GraphContextEdge>, ValidationError> {
    context
        .iter()
        .map(|(input, reference)| {
            parse_context_reference(
                input,
                reference,
                previous_step_ids,
                &format!("{field}.context.{input}"),
            )
        })
        .collect()
}

fn parse_context_reference(
    input: &str,
    reference: &str,
    previous_step_ids: &BTreeSet<String>,
    field: &str,
) -> Result<GraphContextEdge, ValidationError> {
    let Some(dot_index) = reference.find('.') else {
        return Err(context_reference_error(field));
    };
    if dot_index == 0 || dot_index == reference.len() - 1 {
        return Err(context_reference_error(field));
    }
    let from_step = &reference[..dot_index];
    if !previous_step_ids.contains(from_step) {
        return Err(validation_error(format!(
            "{field} references unknown or later step '{from_step}'."
        )));
    }
    Ok(GraphContextEdge {
        input: input.to_owned(),
        from_step: from_step.to_owned(),
        output: reference[dot_index + 1..].to_owned(),
    })
}

fn context_reference_error(field: &str) -> ValidationError {
    validation_error(format!(
        "{field} must use '<step-id>.<output-field>' syntax."
    ))
}

fn validate_retry(
    value: Option<&JsonValue>,
    field: &str,
) -> Result<Option<GraphRetryPolicy>, ValidationError> {
    let Some(retry) = optional_object(value, field)? else {
        return Ok(None);
    };
    let max_attempts =
        optional_number(retry.get("max_attempts"), &format!("{field}.max_attempts"))?
            .map(|value| number_to_positive_integer(value, &format!("{field}.max_attempts")))
            .transpose()?
            .unwrap_or(1);
    let backoff_ms = optional_number(retry.get("backoff_ms"), &format!("{field}.backoff_ms"))?
        .map(|value| number_to_non_negative_integer(value, &format!("{field}.backoff_ms")))
        .transpose()?;
    Ok(Some(GraphRetryPolicy {
        max_attempts,
        backoff_ms,
    }))
}

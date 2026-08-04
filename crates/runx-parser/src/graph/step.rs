// Module rationale: graph step validation is kept together so
// field-level diagnostics stay consistent across graph target variants.
use std::collections::{BTreeMap, BTreeSet};

use runx_contracts::{JsonObject, JsonValue};
use runx_core::policy::admit_agent_tool_ref;

use super::helpers::{
    number_to_non_negative_integer, number_to_positive_integer, optional_bool,
    optional_non_empty_string, optional_number, optional_object, optional_string,
    optional_string_array, optional_string_object, required_string, validation_error,
};
use super::types::{
    GraphContextEdge, GraphRetryPolicy, GraphRunTarget, GraphStep, GraphWhen,
    MintAuthorityDirective, MintScopeSource,
};
use crate::{ValidationError, skill::validate_skill_artifact_contract};

struct StepTarget {
    skill: Option<String>,
    tool: Option<String>,
    run: Option<GraphRunTarget>,
}

// Function rationale: step validation parses one step's fields in a
// single pass and rejects incoherent combinations inline; splitting it would scatter
// the per-field rules away from the step they validate.
pub fn validate_step(
    raw_step: &JsonObject,
    field: &str,
    previous_step_ids: &BTreeSet<String>,
    charter_in_scope: bool,
) -> Result<GraphStep, ValidationError> {
    reject_unsupported_step_fields(raw_step, field)?;

    let id = validate_step_id(raw_step, field, previous_step_ids)?;
    let target = validate_step_target(raw_step, field)?;
    validate_step_tool_ref(&target.tool, field)?;
    let runner = validate_runner(raw_step, field, &target)?;
    let context = optional_string_object(raw_step.get("context"), &format!("{field}.context"))?
        .unwrap_or_default();
    let context_skills = optional_string_array(
        raw_step.get("context_skills"),
        &format!("{field}.context_skills"),
    )?
    .unwrap_or_default();
    validate_context_skills(&context_skills, field, &target)?;

    let inputs =
        optional_object(raw_step.get("inputs"), &format!("{field}.inputs"))?.unwrap_or_default();
    reject_legacy_input_bindings(&inputs, &format!("{field}.inputs"))?;
    reject_step_output_refs_in_inputs(&inputs, previous_step_ids, &format!("{field}.inputs"))?;
    reject_static_context_input_collisions(&inputs, &context, field)?;

    let scopes = optional_string_array(raw_step.get("scopes"), &format!("{field}.scopes"))?
        .unwrap_or_default();
    if scopes.iter().any(|scope| scope.trim().is_empty()) {
        return Err(validation_error(format!(
            "{field}.scopes must contain only non-empty scope strings."
        )));
    }
    let requested_scope_from = optional_non_empty_string(
        raw_step.get("requested_scope_from"),
        &format!("{field}.requested_scope_from"),
    )?;
    let mint_authority = validate_mint_authority(
        raw_step.get("mint_authority"),
        field,
        charter_in_scope,
        &scopes,
        requested_scope_from.as_deref(),
    )?;
    let outputs = optional_object(raw_step.get("outputs"), &format!("{field}.outputs"))?;
    if let Some(outputs) = &outputs {
        runx_contracts::parse_output_contract(outputs)
            .map_err(|error| validation_error(format!("{field}.outputs is invalid: {error}")))?;
    }

    Ok(GraphStep {
        id,
        label: optional_non_empty_string(raw_step.get("label"), &format!("{field}.label"))?,
        skill: target.skill,
        tool: target.tool,
        run: target.run,
        artifacts: validate_skill_artifact_contract(
            raw_step.get("artifacts"),
            &format!("{field}.artifacts"),
        )?,
        outputs,
        runner,
        inputs,
        context_edges: context_edges(&context, previous_step_ids, field)?,
        context,
        context_skills,
        scopes,
        allowed_tools: validate_allowed_tools(raw_step.get("allowed_tools"), field)?,
        retry: validate_retry(raw_step.get("retry"), &format!("{field}.retry"))?,
        policy: optional_object(raw_step.get("policy"), &format!("{field}.policy"))?,
        fanout_group: optional_string(
            raw_step.get("fanout_group"),
            &format!("{field}.fanout_group"),
        )?,
        when: validate_when(raw_step.get("when"), &format!("{field}.when"))?,
        mutating: optional_bool(raw_step.get("mutation"), &format!("{field}.mutation"))?
            .unwrap_or(false),
        idempotency_key: optional_non_empty_string(
            raw_step.get("idempotency_key"),
            &format!("{field}.idempotency_key"),
        )?,
        mint_authority,
        requested_scope_from,
    })
}

fn reject_static_context_input_collisions(
    inputs: &JsonObject,
    context: &BTreeMap<String, String>,
    field: &str,
) -> Result<(), ValidationError> {
    let collisions = inputs
        .keys()
        .filter(|key| context.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
    if collisions.is_empty() {
        return Ok(());
    }
    Err(validation_error(format!(
        "{field} binds the same input through both inputs and context: {}.",
        collisions.join(", ")
    )))
}

/// Validate the `mint_authority` compute-path directive and its coherence with
/// the graph charter and the chosen scope source. A directive is only admissible
/// when the graph (or runner) declares `charter_from`, and each source draws from
/// exactly one place: `static_scopes` from the step's non-empty `scopes:` list and
/// nothing else, `requested_scope` from `requested_scope_from` and nothing else.
fn validate_mint_authority(
    value: Option<&JsonValue>,
    field: &str,
    charter_in_scope: bool,
    scopes: &[String],
    requested_scope_from: Option<&str>,
) -> Result<Option<MintAuthorityDirective>, ValidationError> {
    let Some(record) = optional_object(value, &format!("{field}.mint_authority"))? else {
        if requested_scope_from.is_some() {
            return Err(validation_error(format!(
                "{field}.requested_scope_from is only valid with a mint_authority directive."
            )));
        }
        return Ok(None);
    };
    if !charter_in_scope {
        return Err(validation_error(format!(
            "{field}.mint_authority requires the graph to declare charter_from."
        )));
    }
    let source = validate_mint_scope_source(
        record.get("source"),
        &format!("{field}.mint_authority.source"),
    )?;
    match source {
        MintScopeSource::StaticScopes => {
            if scopes.is_empty() {
                return Err(validation_error(format!(
                    "{field}.mint_authority source static_scopes requires a non-empty scopes list."
                )));
            }
            if requested_scope_from.is_some() {
                return Err(validation_error(format!(
                    "{field}.mint_authority source static_scopes must not declare requested_scope_from."
                )));
            }
        }
        MintScopeSource::RequestedScope => {
            if requested_scope_from.is_none() {
                return Err(validation_error(format!(
                    "{field}.mint_authority source requested_scope requires requested_scope_from."
                )));
            }
            if !scopes.is_empty() {
                return Err(validation_error(format!(
                    "{field}.mint_authority source requested_scope must not declare a static scopes list."
                )));
            }
        }
    }
    Ok(Some(MintAuthorityDirective { source }))
}

fn validate_mint_scope_source(
    value: Option<&JsonValue>,
    field: &str,
) -> Result<MintScopeSource, ValidationError> {
    match required_string(value, field)?.as_str() {
        "static_scopes" => Ok(MintScopeSource::StaticScopes),
        "requested_scope" => Ok(MintScopeSource::RequestedScope),
        other => Err(validation_error(format!(
            "{field} '{other}' must be static_scopes or requested_scope."
        ))),
    }
}

fn reject_step_output_refs_in_inputs(
    inputs: &JsonObject,
    previous_step_ids: &BTreeSet<String>,
    field: &str,
) -> Result<(), ValidationError> {
    for (key, value) in inputs {
        reject_step_output_refs_in_input_value(
            value,
            previous_step_ids,
            &format!("{field}.{key}"),
        )?;
    }
    Ok(())
}

fn reject_legacy_input_bindings(inputs: &JsonObject, field: &str) -> Result<(), ValidationError> {
    for (key, value) in inputs {
        reject_legacy_input_binding_value(value, &format!("{field}.{key}"))?;
    }
    Ok(())
}

fn reject_legacy_input_binding_value(
    value: &JsonValue,
    field: &str,
) -> Result<(), ValidationError> {
    match value {
        JsonValue::String(value) => legacy_input_binding_name(value).map_or(Ok(()), |name| {
            Err(validation_error(format!(
                "{field} uses retired graph input binding {value:?}; use \"$input.{name}\"."
            )))
        }),
        JsonValue::Object(object) => {
            for (key, value) in object {
                reject_legacy_input_binding_value(value, &format!("{field}.{key}"))?;
            }
            Ok(())
        }
        JsonValue::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                reject_legacy_input_binding_value(value, &format!("{field}.{index}"))?;
            }
            Ok(())
        }
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => Ok(()),
    }
}

fn legacy_input_binding_name(value: &str) -> Option<&str> {
    let name = value.strip_prefix("{{")?.strip_suffix("}}")?.trim();
    (!name.is_empty()
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '.')))
    .then_some(name)
}

fn reject_step_output_refs_in_input_value(
    value: &JsonValue,
    previous_step_ids: &BTreeSet<String>,
    field: &str,
) -> Result<(), ValidationError> {
    match value {
        JsonValue::String(value)
            if looks_like_previous_step_output_ref(value, previous_step_ids) =>
        {
            return Err(validation_error(format!(
                "{field} looks like step output reference {value:?}; move it to context if you meant to read a previous step output."
            )));
        }
        JsonValue::String(_) => {}
        JsonValue::Object(object) => {
            for (key, value) in object {
                reject_step_output_refs_in_input_value(
                    value,
                    previous_step_ids,
                    &format!("{field}.{key}"),
                )?;
            }
        }
        JsonValue::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                reject_step_output_refs_in_input_value(
                    value,
                    previous_step_ids,
                    &format!("{field}.{index}"),
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn looks_like_previous_step_output_ref(value: &str, previous_step_ids: &BTreeSet<String>) -> bool {
    let Some((from_step, output)) = value.split_once('.') else {
        return false;
    };
    !output.is_empty() && previous_step_ids.contains(from_step)
}

fn validate_when(
    value: Option<&JsonValue>,
    field: &str,
) -> Result<Option<GraphWhen>, ValidationError> {
    let Some(record) = optional_object(value, field)? else {
        return Ok(None);
    };
    let equals = record.get("equals").cloned();
    let not_equals = record.get("not_equals").cloned();
    if equals.is_some() && not_equals.is_some() {
        return Err(validation_error(format!(
            "{field} must not declare both equals and not_equals."
        )));
    }
    if equals.is_none() && not_equals.is_none() {
        return Err(validation_error(format!(
            "{field} must declare equals or not_equals."
        )));
    }
    Ok(Some(GraphWhen {
        field: required_string(record.get("field"), &format!("{field}.field"))?,
        equals,
        not_equals,
    }))
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

fn validate_step_tool_ref(tool_ref: &Option<String>, field: &str) -> Result<(), ValidationError> {
    let Some(tool_ref) = tool_ref else {
        return Ok(());
    };
    let admission = admit_agent_tool_ref(tool_ref);
    if !admission.allowed {
        return Err(validation_error(format!(
            "{field}.tool {tool_ref:?} is not an admissible catalog tool ref: {}.",
            admission.reason
        )));
    }
    Ok(())
}

fn validate_context_skills(
    context_skills: &[String],
    field: &str,
    target: &StepTarget,
) -> Result<(), ValidationError> {
    if context_skills.is_empty() || target.skill.is_some() {
        return Ok(());
    }
    if let Some(run) = &target.run
        && run
            .source()
            .is_some_and(|source| source.source_type == crate::SourceKind::AgentStep)
    {
        return Ok(());
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
    let run = optional_object(raw_step.get("run"), &format!("{field}.run"))?
        .map(|run| GraphRunTarget::validate(run, &format!("{field}.run")))
        .transpose()?;
    let target = StepTarget {
        skill: optional_non_empty_string(raw_step.get("skill"), &format!("{field}.skill"))?,
        tool: optional_non_empty_string(raw_step.get("tool"), &format!("{field}.tool"))?,
        run,
    };
    let target_count = usize::from(target.skill.is_some())
        + usize::from(target.tool.is_some())
        + usize::from(target.run.is_some());
    if target_count != 1 {
        return Err(validation_error(format!(
            "{field} must declare exactly one of skill, tool, or run."
        )));
    }
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

fn reject_unsupported_step_fields(
    raw_step: &JsonObject,
    field: &str,
) -> Result<(), ValidationError> {
    if raw_step.contains_key("instructions") {
        return Err(validation_error(format!(
            "{field}.instructions is not supported; put agent operating instructions in the owning SKILL.md"
        )));
    }
    if raw_step.contains_key("effect_family") {
        return Err(validation_error(format!(
            "{field}.effect_family is not supported; effect ownership is derived from the resolved target"
        )));
    }
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
    let output = &reference[dot_index + 1..];
    Ok(GraphContextEdge {
        input: input.to_owned(),
        from_step: from_step.to_owned(),
        output: output.to_owned(),
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

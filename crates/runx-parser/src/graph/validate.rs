use std::collections::BTreeSet;

use runx_contracts::JsonObject;

use super::fanout::{validate_fanout_groups, validate_fanout_step_bindings};
use super::helpers::{
    optional_string, required_array, required_object, required_string, validation_error,
};
use super::policy::validate_graph_policy;
use super::step::validate_step;
use super::types::{ExecutionGraph, RawGraphIr};
use crate::{ParseError, ValidationError, assert_yaml_parity_subset};

pub fn parse_graph_yaml(source: &str) -> Result<RawGraphIr, ParseError> {
    assert_yaml_parity_subset("graph", source)?;
    let document: JsonObject =
        serde_norway::from_str(source).map_err(|error| ParseError::InvalidYaml {
            field: "graph".to_owned(),
            message: error.to_string(),
        })?;
    Ok(RawGraphIr { document })
}

pub fn validate_graph(raw: RawGraphIr) -> Result<ExecutionGraph, ValidationError> {
    validate_graph_document(raw.document.clone(), Some(raw))
}

pub fn validate_graph_document(
    document: JsonObject,
    raw: Option<RawGraphIr>,
) -> Result<ExecutionGraph, ValidationError> {
    reject_unsupported_top_level(&document)?;

    let name = required_string(document.get("name"), "name")?;
    let owner = optional_string(document.get("owner"), "owner")?;
    let charter_from = optional_string(document.get("charter_from"), "charter_from")?;
    let raw_steps = required_array(document.get("steps"), "steps")?;
    let fanout_groups = validate_fanout_groups(document.get("fanout"), "fanout")?;
    let policy = validate_graph_policy(document.get("policy"), "policy")?;
    let mut seen_step_ids = BTreeSet::new();
    let mut steps = Vec::new();

    for (index, raw_step) in raw_steps.iter().enumerate() {
        let field = format!("steps.{index}");
        let raw_step = required_object(Some(raw_step), &field)?;
        let step = validate_step(raw_step, &field, &seen_step_ids, charter_from.is_some())?;
        seen_step_ids.insert(step.id.clone());
        steps.push(step);
    }

    validate_fanout_step_bindings(&steps, &fanout_groups)?;

    Ok(ExecutionGraph {
        name,
        owner,
        charter_from,
        steps,
        fanout_groups,
        policy,
        raw: raw.unwrap_or(RawGraphIr { document }),
    })
}

fn reject_unsupported_top_level(document: &JsonObject) -> Result<(), ValidationError> {
    for field in ["sync", "schedule", "schedules"] {
        if document.contains_key(field) {
            return Err(validation_error(format!(
                "{field} is not supported by the local sequential graph runner."
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_graph_yaml, validate_graph};

    #[test]
    fn inputs_reject_previous_step_output_references() -> Result<(), String> {
        let raw = parse_graph_yaml(
            r#"
name: bad-input-ref
steps:
  - id: select
    run:
      type: agent-task
  - id: review
    run:
      type: agent-task
    inputs:
      bounty: select.result
"#,
        )
        .map_err(|error| error.to_string())?;
        let error = validate_graph(raw)
            .err()
            .ok_or_else(|| "graph unexpectedly validated".to_owned())?;
        let message = error.to_string();
        assert!(message.contains("steps.1.inputs.bounty"));
        assert!(message.contains("move it to context"));
        Ok(())
    }

    #[test]
    fn inputs_allow_literals_that_are_not_previous_step_refs() -> Result<(), String> {
        let raw = parse_graph_yaml(
            r#"
name: literal-input
steps:
  - id: review
    run:
      type: agent-task
    inputs:
      literal: select.result
      variable: $input.claim
      url: https://example.com/a.b
"#,
        )
        .map_err(|error| error.to_string())?;
        validate_graph(raw).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn validate_yaml(source: &str) -> Result<crate::ExecutionGraph, String> {
        let raw = parse_graph_yaml(source).map_err(|error| error.to_string())?;
        validate_graph(raw).map_err(|error| error.to_string())
    }

    fn validate_err(source: &str) -> Result<String, String> {
        let raw = parse_graph_yaml(source).map_err(|error| error.to_string())?;
        validate_graph(raw)
            .err()
            .map(|error| error.to_string())
            .ok_or_else(|| "graph unexpectedly validated".to_owned())
    }

    #[test]
    fn charter_from_and_static_scope_mint_validate() -> Result<(), String> {
        let graph = validate_yaml(
            r#"
name: mint-static
charter_from: charter
steps:
  - id: dispatch
    run:
      type: agent-task
    scopes:
      - payments:spend
    mint_authority:
      source: static_scopes
"#,
        )?;
        assert_eq!(graph.charter_from.as_deref(), Some("charter"));
        let directive = graph.steps[0]
            .mint_authority
            .ok_or_else(|| "expected mint_authority".to_owned())?;
        assert_eq!(directive.source, crate::MintScopeSource::StaticScopes);
        Ok(())
    }

    #[test]
    fn requested_scope_mint_validates() -> Result<(), String> {
        let graph = validate_yaml(
            r#"
name: mint-dynamic
charter_from: charter
steps:
  - id: dispatch
    run:
      type: agent-task
    requested_scope_from: needed_scope
    mint_authority:
      source: requested_scope
"#,
        )?;
        let step = &graph.steps[0];
        assert_eq!(step.requested_scope_from.as_deref(), Some("needed_scope"));
        assert_eq!(
            step.mint_authority.map(|directive| directive.source),
            Some(crate::MintScopeSource::RequestedScope)
        );
        Ok(())
    }

    #[test]
    fn mint_authority_without_charter_is_rejected() -> Result<(), String> {
        let message = validate_err(
            r#"
name: mint-no-charter
steps:
  - id: dispatch
    run:
      type: agent-task
    scopes:
      - payments:spend
    mint_authority:
      source: static_scopes
"#,
        )?;
        assert!(message.contains("requires the graph to declare charter_from"));
        Ok(())
    }

    #[test]
    fn static_scopes_mint_rejects_requested_scope_from() -> Result<(), String> {
        let message = validate_err(
            r#"
name: mint-two-sources
charter_from: charter
steps:
  - id: dispatch
    run:
      type: agent-task
    scopes:
      - payments:spend
    requested_scope_from: needed_scope
    mint_authority:
      source: static_scopes
"#,
        )?;
        assert!(message.contains("must not declare requested_scope_from"));
        Ok(())
    }

    #[test]
    fn static_scopes_mint_requires_non_empty_scopes() -> Result<(), String> {
        let message = validate_err(
            r#"
name: mint-no-scopes
charter_from: charter
steps:
  - id: dispatch
    run:
      type: agent-task
    mint_authority:
      source: static_scopes
"#,
        )?;
        assert!(message.contains("requires a non-empty scopes list"));
        Ok(())
    }

    #[test]
    fn requested_scope_mint_requires_input_key() -> Result<(), String> {
        let message = validate_err(
            r#"
name: mint-missing-input
charter_from: charter
steps:
  - id: dispatch
    run:
      type: agent-task
    mint_authority:
      source: requested_scope
"#,
        )?;
        assert!(message.contains("requires requested_scope_from"));
        Ok(())
    }

    #[test]
    fn requested_scope_mint_rejects_static_scopes() -> Result<(), String> {
        let message = validate_err(
            r#"
name: mint-mixed
charter_from: charter
steps:
  - id: dispatch
    run:
      type: agent-task
    scopes:
      - payments:spend
    requested_scope_from: needed_scope
    mint_authority:
      source: requested_scope
"#,
        )?;
        assert!(message.contains("must not declare a static scopes list"));
        Ok(())
    }

    #[test]
    fn requested_scope_from_without_directive_is_rejected() -> Result<(), String> {
        let message = validate_err(
            r#"
name: dangling-requested-scope
charter_from: charter
steps:
  - id: dispatch
    run:
      type: agent-task
    requested_scope_from: needed_scope
"#,
        )?;
        assert!(message.contains("only valid with a mint_authority directive"));
        Ok(())
    }

    #[test]
    fn unknown_mint_source_is_rejected() -> Result<(), String> {
        let message = validate_err(
            r#"
name: bad-source
charter_from: charter
steps:
  - id: dispatch
    run:
      type: agent-task
    scopes:
      - payments:spend
    mint_authority:
      source: widen_everything
"#,
        )?;
        assert!(message.contains("must be static_scopes or requested_scope"));
        Ok(())
    }
}

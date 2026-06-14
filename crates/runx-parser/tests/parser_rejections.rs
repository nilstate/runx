use std::collections::BTreeSet;

use runx_parser::{
    ParseErrorKind, ValidationErrorKind, assert_yaml_scalar_subset, parse_graph_yaml,
    parse_runner_manifest_yaml, parse_skill_markdown, parse_tool_manifest_json,
    parse_tool_manifest_yaml, validate_graph, validate_skill,
};

#[test]
fn parse_rejections_cover_every_error_kind() -> Result<(), String> {
    let mut kinds = BTreeSet::new();

    kinds.insert(parse_error_kind(parse_graph_yaml("name: [unterminated\n"))?);
    kinds.insert(parse_error_kind(parse_tool_manifest_json("{"))?);
    kinds.insert(parse_error_kind(parse_skill_markdown(
        "# missing frontmatter\n",
    ))?);
    kinds.insert(parse_error_kind(assert_yaml_scalar_subset(
        "fixture", "yes",
    ))?);

    assert_eq!(
        kinds,
        BTreeSet::from([
            ParseErrorKind::InvalidYaml,
            ParseErrorKind::InvalidJson,
            ParseErrorKind::InvalidDocument,
            ParseErrorKind::UnsupportedScalar,
        ]),
    );
    Ok(())
}

#[test]
fn validation_rejections_cover_every_error_kind() -> Result<(), String> {
    let mut kinds = BTreeSet::new();

    let missing_step_id = parse_graph_yaml(
        r#"
name: bad
steps:
  - skill: ../../skills/echo
"#,
    )
    .map_err(|error| error.to_string())?;
    kinds.insert(validation_error_kind(validate_graph(missing_step_id))?);

    let invalid_fanout_gate = parse_graph_yaml(
        r#"
name: fanout
fanout:
  groups:
    advisors:
      threshold_gates:
        - step: risk
          field: risk_score
          above: 0.8
          action: pause
          sentiment: negative
steps:
  - id: risk
    mode: fanout
    fanout_group: advisors
    skill: ../../skills/echo
"#,
    )
    .map_err(|error| error.to_string())?;
    kinds.insert(validation_error_kind(validate_graph(invalid_fanout_gate))?);

    assert_eq!(
        kinds,
        BTreeSet::from([
            ValidationErrorKind::MissingField,
            ValidationErrorKind::InvalidField,
        ]),
    );
    Ok(())
}

#[test]
fn graph_agent_task_accepts_context_skills() -> Result<(), String> {
    let graph = validate_graph(
        parse_graph_yaml(
            r#"
name: context-skills
steps:
  - id: apply_taste
    run:
      type: agent-task
      agent: builder
      task: apply taste
    context_skills:
      - registry:runx/taste-profile@1.0.0
"#,
        )
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    assert_eq!(
        graph.steps[0].context_skills,
        vec!["registry:runx/taste-profile@1.0.0"]
    );
    Ok(())
}

#[test]
fn graph_rejects_stage_steps() -> Result<(), String> {
    // `stage` is no longer a step kind; nested graph components are referenced as
    // ordinary skills (e.g. `skill: graph/pay-quote`).
    let error = validate_graph(
        parse_graph_yaml(
            r#"
name: stage-graph
steps:
  - id: quote
    stage: pay-quote
    skill: graph/pay-quote
"#,
        )
        .map_err(|error| error.to_string())?,
    )
    .err()
    .ok_or_else(|| "expected stage step to be rejected".to_owned())?;

    assert!(
        error.to_string().contains("stage is not supported"),
        "{error}"
    );
    Ok(())
}

#[test]
fn graph_rejects_context_skills_on_non_agent_run_steps() -> Result<(), String> {
    let error = validate_graph(
        parse_graph_yaml(
            r#"
name: bad-context-skills
steps:
  - id: shell
    run:
      type: cli-tool
      command: echo
    context_skills:
      - ../taste-profile
"#,
        )
        .map_err(|error| error.to_string())?,
    )
    .err()
    .ok_or_else(|| "expected context_skills validation rejection".to_owned())?;

    assert!(
        error.to_string().contains("context_skills is only valid"),
        "{error}"
    );
    Ok(())
}

#[test]
fn strict_skill_validation_matches_runx_object_error() -> Result<(), String> {
    let raw = parse_skill_markdown(
        r#"---
name: bad-runx
runx: invalid
---
Body
"#,
    )
    .map_err(|error| error.to_string())?;

    match validate_skill(raw) {
        Ok(_) => Err("expected strict runx validation rejection".to_owned()),
        Err(error) => {
            assert_eq!(error.to_string(), "runx must be an object when present.");
            Ok(())
        }
    }
}

#[test]
fn yaml_parity_rejects_embedded_colon_mapping_key() -> Result<(), String> {
    let error = parse_runner_manifest_yaml(
        r#"
skill: bad
email:send:
  type: cli-tool
runners:
  default:
    type: cli-tool
    command: echo
"#,
    )
    .err()
    .ok_or_else(|| "expected embedded-colon key rejection".to_owned())?;

    assert_eq!(error.kind(), ParseErrorKind::InvalidYaml);
    assert!(
        error.to_string().contains("ambiguous YAML construct"),
        "{error}"
    );
    Ok(())
}

#[test]
fn yaml_parity_rejects_colon_space_in_plain_scalar() -> Result<(), String> {
    let error = parse_tool_manifest_yaml(
        r#"
name: bad-tool
description: needs quote (granted: repo.read)
source:
  type: cli-tool
  command: echo
"#,
    )
    .err()
    .ok_or_else(|| "expected colon-space scalar rejection".to_owned())?;

    assert_eq!(error.kind(), ParseErrorKind::InvalidYaml);
    assert!(
        error.to_string().contains("ambiguous YAML construct"),
        "{error}"
    );
    Ok(())
}

#[test]
fn yaml_parity_allows_quoted_colon_space() -> Result<(), String> {
    let raw = parse_tool_manifest_yaml(
        r#"
name: ok-tool
description: "quoted value (granted: repo.read)"
source:
  type: cli-tool
  command: echo
"#,
    )
    .map_err(|error| error.to_string())?;

    assert!(raw.document.contains_key("name"));
    Ok(())
}

fn parse_error_kind<T>(
    result: Result<T, runx_parser::ParseError>,
) -> Result<ParseErrorKind, String> {
    match result {
        Ok(_) => Err("expected parse rejection".to_owned()),
        Err(error) => Ok(error.kind()),
    }
}

fn validation_error_kind<T>(
    result: Result<T, runx_parser::ValidationError>,
) -> Result<ValidationErrorKind, String> {
    match result {
        Ok(_) => Err("expected validation rejection".to_owned()),
        Err(error) => Ok(error.kind()),
    }
}

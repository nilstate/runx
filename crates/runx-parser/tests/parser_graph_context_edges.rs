use runx_parser::{parse_graph_yaml, validate_graph};

fn graph_with_edge(edge: &str) -> String {
    format!(
        r#"
name: ctx-edge
steps:
  - id: first
    run:
      type: cli-tool
      command: node
      args: ["-e", "process.stdout.write('{{}}')"]
  - id: second
    skill: ../../skills/echo
    context:
      message: first.{edge}
"#
    )
}

#[test]
fn graph_accepts_contract_context_edge() -> Result<(), String> {
    let graph = validate_graph(
        parse_graph_yaml(&graph_with_edge("result.data.message"))
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    assert_eq!(
        graph.steps[1].context_edges[0].output,
        "result.data.message"
    );
    Ok(())
}

#[test]
fn graph_does_not_reserve_process_diagnostic_names() -> Result<(), String> {
    // Process diagnostics live outside the declared step contract. A producer
    // may therefore intentionally declare any of these ordinary field names.
    for name in ["stdout", "skill_claim", "status", "raw", "stderr"] {
        let graph = validate_graph(
            parse_graph_yaml(&graph_with_edge(name)).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(graph.steps[1].context_edges[0].output, name);
    }
    Ok(())
}

#[test]
fn inline_graph_source_preserves_exact_environment_requirements() -> Result<(), String> {
    let graph = validate_graph(
        parse_graph_yaml(
            r#"
name: inline-environment
steps:
  - id: compute
    run:
      type: javascript
      module: compute.mjs
      environment:
        required: [REGION, TENANT_LABEL]
        optional: [TRACE_LABEL]
"#,
        )
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    let source = graph.steps[0]
        .run
        .as_ref()
        .and_then(|run| run.source())
        .ok_or_else(|| "inline source was not preserved".to_owned())?;
    assert_eq!(source.environment.required, ["REGION", "TENANT_LABEL"]);
    assert_eq!(source.environment.optional, ["TRACE_LABEL"]);
    Ok(())
}

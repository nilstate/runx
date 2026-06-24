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
fn graph_rejects_base_key_context_edge() -> Result<(), String> {
    // A context edge may bind only to a producing step's declared contract (outputs or
    // artifact packets), never to a base/diagnostic field. The parser rejects this at
    // validate time so authors fail fast rather than only at run time.
    for base in ["stdout", "skill_claim", "status", "raw", "stderr"] {
        let error = validate_graph(
            parse_graph_yaml(&graph_with_edge(base)).map_err(|error| error.to_string())?,
        )
        .err()
        .ok_or_else(|| format!("expected base-key context edge rejection for {base:?}"))?;

        let message = error.to_string();
        assert!(
            message.contains(&format!("base/diagnostic field '{base}'")),
            "unexpected error for {base:?}: {message}"
        );
    }
    Ok(())
}

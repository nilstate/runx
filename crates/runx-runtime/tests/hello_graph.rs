#![cfg(feature = "cli-tool")]

use std::path::Path;

use runx_core::state_machine::GraphStatus;
use runx_parser::{parse_graph_yaml, validate_graph};
use runx_runtime::adapters::cli_tool::CliToolAdapter;
use runx_runtime::{NoopHost, Runtime, RuntimeError, RuntimeOptions};

// The full hello-graph run (names, statuses, stdout, receipt digests and ids)
// is pinned against the golden fixture in parity/hello_graph.rs; this module
// keeps the coverage that fixture cannot express.

#[test]
fn hello_graph_resumes_from_checkpoint() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = Runtime::new(CliToolAdapter, RuntimeOptions::local_development());
    let graph_path = Path::new("../../examples/hello-graph/graph.yaml");

    let checkpoint = runtime.run_graph_file_until_steps(graph_path, 1)?;
    assert_eq!(checkpoint.steps.len(), 1);
    assert_eq!(checkpoint.steps[0].step_id, "first");

    let run = runtime.resume_graph_file(graph_path, checkpoint)?;
    assert_eq!(run.state.status, GraphStatus::Succeeded);
    assert_eq!(
        run.steps
            .iter()
            .map(|step| step.step_id.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );
    Ok(())
}

#[test]
fn unknown_run_type_fails_closed_before_skill_dispatch() -> Result<(), Box<dyn std::error::Error>> {
    let graph = validate_graph(parse_graph_yaml(
        r#"
name: unknown-run-type
steps:
  - id: custom-effect
    run:
      type: custom-effect
    inputs: {}
"#,
    )?)?;
    let runtime = Runtime::new(CliToolAdapter, RuntimeOptions::local_development());
    let mut host = NoopHost;
    let result = runtime.run_graph_with_host(Path::new("."), graph, &mut host);

    match result {
        Err(RuntimeError::UnsupportedRunStep { step_id, run_type }) => {
            assert_eq!(step_id, "custom-effect");
            assert_eq!(run_type, "custom-effect");
            Ok(())
        }
        Ok(_) => Err(std::io::Error::other("unsupported run type unexpectedly succeeded").into()),
        Err(other) => Err(std::io::Error::other(format!("unexpected error: {other}")).into()),
    }
}

use std::collections::BTreeMap;

use runx_contracts::{
    ExecutionEvent, JsonValue, ReferenceType, ResolutionRequest, ResolutionResponse,
    ResolutionResponseActor,
};
use runx_parser::{parse_graph_yaml, validate_graph};
use runx_runtime::adapters::cli_tool::CliToolAdapter;
use runx_runtime::{Host, Runtime, RuntimeError, RuntimeOptions};

const CREATED_AT: &str = "2026-08-27T00:00:00Z";

#[test]
fn policy_capability_requires_exact_approval_and_binds_its_receipt()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let graph = policy_write_graph(workspace.path(), true)?;
    let runtime = runtime();
    let mut host = ApprovalHost::new(true);

    let run = runtime.run_graph_with_host(workspace.path(), graph, &mut host)?;
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("approved.txt"))?,
        "approved"
    );

    let approval = run
        .steps
        .iter()
        .find(|step| step.step_id == "approve")
        .ok_or("missing approval step")?;
    let write = run
        .steps
        .iter()
        .find(|step| step.step_id == "write")
        .ok_or("missing write step")?;
    let expected_uri = format!("runx:receipt:{}", approval.receipt.id);
    assert!(write.receipt.acts.iter().any(|act| {
        act.artifact_refs.iter().any(|reference| {
            reference.reference_type == ReferenceType::Receipt
                && reference.uri.as_str() == expected_uri
                && reference.locator.as_ref() == Some(&approval.receipt.digest)
        })
    }));
    Ok(())
}

#[test]
fn policy_capability_refuses_a_missing_or_denied_guard_before_writing()
-> Result<(), Box<dyn std::error::Error>> {
    for (with_guard, approved, expected) in [
        (false, true, "requires an exact approved run:approval guard"),
        (true, false, "approval guard"),
    ] {
        let workspace = tempfile::tempdir()?;
        let graph = policy_write_graph(workspace.path(), with_guard)?;
        let mut host = ApprovalHost::new(approved);
        let error = runtime()
            .run_graph_with_host(workspace.path(), graph, &mut host)
            .expect_err("unapproved Policy mutation must fail closed");
        assert!(matches!(error, RuntimeError::AuthorityDenied { .. }));
        assert!(error.to_string().contains(expected));
        assert!(!workspace.path().join("approved.txt").exists());
    }
    Ok(())
}

#[test]
fn verified_parent_approval_is_inherited_by_the_nested_policy_mutation_only()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let child = workspace.path().join("child");
    std::fs::create_dir_all(&child)?;
    std::fs::write(
        child.join("SKILL.md"),
        "---\nname: child-policy-write\ndescription: nested policy fixture\n---\n# Child\n",
    )?;
    let child_graph = child_policy_graph(workspace.path());
    let indented_graph = child_graph
        .lines()
        .map(|line| format!("      {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(
        child.join("X.yaml"),
        format!(
            r#"skill: child-policy-write
runners:
  write:
    default: true
    type: graph
    graph:
{indented_graph}
"#,
        ),
    )?;
    let parent = validate_graph(parse_graph_yaml(&format!(
        r#"name: parent-policy-write
result_from: [child]
steps:
  - id: approve
    run: {{ type: approval }}
    inputs:
      gate_id: parent.child.approval
      reason: Approve the nested write.
    artifacts:
      wrap_as: approval_decision
      packet: runx.approval.decision.v1
  - id: child
    skill: ./child
    runner: write
    mutation: true
policy:
  guards:
    - step: child
      field: approve.approval_decision.data.approved
      equals: true
"#
    ))?)?;

    let mut host = ApprovalHost::new(true);
    runtime().run_graph_with_host(workspace.path(), parent, &mut host)?;
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("nested.txt"))?,
        "nested"
    );

    let child_graph = validate_graph(parse_graph_yaml(&child_graph)?)?;
    let error = runtime()
        .run_graph_with_host(&child, child_graph, &mut ApprovalHost::new(true))
        .expect_err("the private child graph must not fabricate inherited approval");
    assert!(matches!(error, RuntimeError::AuthorityDenied { .. }));
    Ok(())
}

fn child_policy_graph(workspace: &std::path::Path) -> String {
    format!(
        r#"name: child-policy-write
result_from: [write]
steps:
  - id: write
    tool: fs.write
    mutation: true
    scopes: [fs.write]
    inputs:
      repo_root: {root:?}
      path: nested.txt
      contents: nested"#,
        root = workspace.to_string_lossy()
    )
}

fn policy_write_graph(
    workspace: &std::path::Path,
    with_guard: bool,
) -> Result<runx_parser::ExecutionGraph, Box<dyn std::error::Error>> {
    let policy = if with_guard {
        r#"policy:
  guards:
    - step: write
      field: approve.approval_decision.data.approved
      equals: true
"#
    } else {
        ""
    };
    Ok(validate_graph(parse_graph_yaml(&format!(
        r#"name: policy-write
result_from: [write]
steps:
  - id: approve
    run: {{ type: approval }}
    inputs:
      gate_id: policy.write.approval
      reason: Approve the exact fixture write.
    artifacts:
      wrap_as: approval_decision
      packet: runx.approval.decision.v1
  - id: write
    tool: fs.write
    mutation: true
    scopes: [fs.write]
    inputs:
      repo_root: {root:?}
      path: approved.txt
      contents: approved
{policy}"#,
        root = workspace.to_string_lossy()
    ))?)?)
}

fn runtime() -> Runtime<CliToolAdapter> {
    let mut options = RuntimeOptions::local_development(BTreeMap::new());
    options.created_at = CREATED_AT.to_owned();
    Runtime::new(CliToolAdapter, options)
}

struct ApprovalHost {
    approved: bool,
}

impl ApprovalHost {
    fn new(approved: bool) -> Self {
        Self { approved }
    }
}

impl Host for ApprovalHost {
    fn report(&mut self, _event: ExecutionEvent) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn resolve(
        &mut self,
        _request: ResolutionRequest,
    ) -> Result<Option<ResolutionResponse>, RuntimeError> {
        Ok(Some(ResolutionResponse {
            actor: ResolutionResponseActor::Human,
            payload: JsonValue::Bool(self.approved),
        }))
    }

    fn log(&mut self, _message: String) -> Result<(), RuntimeError> {
        Ok(())
    }
}

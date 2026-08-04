//! Local, no-network per-run credential provision boundary.
//!
//! Declared credentials are delivered only to the selected runner and are
//! redacted from outputs and receipts.

#![cfg(feature = "cli-tool")]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::{JsonObject, JsonValue, ReferenceType};
use runx_runtime::RunStatus;
use runx_runtime::orchestrator::LocalCredentialDescriptor;
use runx_runtime::{LocalOrchestrator, RunResult, SkillRunRequest};
use tempfile::tempdir;

const SECRET: &str = "ghs_local_provision_secret_value";

#[test]
fn local_credential_for_cli_tool_is_delivered_and_redacted()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let skill_dir = write_echo_token_skill(temp.path())?;
    let receipt_dir = temp.path().join("receipts");

    let request = SkillRunRequest {
        skill_path: skill_dir,
        receipt_dir: Some(receipt_dir.clone()),
        run_id: None,
        answers_path: None,
        inputs: BTreeMap::new(),
        env: local_env(),
        cwd: temp.path().to_path_buf(),
        managed_agent: Default::default(),
        local_credential: Some(LocalCredentialDescriptor {
            profile: Some("github-main".to_owned()),
            provider: "github".to_owned(),
            audience: None,
            auth_mode: "bearer".to_owned(),
            env_var: "GITHUB_TOKEN".to_owned(),
            material_ref: "local://github/main".to_owned(),
            scopes: vec!["repo".to_owned()],
            secret: SECRET.to_owned(),
        }),
    };

    let result = run_skill(request)?;
    let serialized = serde_json::to_string(&result.output)?;
    assert_eq!(result.status, RunStatus::Sealed);
    assert!(serialized.contains("[redacted-credential]"));
    assert!(!serialized.contains(SECRET));
    assert!(receipt_dir.exists());

    Ok(())
}

#[test]
fn declared_credential_without_descriptor_fails_without_leak()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let skill_dir = write_echo_token_skill(temp.path())?;

    let request = SkillRunRequest {
        skill_path: skill_dir,
        receipt_dir: Some(temp.path().join("receipts")),
        run_id: None,
        answers_path: None,
        inputs: BTreeMap::new(),
        env: local_env(),
        cwd: temp.path().to_path_buf(),
        managed_agent: Default::default(),
        local_credential: None,
    };

    let error = match run_skill(request) {
        Ok(_) => return Err("declared credential unexpectedly ran without material".into()),
        Err(error) => error,
    };
    assert!(error.to_string().contains("requires credential"));
    assert!(!error.to_string().contains(SECRET));
    Ok(())
}

#[test]
fn graph_projects_credential_away_from_javascript_around_credentialed_tool()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempdir()?;
    let skill_dir = write_javascript_credential_graph(temp.path())?;
    let receipt_dir = temp.path().join("receipts");
    let result = run_skill(SkillRunRequest {
        skill_path: skill_dir,
        receipt_dir: Some(receipt_dir.clone()),
        run_id: None,
        answers_path: None,
        inputs: BTreeMap::new(),
        env: local_env(),
        cwd: temp.path().to_path_buf(),
        managed_agent: Default::default(),
        local_credential: Some(LocalCredentialDescriptor {
            profile: Some("github-main".to_owned()),
            provider: "github".to_owned(),
            audience: None,
            auth_mode: "bearer".to_owned(),
            env_var: "GITHUB_TOKEN".to_owned(),
            material_ref: "local://github/main".to_owned(),
            scopes: vec!["repo".to_owned()],
            secret: SECRET.to_owned(),
        }),
    })?;

    assert_eq!(result.status, RunStatus::Sealed);
    let serialized = serde_json::to_string(&result.output)?;
    assert!(!serialized.contains(SECRET));
    let output = result
        .output
        .as_object()
        .ok_or("skill output was not an object")?;
    let public_result = object_field(output, "result").ok_or("graph result was missing")?;
    let final_result = object_field(public_result, "result").ok_or("final result was missing")?;
    assert_eq!(
        final_result.get("process_type"),
        Some(&JsonValue::String("undefined".to_owned()))
    );
    assert_eq!(
        final_result.get("echoed"),
        Some(&JsonValue::String("[redacted-credential]".to_owned()))
    );
    assert_eq!(
        final_result.get("credential_seen"),
        Some(&JsonValue::Bool(true))
    );

    let steps = object_field(output, "trace")
        .and_then(|trace| trace.get("steps"))
        .and_then(JsonValue::as_array)
        .ok_or("graph step summaries were missing")?;
    let mut observed_steps = Vec::new();
    for step in steps {
        let step = step.as_object().ok_or("step summary was not an object")?;
        let step_id = step
            .get("step_id")
            .and_then(JsonValue::as_str)
            .ok_or("step id was missing")?;
        let receipt_id = step
            .get("receipt_id")
            .and_then(JsonValue::as_str)
            .ok_or("step receipt id was missing")?;
        let receipt = crate::support::read_test_signed_receipt(&receipt_dir, receipt_id)?;
        let receipt_json = serde_json::to_string(&receipt)?;
        assert!(!receipt_json.contains(SECRET));
        let carries_credential_proof = receipt
            .acts
            .iter()
            .flat_map(|act| &act.criterion_bindings)
            .flat_map(|binding| &binding.verification_refs)
            .any(|reference| reference.reference_type == ReferenceType::Credential);
        if carries_credential_proof {
            observed_steps.push(step_id.to_owned());
        }
    }
    assert_eq!(observed_steps, ["provider"]);
    Ok(())
}

fn run_skill(mut request: SkillRunRequest) -> Result<RunResult, Box<dyn std::error::Error>> {
    crate::support::insert_test_signing_env(&mut request.env);
    LocalOrchestrator::default()
        .run_skill(&request)
        .map_err(Into::into)
}

fn local_env() -> BTreeMap<String, String> {
    BTreeMap::new()
}

/// A cli-tool skill that echoes the delivered `$GITHUB_TOKEN`. The command is a
/// local shell process: no network, no hosted dependency.
fn write_echo_token_skill(root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let skill_dir = root.join("echo-token");
    fs::create_dir_all(&skill_dir)?;
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: echo-token\n---\n# Echo Token\n",
    )?;
    fs::write(
        skill_dir.join("X.yaml"),
        r#"
skill: echo-token
credentials:
  github:
    provider: github
    auth:
      bearer:
        delivery:
          env: GITHUB_TOKEN
runners:
  echo:
    default: true
    type: cli-tool
    command: sh
    credential: github
    args:
      - "-c"
      - "printf '%s' \"$GITHUB_TOKEN\""
"#,
    )?;
    Ok(skill_dir)
}

fn write_javascript_credential_graph(root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let skill_dir = root.join("javascript-credential-graph");
    fs::create_dir_all(&skill_dir)?;
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: javascript-credential-graph\n---\n# JavaScript Credential Graph\n",
    )?;
    fs::write(
        skill_dir.join("X.yaml"),
        r#"
skill: javascript-credential-graph
credentials:
  github:
    provider: github
    auth:
      bearer:
        delivery:
          env: GITHUB_TOKEN
runners:
  exercise:
    default: true
    type: graph
    credential: github
    graph:
      name: javascript-credential-graph
      result_from:
        - finalize
      steps:
        - id: prepare
          run:
            type: javascript
            module: graph.mjs
            export: prepare
            outputs:
              prepared: object
        - id: provider
          run:
            type: cli-tool
            command: sh
            args:
              - "-c"
              - |
                if test -n "$GITHUB_TOKEN"; then seen=true; else seen=false; fi
                printf '{"credential_seen":%s,"echoed":"%s"}' "$seen" "$GITHUB_TOKEN"
            outputs:
              credential_seen: boolean
              echoed: string
        - id: finalize
          context:
            prepared: prepare.prepared
            credential_seen: provider.credential_seen
            echoed: provider.echoed
          run:
            type: javascript
            module: graph.mjs
            export: finalize
            outputs:
              result: object
"#,
    )?;
    fs::write(
        skill_dir.join("graph.mjs"),
        r#"
export const prepare = () => ({
  prepared: { process_type: typeof process }
});

export const finalize = ({ prepared, credential_seen, echoed }) => ({
  result: {
    process_type: typeof process,
    prepared_process_type: prepared.process_type,
    credential_seen,
    echoed
  }
});
"#,
    )?;
    Ok(skill_dir)
}

fn object_field<'a>(object: &'a JsonObject, field: &str) -> Option<&'a JsonObject> {
    object.get(field).and_then(JsonValue::as_object)
}

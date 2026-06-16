#![cfg(feature = "cli-tool")]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use runx_contracts::{JsonObject, JsonValue};
use runx_parser::{SkillSandbox, SkillSource};
use runx_runtime::RUNX_CWD_ENV;
use runx_runtime::adapter::{InvocationStatus, SkillAdapter, SkillInvocation};
use runx_runtime::adapters::cli_tool::CliToolAdapter;
use runx_runtime::credentials::CredentialDelivery;
use serde::Deserialize;

#[derive(Deserialize)]
struct FixtureSuite {
    probe: String,
    skill_directory: String,
    cases: Vec<FixtureCase>,
}

#[derive(Deserialize)]
struct FixtureCase {
    id: String,
    mode: String,
    cwd: Option<String>,
    input_mode: Option<runx_parser::InputMode>,
    large_input_bytes: Option<usize>,
    timeout_seconds: u64,
    sandbox: FixtureSandbox,
    inputs: JsonObject,
    expected: FixtureExpected,
}

#[derive(Deserialize)]
struct FixtureSandbox {
    profile: runx_core::policy::SandboxProfile,
    cwd_policy: Option<runx_core::policy::CwdPolicy>,
}

#[derive(Deserialize)]
struct FixtureExpected {
    status: String,
    stdout_bytes: Option<usize>,
    stdout_json: Option<JsonValue>,
    stderr_contains: Option<String>,
    max_duration_ms: Option<u128>,
    sentinel_absent_after_ms: Option<u64>,
}

#[test]
fn rust_matches_skill_author_runtime_fixtures() -> Result<(), Box<dyn std::error::Error>> {
    let fixture_root = repo_root().join("fixtures/skill-author-runtime");
    let suite = fixture_suite(&fixture_root)?;
    let probe_path = fixture_root.join(&suite.probe);
    let skill_directory = fixture_root.join(&suite.skill_directory);

    for fixture in suite.cases {
        let temp_dir = tempfile::tempdir()?;
        let sentinel_path = temp_dir.path().join("sentinel");
        let started = Instant::now();
        let output = CliToolAdapter.invoke(SkillInvocation {
            skill_name: format!("skill-author-runtime.{}", fixture.id),
            source: fixture_source(&fixture, &probe_path)?,
            inputs: fixture_inputs(&fixture, &sentinel_path)?,
            resolved_inputs: JsonObject::new(),
            current_context: Vec::new(),
            skill_directory: skill_directory.clone(),
            env: fixture_env(&fixture_root, temp_dir.path(), &sentinel_path)?,
            credential_delivery: CredentialDelivery::none(),
        })?;
        let duration_ms = started.elapsed().as_millis();

        assert_eq!(
            normalized_status(output.status),
            fixture.expected.status,
            "{} status",
            fixture.id
        );
        if let Some(expected) = fixture.expected.stderr_contains.as_ref() {
            assert!(
                output.stderr.contains(expected),
                "{} stderr should contain {expected:?}",
                fixture.id
            );
        } else {
            assert_eq!(output.stderr, "", "{} stderr", fixture.id);
        }
        if let Some(expected) = fixture.expected.stdout_json {
            let actual: JsonValue = serde_json::from_str(&output.stdout)?;
            assert_eq!(actual, expected, "{} stdout_json", fixture.id);
        }
        if let Some(expected) = fixture.expected.stdout_bytes {
            assert_eq!(output.stdout.len(), expected, "{} stdout_bytes", fixture.id);
        }
        if let Some(max_duration_ms) = fixture.expected.max_duration_ms {
            assert!(
                duration_ms < max_duration_ms,
                "{} duration {duration_ms}ms exceeded {max_duration_ms}ms",
                fixture.id
            );
        }
        if let Some(delay_ms) = fixture.expected.sentinel_absent_after_ms {
            std::thread::sleep(Duration::from_millis(delay_ms));
            assert!(
                !sentinel_path.exists(),
                "{} descendant process survived cli-tool timeout",
                fixture.id
            );
        }
    }

    Ok(())
}

fn fixture_suite(fixture_root: &Path) -> Result<FixtureSuite, Box<dyn std::error::Error>> {
    let suite = fs::read_to_string(fixture_root.join("cases.json"))?;
    Ok(serde_json::from_str(&suite)?)
}

fn fixture_source(
    fixture: &FixtureCase,
    probe_path: &Path,
) -> Result<SkillSource, Box<dyn std::error::Error>> {
    Ok(SkillSource {
        act: None,
        source_type: runx_parser::SourceKind::CliTool,
        command: Some("node".to_owned()),
        args: vec![path_string(probe_path)?, fixture.mode.clone()],
        cwd: fixture.cwd.clone(),
        timeout_seconds: Some(fixture.timeout_seconds),
        input_mode: fixture.input_mode,
        sandbox: Some(SkillSandbox {
            profile: fixture.sandbox.profile.clone(),
            cwd_policy: fixture.sandbox.cwd_policy.clone(),
            env_allowlist: None,
            network: None,
            writable_paths: Vec::new(),
            require_enforcement: None,
            approved_escalation: Some(
                fixture.sandbox.profile == runx_core::policy::SandboxProfile::UnrestrictedLocalDev,
            ),
            raw: JsonObject::new(),
        }),
        server: None,
        catalog_ref: None,
        tool: None,
        arguments: None,
        agent_card_url: None,
        agent_identity: None,
        agent: None,
        task: None,
        hook: None,
        outputs: None,
        graph: None,
        http: None,
        raw: JsonObject::new(),
    })
}

fn fixture_inputs(
    fixture: &FixtureCase,
    sentinel_path: &Path,
) -> Result<JsonObject, Box<dyn std::error::Error>> {
    let mut inputs = fixture.inputs.clone();
    if let Some(bytes) = fixture.large_input_bytes {
        inputs.insert("large".to_owned(), JsonValue::String("x".repeat(bytes)));
    }
    if fixture.mode == "timeout-descendant" {
        inputs.insert(
            "sentinel_path".to_owned(),
            JsonValue::String(path_string(sentinel_path)?),
        );
    }
    Ok(inputs)
}

fn fixture_env(
    fixture_root: &Path,
    temp_dir: &Path,
    sentinel_path: &Path,
) -> Result<BTreeMap<String, String>, Box<dyn std::error::Error>> {
    let mut env = BTreeMap::new();
    if let Some(path) = std::env::var_os("PATH").and_then(|value| value.into_string().ok()) {
        env.insert("PATH".to_owned(), path);
    }
    env.insert(RUNX_CWD_ENV.to_owned(), path_string(fixture_root)?);
    env.insert("RUNX_SENTINEL_PATH".to_owned(), path_string(sentinel_path)?);
    env.insert("TMPDIR".to_owned(), path_string(temp_dir)?);
    Ok(env)
}

fn normalized_status(status: InvocationStatus) -> &'static str {
    match status {
        InvocationStatus::Success => "sealed",
        InvocationStatus::Failure => "failure",
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn path_string(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    Ok(path
        .to_str()
        .ok_or_else(|| format!("path is not utf-8: {}", path.display()))?
        .to_owned())
}

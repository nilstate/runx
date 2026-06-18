use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
#[cfg(feature = "cli-tool")]
use std::time::{Duration, Instant};

use runx_contracts::{JsonObject, JsonValue};
use runx_core::policy::{CwdPolicy, SandboxProfile};
use runx_parser::{SkillSandbox, SkillSource};
#[cfg(feature = "cli-tool")]
use runx_runtime::adapter::{InvocationStatus, SkillAdapter, SkillInvocation};
#[cfg(feature = "cli-tool")]
use runx_runtime::adapters::cli_tool::CliToolAdapter;
#[cfg(feature = "cli-tool")]
use runx_runtime::credentials::CredentialDelivery;
use runx_runtime::sandbox::prepare_process_sandbox;
use runx_runtime::{
    INIT_CWD_ENV, RUNX_CWD_ENV, RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV, RuntimeError,
};

const MAX_INLINE_INPUTS_BYTES: usize = 48 * 1024;
const MAX_INLINE_INPUT_VALUE_BYTES: usize = 8 * 1024;
const RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV: &str = "RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY";

#[test]
fn process_sandbox_always_exposes_runx_cwd_to_skill_authors()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    let workspace_dir = temp.path().join("workspace");
    fs::create_dir_all(&skill_dir)?;
    fs::create_dir_all(&workspace_dir)?;

    let plan = prepare_process_sandbox(
        &source(
            None,
            Some(sandbox(CwdPolicy::SkillDirectory, SandboxProfile::Readonly)),
        ),
        &skill_dir,
        &JsonObject::new(),
        &[(INIT_CWD_ENV.to_owned(), path_string(&workspace_dir)?)]
            .into_iter()
            .collect(),
    )?;

    assert_eq!(
        plan.env.get(RUNX_CWD_ENV).map(String::as_str),
        Some(path_string(&workspace_dir)?.as_str())
    );
    assert!(!plan.env.contains_key(INIT_CWD_ENV));
    Ok(())
}

#[test]
fn process_sandbox_rejects_reserved_env_allowlist_even_when_base_env_has_value()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    fs::create_dir_all(&skill_dir)?;
    let mut sandbox = sandbox(
        CwdPolicy::SkillDirectory,
        SandboxProfile::UnrestrictedLocalDev,
    );
    sandbox.env_allowlist = Some(vec![
        "PATH".to_owned(),
        RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV.to_owned(),
    ]);

    let Err(error) = prepare_process_sandbox(
        &source(None, Some(sandbox)),
        &skill_dir,
        &JsonObject::new(),
        &[(
            RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV.to_owned(),
            "seed".to_owned(),
        )]
        .into_iter()
        .collect(),
    ) else {
        return Err("reserved env allowlist must fail closed".into());
    };

    assert!(matches!(
        error,
        RuntimeError::SandboxViolation { message }
            if message.contains("reserved runx environment variable")
                && message.contains(RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV)
    ));
    Ok(())
}

#[test]
fn skill_directory_cwd_policy_denies_escaped_source_cwd() -> Result<(), Box<dyn std::error::Error>>
{
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    fs::create_dir_all(&skill_dir)?;

    let Err(error) = prepare_process_sandbox(
        &source(
            Some("../outside"),
            Some(sandbox(CwdPolicy::SkillDirectory, SandboxProfile::Readonly)),
        ),
        &skill_dir,
        &JsonObject::new(),
        &BTreeMap::new(),
    ) else {
        return Err("escaped cwd must fail closed".into());
    };

    assert!(matches!(
        error,
        RuntimeError::SandboxViolation { message }
            if message.contains("outside skill directory")
    ));
    Ok(())
}

#[test]
fn workspace_cwd_policy_denies_paths_outside_workspace() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    let workspace_dir = temp.path().join("workspace");
    fs::create_dir_all(&skill_dir)?;
    fs::create_dir_all(&workspace_dir)?;

    let Err(error) = prepare_process_sandbox(
        &source(
            Some("../outside"),
            Some(sandbox(CwdPolicy::Workspace, SandboxProfile::Readonly)),
        ),
        &skill_dir,
        &JsonObject::new(),
        &[(RUNX_CWD_ENV.to_owned(), path_string(&workspace_dir)?)]
            .into_iter()
            .collect(),
    ) else {
        return Err("workspace policy must fail closed outside workspace".into());
    };

    assert!(matches!(
        error,
        RuntimeError::SandboxViolation { message }
            if message.contains("outside workspace")
    ));
    Ok(())
}

#[test]
fn workspace_cwd_policy_resolves_relative_source_cwd_from_skill_directory()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let workspace_dir = temp.path().join("workspace");
    let skill_dir = workspace_dir.join("skills").join("demo");
    let sibling_dir = workspace_dir.join("fixtures");
    fs::create_dir_all(&skill_dir)?;
    fs::create_dir_all(&sibling_dir)?;

    let plan = prepare_process_sandbox(
        &source(
            Some("../../fixtures"),
            Some(sandbox(CwdPolicy::Workspace, SandboxProfile::Readonly)),
        ),
        &skill_dir,
        &JsonObject::new(),
        &[(RUNX_CWD_ENV.to_owned(), path_string(&workspace_dir)?)]
            .into_iter()
            .collect(),
    )?;

    assert_eq!(plan.cwd, sibling_dir);
    Ok(())
}

#[test]
fn workspace_cwd_policy_defaults_to_current_dir_when_runx_cwd_is_absent()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    fs::create_dir_all(&skill_dir)?;
    let current_dir = std::env::current_dir()?;

    let plan = prepare_process_sandbox(
        &source(
            Some(path_string(&current_dir)?.as_str()),
            Some(sandbox(CwdPolicy::Workspace, SandboxProfile::Readonly)),
        ),
        &skill_dir,
        &JsonObject::new(),
        &BTreeMap::new(),
    )?;

    assert_eq!(plan.cwd, current_dir);
    assert_eq!(
        plan.env.get(RUNX_CWD_ENV).map(String::as_str),
        Some(path_string(&current_dir)?.as_str())
    );
    Ok(())
}

#[test]
fn relative_skill_directory_preserves_leading_parent_segments()
-> Result<(), Box<dyn std::error::Error>> {
    let skill_dir = Path::new("../../fixtures/skills/json-output");

    let plan = prepare_process_sandbox(
        &source(
            None,
            Some(sandbox(CwdPolicy::SkillDirectory, SandboxProfile::Readonly)),
        ),
        skill_dir,
        &JsonObject::new(),
        &std::env::vars().collect(),
    )?;

    assert_eq!(plan.cwd, skill_dir);
    Ok(())
}

#[test]
fn oversized_inputs_spill_to_path_and_omit_inline_json() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    let temp_dir = temp.path().join("tmp");
    fs::create_dir_all(&skill_dir)?;
    fs::create_dir_all(&temp_dir)?;
    let large = "x".repeat(MAX_INLINE_INPUTS_BYTES);

    let plan = prepare_process_sandbox(
        &source(
            None,
            Some(sandbox(CwdPolicy::SkillDirectory, SandboxProfile::Readonly)),
        ),
        &skill_dir,
        &[("message".to_owned(), JsonValue::String(large.clone()))]
            .into_iter()
            .collect(),
        &[("TMPDIR".to_owned(), path_string(&temp_dir)?)]
            .into_iter()
            .collect(),
    )?;

    assert!(!plan.env.contains_key("RUNX_INPUTS_JSON"));
    let inputs_path = plan
        .env
        .get("RUNX_INPUTS_PATH")
        .cloned()
        .ok_or("missing RUNX_INPUTS_PATH")?;
    let inputs_path = Path::new(&inputs_path);
    let input_dir = plan
        .cleanup_paths
        .iter()
        .find(|path| inputs_path.starts_with(path))
        .cloned()
        .ok_or("missing input temp cleanup path")?;
    assert!(
        !inputs_path.starts_with(&temp_dir),
        "enforced sandboxes must spill inputs into a private temp directory"
    );
    let parsed: JsonObject = serde_json::from_str(&fs::read_to_string(inputs_path)?)?;
    assert_eq!(parsed.get("message"), Some(&JsonValue::String(large)));
    assert!(input_dir.exists());
    drop(plan);
    assert!(
        !input_dir.exists(),
        "oversized input temp directory was not cleaned up"
    );
    Ok(())
}

#[test]
fn oversized_per_input_env_value_is_omitted() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    fs::create_dir_all(&skill_dir)?;
    let oversized = "x".repeat(MAX_INLINE_INPUT_VALUE_BYTES + 1);

    let plan = prepare_process_sandbox(
        &source(
            None,
            Some(sandbox(CwdPolicy::SkillDirectory, SandboxProfile::Readonly)),
        ),
        &skill_dir,
        &[
            ("large".to_owned(), JsonValue::String(oversized)),
            ("small".to_owned(), JsonValue::String("ok".to_owned())),
        ]
        .into_iter()
        .collect(),
        &BTreeMap::new(),
    )?;

    assert!(!plan.env.contains_key("RUNX_INPUT_LARGE"));
    assert_eq!(
        plan.env.get("RUNX_INPUT_SMALL").map(String::as_str),
        Some("ok")
    );
    Ok(())
}

#[test]
fn unrestricted_local_dev_allows_custom_cwd_escape_after_approval()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    let outside_dir = temp.path().join("outside");
    fs::create_dir_all(&skill_dir)?;
    fs::create_dir_all(&outside_dir)?;

    let plan = prepare_process_sandbox(
        &source(
            Some(path_string(&outside_dir)?.as_str()),
            Some(sandbox(
                CwdPolicy::Custom,
                SandboxProfile::UnrestrictedLocalDev,
            )),
        ),
        &skill_dir,
        &JsonObject::new(),
        &BTreeMap::new(),
    )?;

    assert_eq!(plan.cwd, outside_dir);
    Ok(())
}

#[test]
fn input_env_names_match_author_visible_typescript_normalization()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    fs::create_dir_all(&skill_dir)?;

    let plan = prepare_process_sandbox(
        &source(
            None,
            Some(sandbox(CwdPolicy::SkillDirectory, SandboxProfile::Readonly)),
        ),
        &skill_dir,
        &[
            (
                "thread.title".to_owned(),
                JsonValue::String("Docs".to_owned()),
            ),
            (
                "  repeated---separator  ".to_owned(),
                JsonValue::String("ok".to_owned()),
            ),
        ]
        .into_iter()
        .collect(),
        &BTreeMap::new(),
    )?;

    assert_eq!(
        plan.env.get("RUNX_INPUT_THREAD_TITLE").map(String::as_str),
        Some("Docs")
    );
    assert_eq!(
        plan.env
            .get("RUNX_INPUT_REPEATED_SEPARATOR")
            .map(String::as_str),
        Some("ok")
    );
    assert!(!plan.env.contains_key("RUNX_INPUT__REPEATED___SEPARATOR__"));
    Ok(())
}

#[test]
fn input_env_name_collisions_fail_closed() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    fs::create_dir_all(&skill_dir)?;

    let Err(error) = prepare_process_sandbox(
        &source(
            None,
            Some(sandbox(CwdPolicy::SkillDirectory, SandboxProfile::Readonly)),
        ),
        &skill_dir,
        &[
            ("foo-bar".to_owned(), JsonValue::String("one".to_owned())),
            ("foo.bar".to_owned(), JsonValue::String("two".to_owned())),
        ]
        .into_iter()
        .collect(),
        &BTreeMap::new(),
    ) else {
        return Err("colliding input env names must fail closed".into());
    };

    assert!(matches!(
        error,
        RuntimeError::SandboxViolation { message }
            if message.contains("collide on environment variable RUNX_INPUT_FOO_BAR")
    ));
    Ok(())
}

#[test]
#[cfg(feature = "cli-tool")]
fn cli_tool_drains_large_stdout_and_omits_truncated_output()
-> Result<(), Box<dyn std::error::Error>> {
    let output = invoke_node(
        vec![
            "-e".to_owned(),
            "process.stdout.write('a'.repeat(2 * 1024 * 1024));".to_owned(),
        ],
        Some(5),
    )?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert!(output.stdout.is_empty());
    assert!(output.stderr.contains("stdout/stderr omitted"));
    Ok(())
}

#[test]
#[cfg(feature = "cli-tool")]
fn cli_tool_preserves_stderr_on_failed_process() -> Result<(), Box<dyn std::error::Error>> {
    let output = invoke_node(
        vec![
            "-e".to_owned(),
            "process.stderr.write('useful failure'); process.exit(7);".to_owned(),
        ],
        Some(5),
    )?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(output.exit_code, Some(7));
    assert_eq!(output.stderr, "useful failure");
    Ok(())
}

#[test]
#[cfg(feature = "cli-tool")]
fn cli_tool_spawn_failure_is_runtime_io() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    fs::create_dir_all(&skill_dir)?;
    let missing_command = temp.path().join("missing-command");
    let missing_command = path_string(&missing_command)?;
    let expected_cwd = skill_dir.display().to_string();

    let result = CliToolAdapter.invoke(SkillInvocation {
        skill_name: "spawn-failure".to_owned(),
        source: SkillSource {
            act: None,
            source_type: runx_parser::SourceKind::CliTool,
            command: Some(missing_command.clone()),
            args: Vec::new(),
            cwd: None,
            timeout_seconds: Some(5),
            input_mode: None,
            sandbox: None,
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
        },
        inputs: JsonObject::new(),
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: skill_dir,
        env: std::env::vars().collect(),
        credential_delivery: CredentialDelivery::none(),
    });

    let Err(RuntimeError::Io { context, .. }) = result else {
        return Err(format!("expected cli-tool spawn failure, got {result:?}").into());
    };
    assert!(context.starts_with("spawning cli-tool process `"));
    assert!(context.contains(&missing_command));
    assert!(context.ends_with(&format!(" in {expected_cwd}")));
    Ok(())
}

#[test]
#[cfg(feature = "cli-tool")]
fn cli_tool_timeout_kills_direct_child_without_waiting_for_full_script()
-> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    let output = invoke_node(
        vec!["-e".to_owned(), "setTimeout(() => {}, 10_000);".to_owned()],
        Some(1),
    )?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert!(started.elapsed() < Duration::from_secs(5));
    Ok(())
}

#[cfg(unix)]
#[test]
#[cfg(feature = "cli-tool")]
fn cli_tool_timeout_kills_descendant_processes() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let sentinel_path = temp.path().join("descendant-survived");
    let sentinel = serde_json::to_string(&path_string(&sentinel_path)?)?;
    let descendant_script = format!(
        "setTimeout(() => require('fs').writeFileSync({sentinel}, 'survived'), 2500); setInterval(() => {{}}, 1000);"
    );
    let parent_script = format!(
        "require('child_process').spawn(process.execPath, ['-e', {descendant_script:?}], {{ stdio: 'ignore' }}); setTimeout(() => {{}}, 10_000);"
    );

    let started = Instant::now();
    let output = invoke_node(vec!["-e".to_owned(), parent_script], Some(1))?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert!(started.elapsed() < Duration::from_secs(5));
    std::thread::sleep(Duration::from_secs(3));
    assert!(
        !sentinel_path.exists(),
        "descendant process survived cli-tool timeout"
    );
    Ok(())
}

#[test]
#[cfg(all(feature = "cli-tool", any(target_os = "linux", target_os = "macos")))]
fn enforced_readonly_sandbox_denies_workspace_write_when_backend_available()
-> Result<(), Box<dyn std::error::Error>> {
    if !platform_sandbox_backend_available() {
        return Ok(());
    }

    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    fs::create_dir_all(&skill_dir)?;
    let denied_path = skill_dir.join("denied.txt");
    let script = format!(
        "echo denied > {}; echo after-write",
        shell_quote(&path_string(&denied_path)?)
    );
    let mut sandbox = sandbox(CwdPolicy::SkillDirectory, SandboxProfile::Readonly);
    sandbox.require_enforcement = Some(true);

    let _output = CliToolAdapter.invoke(SkillInvocation {
        skill_name: "enforced-readonly".to_owned(),
        source: SkillSource {
            act: None,
            source_type: runx_parser::SourceKind::CliTool,
            command: Some("/bin/sh".to_owned()),
            args: vec!["-c".to_owned(), script],
            cwd: None,
            timeout_seconds: Some(5),
            input_mode: None,
            sandbox: Some(sandbox),
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
        },
        inputs: JsonObject::new(),
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: skill_dir,
        env: std::env::vars().collect(),
        credential_delivery: CredentialDelivery::none(),
    })?;

    assert!(
        !denied_path.exists(),
        "readonly sandbox allowed a write to {}",
        denied_path.display()
    );
    Ok(())
}

fn source(cwd: Option<&str>, sandbox: Option<SkillSandbox>) -> SkillSource {
    source_with_args(cwd, sandbox, Vec::new(), None)
}

fn source_with_args(
    cwd: Option<&str>,
    sandbox: Option<SkillSandbox>,
    args: Vec<String>,
    timeout_seconds: Option<u64>,
) -> SkillSource {
    SkillSource {
        act: None,
        source_type: runx_parser::SourceKind::CliTool,
        command: Some("node".to_owned()),
        args,
        cwd: cwd.map(str::to_owned),
        timeout_seconds,
        input_mode: None,
        sandbox,
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
    }
}

#[cfg(feature = "cli-tool")]
fn invoke_node(
    args: Vec<String>,
    timeout_seconds: Option<u64>,
) -> Result<runx_runtime::adapter::SkillOutput, Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("skill");
    fs::create_dir_all(&skill_dir)?;
    let adapter = CliToolAdapter;
    Ok(adapter.invoke(SkillInvocation {
        skill_name: "contract-test".to_owned(),
        source: source_with_args(
            None,
            Some(sandbox(CwdPolicy::SkillDirectory, SandboxProfile::Readonly)),
            args,
            timeout_seconds,
        ),
        inputs: JsonObject::new(),
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: skill_dir,
        env: env_with_local_sandbox_fallback(),
        credential_delivery: CredentialDelivery::none(),
    })?)
}

#[cfg(feature = "cli-tool")]
fn env_with_local_sandbox_fallback() -> BTreeMap<String, String> {
    let mut env = std::env::vars().collect::<BTreeMap<_, _>>();
    env.insert(
        RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV.to_owned(),
        "local".to_owned(),
    );
    env
}

fn sandbox(cwd_policy: CwdPolicy, profile: SandboxProfile) -> SkillSandbox {
    let approved_escalation = Some(profile == SandboxProfile::UnrestrictedLocalDev);
    SkillSandbox {
        profile,
        cwd_policy: Some(cwd_policy),
        env_allowlist: None,
        network: None,
        writable_paths: Vec::new(),
        require_enforcement: None,
        approved_escalation,
        raw: JsonObject::new(),
    }
}

fn path_string(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    Ok(path
        .to_str()
        .ok_or_else(|| format!("path is not utf-8: {}", path.display()))?
        .to_owned())
}

#[cfg(all(feature = "cli-tool", any(target_os = "linux", target_os = "macos")))]
fn platform_sandbox_backend_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/sandbox-exec")
            .args(["-p", "(version 1)\n(allow default)", "/usr/bin/true"])
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(target_os = "linux")]
    {
        Path::new("/usr/bin/bwrap").exists() || Path::new("/bin/bwrap").exists()
    }
}

#[cfg(all(feature = "cli-tool", any(target_os = "linux", target_os = "macos")))]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

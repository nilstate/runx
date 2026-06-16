use runx_cli::config::{ConfigAction, ConfigPlan};
use runx_cli::export::{ExportPlan, Target};
use runx_cli::kernel::{KernelInputSource, KernelPlan};
use runx_cli::launcher::{
    DevPlan, DoctorMode, DoctorPlan, FilterMode, HarnessPlan, HistoryPlan, InitPlan, JsonErrorPlan,
    LauncherAction, ListKind, ListPlan, NewPlan, ToolAction, ToolPlan, UrlAddPlan, help_text,
    history_help_text, plan_launcher, publish_help_text, skill_help_text, verify_help_text,
};
use runx_cli::login::LoginPlan;
use runx_cli::mcp::McpPlan;
use runx_cli::parser::{ParserInputSource, ParserPlan};
use runx_cli::policy::{PolicyAction, PolicyPlan};
use runx_cli::registry::{RegistryAction, RegistryPlan};
use runx_cli::skill::SkillPlan;
use std::fs;
use std::path::{Path, PathBuf};

fn plan(args: &[&str]) -> LauncherAction {
    plan_launcher(args.iter().map(std::ffi::OsString::from).collect())
}

#[test]
fn top_level_help_and_version_are_native() {
    assert_eq!(plan(&[]), LauncherAction::PrintHelp);
    assert_eq!(plan(&["--help"]), LauncherAction::PrintHelp);
    assert_eq!(plan(&["--version"]), LauncherAction::PrintVersion);
    assert_eq!(plan(&["export", "--help"]), LauncherAction::PrintHelp);

    let help = help_text();
    assert_help_line(
        &help,
        "runx verify [receipt-id] [--receipt-dir dir] [--receipt <path|->] [--notary <path|-> --notary-key trusted.pem] [--json]",
    );
    assert_help_line(
        &help,
        "runx skill <skill-ref|owner/name@version|skill-dir|SKILL.md> [--registry url|path] [--digest sha256] [--input key=value] [--runner name] [--flag value] [--receipt-dir dir] [--run-id id --answers file] [--json]",
    );
    assert_help_line(
        &help,
        "runx add <skill-ref|github-url> [--registry url|path] [--version version] [--ref git-ref] [--digest sha256] [--to dir] [--installation-id id] [--api-base-url url] [--json]",
    );
    assert_help_line(&help, "runx parser eval --input <file|-> --json");
    assert_help_line(
        &help,
        "runx harness <fixture.yaml...|skill-dir|SKILL.md> [--receipt-dir dir] [--json]",
    );
    assert_help_line(&help, "runx doctor [path|authority|registry] [--json]");
    assert_help_line(
        &help,
        "runx export <claude|codex> [skill-ref...] [--project] [--json]",
    );
    assert_help_line(
        &help,
        "runx login [--provider github|google|gitlab] [--api-base-url url] [--allow-local-api] [--json]",
    );
    assert!(
        !help.contains("runx connect"),
        "native OSS help must not advertise the removed connect brokerage surface"
    );
    assert!(
        !help.contains("runx harness <fixture.yaml|skill-dir|SKILL.md>"),
        "native help must not advertise harness target forms that only the old TypeScript path handled"
    );
    assert!(
        !help.contains("runx url-add"),
        "native help must not advertise the internal URL index command"
    );
}

#[test]
fn nested_skill_history_verify_and_publish_help_are_native() {
    assert_eq!(plan(&["skill", "--help"]), LauncherAction::PrintSkillHelp);
    assert_eq!(plan(&["skill", "-h"]), LauncherAction::PrintSkillHelp);
    assert_eq!(
        plan(&["skill", "SKILL.md", "--help"]),
        LauncherAction::PrintSkillHelp
    );
    assert_eq!(
        plan(&["history", "--help"]),
        LauncherAction::PrintHistoryHelp
    );
    assert_eq!(plan(&["history", "-h"]), LauncherAction::PrintHistoryHelp);
    assert_eq!(
        plan(&["history", "sourcey", "--help"]),
        LauncherAction::PrintHistoryHelp
    );
    assert_eq!(plan(&["verify", "--help"]), LauncherAction::PrintVerifyHelp);
    assert_eq!(plan(&["verify", "-h"]), LauncherAction::PrintVerifyHelp);
    assert_eq!(
        plan(&["verify", "receipt-123", "--help"]),
        LauncherAction::PrintVerifyHelp
    );
    assert_eq!(
        plan(&["publish", "--help"]),
        LauncherAction::PrintPublishHelp
    );
    assert_eq!(plan(&["publish", "-h"]), LauncherAction::PrintPublishHelp);

    assert_help_line(
        &skill_help_text(),
        "runx skill <skill-ref|owner/name@version|skill-dir|SKILL.md> [--registry url|path] [--digest sha256] [--input key=value] [--runner name] [--flag value] [--receipt-dir dir] [--run-id id --answers file] [--json]",
    );
    assert_help_line(
        &history_help_text(),
        "runx history [query] [--skill s] [--status s] [--source s] [--actor a] [--artifact-type t] [--since iso] [--until iso] [--receipt-dir dir] [--json]",
    );
    assert_help_line(
        &verify_help_text(),
        "runx verify [receipt-id] [--receipt-dir dir] [--receipt <path|->] [--notary <path|-> --notary-key trusted.pem] [--json]",
    );
    assert_help_line(
        &publish_help_text(),
        "runx publish <receipt.json> [--api-base-url url] [--token token] [--allow-local-api] [--json]",
    );
}

#[test]
fn routes_login_to_native_plan() {
    assert_eq!(
        plan(&[
            "login",
            "--provider",
            "github",
            "--api-base-url",
            "https://runx.test",
            "--json",
        ]),
        LauncherAction::RunLogin(LoginPlan {
            provider: Some("github".to_owned()),
            api_base_url: Some("https://runx.test".to_owned()),
            allow_local_api: false,
            json: true,
        })
    );
    assert_eq!(
        plan(&["login", "--unknown"]),
        LauncherAction::Error("unknown login flag --unknown".to_owned())
    );
}

#[test]
fn routes_doctor_registry_to_native_plan() {
    assert_eq!(
        plan(&["doctor", "registry", "--json"]),
        LauncherAction::RunDoctor(DoctorPlan {
            mode: DoctorMode::Registry,
            path: None,
            json: true,
        })
    );
    assert_eq!(
        plan(&["doctor", "registry", "workspace"]),
        LauncherAction::Error("runx doctor registry does not accept a path".to_owned())
    );
}

#[test]
fn removed_launcher_shim_flags_fail_closed() {
    assert_eq!(
        plan(&["--shim-help"]),
        LauncherAction::Error("unknown command --shim-help".to_owned())
    );
    assert_eq!(
        plan(&["--shim-version"]),
        LauncherAction::Error("unknown command --shim-version".to_owned())
    );
}

#[test]
fn routes_mcp_serve_to_native_plan() {
    assert_eq!(
        plan(&[
            "mcp",
            "serve",
            "fixtures/skills/echo",
            "--receipt-dir=receipts",
            "--runner",
            "default",
        ]),
        LauncherAction::RunMcp(McpPlan {
            refs: vec![PathBuf::from("fixtures/skills/echo")],
            receipt_dir: Some(PathBuf::from("receipts")),
            runner: Some("default".to_owned()),
            http_listen: None,
            http_allow_non_loopback: false,
        })
    );
}

#[test]
fn mcp_http_listen_defaults_to_loopback_and_requires_explicit_non_loopback_opt_in() {
    assert_eq!(
        plan(&["mcp", "serve", "fixtures/skills/echo", "--http-listen"]),
        LauncherAction::RunMcp(McpPlan {
            refs: vec![PathBuf::from("fixtures/skills/echo")],
            receipt_dir: None,
            runner: None,
            http_listen: Some("127.0.0.1:8080".to_owned()),
            http_allow_non_loopback: false,
        })
    );
    assert_eq!(
        plan(&[
            "mcp",
            "serve",
            "fixtures/skills/echo",
            "--http-listen=0.0.0.0:8080",
            "--http-allow-non-loopback",
        ]),
        LauncherAction::RunMcp(McpPlan {
            refs: vec![PathBuf::from("fixtures/skills/echo")],
            receipt_dir: None,
            runner: None,
            http_listen: Some("0.0.0.0:8080".to_owned()),
            http_allow_non_loopback: true,
        })
    );
}

#[test]
fn mcp_rejects_unknown_shapes_without_delegating() {
    assert_eq!(
        plan(&["mcp", "serve", "fixtures/skills/echo", "--legacy-js-only"]),
        LauncherAction::Error("unknown mcp serve flag --legacy-js-only".to_owned())
    );
    assert_eq!(
        plan(&["mcp", "--runner=default", "serve", "fixtures/skills/echo"]),
        LauncherAction::Error("runx mcp --runner must follow the serve subcommand".to_owned())
    );
}

#[test]
fn routes_harness_to_native_runner() {
    assert_eq!(
        plan(&["harness", "fixtures/harness/echo-skill.yaml", "--json"]),
        LauncherAction::RunHarness(HarnessPlan {
            fixture_paths: vec!["fixtures/harness/echo-skill.yaml".into()],
            receipt_dir: None,
        })
    );
}

#[test]
fn routes_multiple_harness_fixtures_to_native_runner() {
    assert_eq!(
        plan(&[
            "harness",
            "fixtures/harness/echo-skill.yaml",
            "fixtures/harness/sequential-graph.yaml",
            "--json",
        ]),
        LauncherAction::RunHarness(HarnessPlan {
            fixture_paths: vec![
                "fixtures/harness/echo-skill.yaml".into(),
                "fixtures/harness/sequential-graph.yaml".into(),
            ],
            receipt_dir: None,
        })
    );
}

#[test]
fn harness_rejects_missing_fixture_path() {
    assert_eq!(
        plan(&["harness"]),
        LauncherAction::Error("runx harness requires a fixture path or skill package".to_owned())
    );
}

#[test]
fn routes_canonical_skill_run_to_native_plan() {
    assert_eq!(
        plan(&[
            "skill",
            "skills/issue-intake",
            "--runner",
            "intake",
            "--receipt-dir",
            ".runx/receipts",
            "--run-id",
            "run_agent_task.issue-intake.output",
            "--answers",
            "/tmp/answers.json",
            "--json",
            "--non-interactive",
            "--input",
            "severity=low",
            "--thread-title",
            "Docs bug",
        ]),
        LauncherAction::RunSkill(SkillPlan {
            skill_path: PathBuf::from("skills/issue-intake"),
            runner: Some("intake".to_owned()),
            receipt_dir: Some(PathBuf::from(".runx/receipts")),
            run_id: Some("run_agent_task.issue-intake.output".to_owned()),
            answers: Some(PathBuf::from("/tmp/answers.json")),
            registry: None,
            expected_digest: None,
            json: true,
            inputs: [
                (
                    "thread_title".to_owned(),
                    runx_contracts::JsonValue::String("Docs bug".to_owned()),
                ),
                (
                    "severity".to_owned(),
                    runx_contracts::JsonValue::String("low".to_owned()),
                )
            ]
            .into_iter()
            .collect(),
            local_credential: None,
        })
    );
}

#[test]
fn skill_rejects_partial_continuation_shape() {
    assert_eq!(
        plan(&["skill", "skills/issue-intake", "--run-id", "run_123"]),
        LauncherAction::Error("runx skill --run-id requires --answers".to_owned())
    );
    assert_eq!(
        plan(&[
            "skill",
            "skills/issue-intake",
            "--answers",
            "/tmp/answers.json",
        ]),
        LauncherAction::Error("runx skill --answers requires --run-id".to_owned())
    );
}

#[test]
fn skill_rejects_resolver_flags_for_management_actions() {
    for action in ["inspect", "publish", "search", "validate"] {
        assert_eq!(
            plan(&["skill", action, "--registry", "fixtures/registry"]),
            LauncherAction::Error(
                "runx skill --registry and --digest are only supported when running a skill ref"
                    .to_owned()
            ),
            "{action}"
        );
        assert_eq!(
            plan(&["skill", action, "--digest", "sha256:abc"]),
            LauncherAction::Error(
                "runx skill --registry and --digest are only supported when running a skill ref"
                    .to_owned()
            ),
            "{action}"
        );
    }
}

#[test]
fn rejects_legacy_skill_add_shape() {
    assert_eq!(
        plan(&["skill", "add", "acme/sourcey@1.0.0"]),
        LauncherAction::Error("runx skill add has been removed; use runx add <ref>".to_owned())
    );
    assert_eq!(
        plan(&["skill", "add", "acme/sourcey@1.0.0", "--json"]),
        LauncherAction::JsonError(JsonErrorPlan {
            message: "runx skill add has been removed; use runx add <ref>".to_owned(),
            code: "invalid_args".to_owned(),
            exit_code: 64,
        })
    );
}

#[test]
fn connect_surface_is_removed_from_oss_launcher() {
    assert_eq!(
        plan(&["connect", "--json"]),
        LauncherAction::Error("unknown command connect".to_owned())
    );
    assert_eq!(
        plan(&["url-add", "github.com/kam/skills"]),
        LauncherAction::Error("unknown command url-add".to_owned())
    );
}

#[test]
fn routes_export_to_native_plan() {
    assert_eq!(
        plan(&["export", "claude", "brand-voice", "--project", "--json"]),
        LauncherAction::RunExport(ExportPlan {
            target: Target::Claude,
            refs: vec!["brand-voice".to_owned()],
            project: true,
            json: true,
        })
    );
    assert_eq!(
        plan(&["export", "codex"]),
        LauncherAction::RunExport(ExportPlan {
            target: Target::Codex,
            refs: Vec::new(),
            project: false,
            json: false,
        })
    );
}

#[test]
fn export_rejects_unknown_target_and_flags() {
    assert_eq!(
        plan(&["export", "vscode"]),
        LauncherAction::Error("runx export target must be claude or codex, got vscode".to_owned())
    );
    assert_eq!(
        plan(&["export", "claude", "--project=true"]),
        LauncherAction::Error("--project does not take a value".to_owned())
    );
}

#[test]
fn routes_config_to_native_plan() {
    assert_eq!(
        plan(&["config", "set", "agent.model", "gpt-test", "--json"]),
        LauncherAction::RunConfig(ConfigPlan {
            action: ConfigAction::Set,
            key: Some("agent.model".to_owned()),
            value: Some("gpt-test".to_owned()),
            json: true,
        })
    );
}

#[test]
fn routes_policy_to_native_plan_and_rejects_unknown_subcommands() {
    assert_eq!(
        plan(&[
            "policy",
            "inspect",
            "fixtures/operational-policy/nitrosend-like.json",
            "--json",
        ]),
        LauncherAction::RunPolicy(PolicyPlan {
            action: PolicyAction::Inspect,
            path: PathBuf::from("fixtures/operational-policy/nitrosend-like.json"),
            json: true,
        })
    );
    assert_eq!(
        plan(&["policy", "apply"]),
        LauncherAction::Error("unknown policy subcommand apply".to_owned())
    );
}

#[test]
fn routes_kernel_to_native_plan_and_rejects_unknown_subcommands() {
    assert_eq!(
        plan(&["kernel", "eval", "--input=-", "--json"]),
        LauncherAction::RunKernel(KernelPlan {
            input: KernelInputSource::Stdin,
            json: true,
        })
    );
    assert_eq!(
        plan(&["kernel", "trace"]),
        LauncherAction::Error("unknown kernel subcommand trace".to_owned())
    );
}

#[test]
fn routes_parser_to_native_plan_and_rejects_unknown_subcommands() {
    assert_eq!(
        plan(&["parser", "eval", "--input=-", "--json"]),
        LauncherAction::RunParser(ParserPlan {
            input: ParserInputSource::Stdin,
            json: true,
        })
    );
    assert_eq!(
        plan(&["parser", "trace"]),
        LauncherAction::Error("unknown parser subcommand trace".to_owned())
    );
}

#[test]
fn routes_doctor_history_list_new_and_init_to_native_plans() {
    assert_eq!(
        plan(&[
            "doctor",
            "fixtures/doctor/empty-success/workspace",
            "--json"
        ]),
        LauncherAction::RunDoctor(DoctorPlan {
            mode: DoctorMode::Workspace,
            path: Some(PathBuf::from("fixtures/doctor/empty-success/workspace")),
            json: true,
        })
    );
    assert_eq!(
        plan(&["doctor", "authority", "--json"]),
        LauncherAction::RunDoctor(DoctorPlan {
            mode: DoctorMode::Authority,
            path: None,
            json: true,
        })
    );
    assert_eq!(
        plan(&["history", "sourcey", "--json"]),
        LauncherAction::RunHistory(HistoryPlan {
            args: vec!["history".into(), "sourcey".into(), "--json".into()],
        })
    );
    assert_eq!(
        plan(&["list", "packets", "--ok-only", "--json"]),
        LauncherAction::RunList(ListPlan {
            kind: ListKind::Packets,
            filter: FilterMode::OkOnly,
            json: true,
        })
    );
    assert_eq!(
        plan(&["new", "docs-demo", "--directory", "tmp/docs-demo", "--json"]),
        LauncherAction::RunNew(NewPlan {
            name: "docs-demo".to_owned(),
            directory: Some(PathBuf::from("tmp/docs-demo")),
            json: true,
        })
    );
    assert_eq!(
        plan(&["init", "-g", "--prefetch", "official", "--json"]),
        LauncherAction::RunInit(InitPlan {
            global: true,
            prefetch_official: true,
            json: true,
        })
    );
}

#[test]
fn routes_dev_to_native_plan_with_scaffolded_lane_shape() {
    assert_eq!(
        plan(&["dev", "--lane", "deterministic", "--json"]),
        LauncherAction::RunDev(DevPlan {
            root: None,
            lane: Some("deterministic".to_owned()),
            json: true,
        })
    );
    assert_eq!(
        plan(&["dev", "packages/demo", "--lane=all"]),
        LauncherAction::RunDev(DevPlan {
            root: Some(PathBuf::from("packages/demo")),
            lane: Some("all".to_owned()),
            json: false,
        })
    );
}

#[test]
fn dev_rejects_unknown_shapes_without_delegating() {
    assert_eq!(
        plan(&["dev", "--lane"]),
        LauncherAction::Error("--lane requires a value".to_owned())
    );
    assert_eq!(
        plan(&["dev", "--watch"]),
        LauncherAction::Error("unknown dev flag --watch".to_owned())
    );
    assert_eq!(
        plan(&["dev", "one", "two"]),
        LauncherAction::Error("runx dev accepts at most one root path".to_owned())
    );
}

#[test]
fn unsupported_doctor_and_list_shapes_fail_closed() {
    assert_eq!(
        plan(&["doctor", "--fix"]),
        LauncherAction::Error("unknown doctor flag --fix".to_owned())
    );
    assert_eq!(
        plan(&["doctor", "authority", "workspace"]),
        LauncherAction::Error("runx doctor authority does not accept a path".to_owned())
    );
    assert_eq!(
        plan(&["list", "skills", "--source", "registry"]),
        LauncherAction::Error("unknown list flag --source".to_owned())
    );
}

#[test]
fn routes_registry_to_native_plan() {
    assert_eq!(
        plan(&[
            "registry",
            "search",
            "echo",
            "--registry-dir",
            "/tmp/runx-registry",
            "--limit",
            "10",
            "--json",
        ]),
        LauncherAction::RunRegistry(RegistryPlan {
            action: RegistryAction::Search,
            subject: "echo".to_owned(),
            registry: None,
            registry_dir: Some(PathBuf::from("/tmp/runx-registry")),
            version: None,
            expected_digest: None,
            destination: None,
            installation_id: None,
            owner: None,
            profile: None,
            trust_tier: None,
            limit: Some(10),
            upsert: false,
            json: true,
        })
    );
}

#[test]
fn routes_add_to_native_plan() {
    assert_eq!(
        plan(&[
            "add",
            "acme/sourcey@1.0.0",
            "--registry",
            "https://runx.example.test",
            "--to",
            "skills",
            "--digest",
            "sha256:abc",
            "--installation-id",
            "inst_123",
            "--json",
        ]),
        LauncherAction::RunRegistry(RegistryPlan {
            action: RegistryAction::Install,
            subject: "acme/sourcey@1.0.0".to_owned(),
            registry: Some("https://runx.example.test".to_owned()),
            registry_dir: None,
            version: None,
            expected_digest: Some("sha256:abc".to_owned()),
            destination: Some(PathBuf::from("skills")),
            installation_id: Some("inst_123".to_owned()),
            owner: None,
            profile: None,
            trust_tier: None,
            limit: None,
            upsert: false,
            json: true,
        })
    );
    assert_eq!(
        plan(&[
            "add",
            "github.com/kam/skills",
            "--ref",
            "main",
            "--api-base-url",
            "https://api.runx.test",
            "--json",
        ]),
        LauncherAction::RunUrlAdd(UrlAddPlan {
            repo: "github.com/kam/skills".to_owned(),
            repo_ref: Some("main".to_owned()),
            api_base_url: Some("https://api.runx.test".to_owned()),
            json: true,
        })
    );
    assert_eq!(
        plan(&["add", "github.com/kam/skills", "--version", "main"]),
        LauncherAction::Error(
            "runx add <github-url> uses --ref for git refs, not --version".to_owned()
        )
    );
    assert_eq!(
        plan(&[
            "add",
            "github.com/kam/skills",
            "--version",
            "main",
            "--json"
        ]),
        LauncherAction::JsonError(JsonErrorPlan {
            message: "runx add <github-url> uses --ref for git refs, not --version".to_owned(),
            code: "invalid_args".to_owned(),
            exit_code: 64,
        })
    );
}

#[test]
fn routes_tool_to_native_plan_and_rejects_unknown_subcommands() {
    assert_eq!(
        plan(&["tool", "build", "tools/docs/echo", "--json"]),
        LauncherAction::RunTool(ToolPlan {
            action: ToolAction::Build,
            path: Some(PathBuf::from("tools/docs/echo")),
            ref_or_query: None,
            all: false,
            source: None,
            json: true,
        })
    );
    assert_eq!(
        plan(&[
            "tool",
            "search",
            "echo",
            "writer",
            "--source",
            "fixture-mcp",
            "--json",
        ]),
        LauncherAction::RunTool(ToolPlan {
            action: ToolAction::Search,
            path: None,
            ref_or_query: Some("echo writer".to_owned()),
            all: false,
            source: Some("fixture-mcp".to_owned()),
            json: true,
        })
    );
    assert_eq!(
        plan(&["tool", "publish", "fixture.echo"]),
        LauncherAction::Error("unknown tool subcommand publish".to_owned())
    );
}

#[test]
fn native_launcher_argument_errors_exit_with_usage_code() -> Result<(), Box<dyn std::error::Error>>
{
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_runx"))
        .args(["policy", "inspect", "--json"])
        .output()?;

    assert_eq!(output.status.code(), Some(64));
    assert!(
        String::from_utf8(output.stderr)?
            .contains("runx policy inspect|lint requires exactly one policy path")
    );
    Ok(())
}

#[test]
fn mcp_runner_before_serve_fails_closed_in_native_binary() -> Result<(), Box<dyn std::error::Error>>
{
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_runx"))
        .env("RUNX_RUST_CLI", "1")
        .env("RUNX_JS_BIN", repo_root()?.join("packages/cli/bin/runx"))
        .env("RUNX_NPM_PACKAGE", "@runxhq/cli@0.5.22")
        .args(["mcp", "--runner=default", "serve", "fixtures/skills/echo"])
        .output()?;

    assert_eq!(output.status.code(), Some(64));
    assert!(
        String::from_utf8(output.stderr)?
            .contains("runx mcp --runner must follow the serve subcommand")
    );
    Ok(())
}

#[test]
fn package_manifest_is_native_binary_shaped() -> Result<(), Box<dyn std::error::Error>> {
    let package_json = fs::read_to_string(repo_root()?.join("packages/cli/package.json"))?;
    let manifest = serde_json::from_str::<serde_json::Value>(&package_json)?;
    assert_eq!(manifest["bin"]["runx"], "./bin/runx");
    assert_eq!(
        manifest["files"],
        serde_json::json!(["LICENSE", "bin/runx", "native/supported-platforms.json"])
    );
    assert!(manifest.get("main").is_none());
    assert!(manifest.get("types").is_none());
    assert!(manifest.get("dependencies").is_none());
    assert!(manifest.get("exports").is_none());
    assert!(manifest.get("scripts").is_none());
    assert_not_contains(&package_json, "workspace:");
    assert_not_contains(&package_json, "runtime-local");
    Ok(())
}

fn repo_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?)
}

fn assert_help_line(help: &str, expected: &str) {
    assert!(
        help.lines().any(|line| line.trim() == expected),
        "missing help line: {expected}"
    );
}

fn assert_not_contains(contents: &str, needle: &str) {
    assert!(
        !contents.contains(needle),
        "packaged CLI must not contain {needle}"
    );
}

// rust-style-allow: large-file - router argument parity is centralized for CLI routing tests.
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use crate::cli_args::{flag_value, optional_flag_value, os_arg, split_flag};
use crate::config::ConfigPlan;
use crate::export::ExportPlan;
use crate::kernel::{KernelInputSource, KernelPlan};
use crate::login::LoginPlan;
use crate::mcp::McpPlan;
use crate::parser::{ParserInputSource, ParserPlan};
use crate::payment::{PaymentAction, PaymentAdmissionPlan, PaymentInputSource, PaymentPlan};
use crate::policy::{PolicyAction, PolicyPlan};
use crate::publish::PublishPlan;
use crate::registry::{RegistryAction, RegistryPlan};
use crate::resume::ResumePlan;
use crate::skill::SkillPlan;

#[derive(Debug, PartialEq)]
pub enum RouterAction {
    Error(String),
    JsonError(JsonErrorPlan),
    RunDev(DevPlan),
    RunDoctor(DoctorPlan),
    RunExport(ExportPlan),
    RunInit(InitPlan),
    RunList(ListPlan),
    RunLogin(LoginPlan),
    RunMcp(McpPlan),
    RunParser(ParserPlan),
    RunNew(NewPlan),
    RunHistory(HistoryPlan),
    RunVerify(VerifyPlan),
    RunHarness(HarnessPlan),
    RunKernel(KernelPlan),
    RunPayment(PaymentPlan),
    RunConfig(ConfigPlan),
    RunPolicy(PolicyPlan),
    RunPublish(PublishPlan),
    RunRegistry(RegistryPlan),
    RunResume(ResumePlan),
    RunSkill(SkillPlan),
    RunTool(ToolPlan),
    RunAddUrl(AddUrlPlan),
    PrintHelp,
    PrintAddHelp,
    PrintHistoryHelp,
    PrintListHelp,
    PrintLoginHelp,
    PrintPublishHelp,
    PrintRegistryHelp,
    PrintRegistryUsageError,
    PrintResumeHelp,
    PrintSkillHelp,
    PrintVerifyHelp,
    PrintVersion,
}

#[derive(Debug, Eq, PartialEq)]
pub struct JsonErrorPlan {
    pub message: String,
    pub code: String,
    pub exit_code: u8,
}

/// Arguments for indexing a GitHub repository via `runx add <github-url>`.
#[derive(Debug, Eq, PartialEq)]
pub struct AddUrlPlan {
    pub repo: String,
    pub repo_ref: Option<String>,
    pub api_base_url: Option<String>,
    pub json: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub struct DevPlan {
    pub root: Option<PathBuf>,
    pub lane: Option<String>,
    pub json: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub struct HarnessPlan {
    /// Replay targets: standalone fixture `.yaml` files, or a skill package
    /// (directory / `SKILL.md`) whose declared inline `harness.cases` are run.
    pub fixture_paths: Vec<OsString>,
    /// Where receipts the cases seal are written (`--receipt-dir`).
    pub receipt_dir: Option<OsString>,
}

#[derive(Debug, Eq, PartialEq)]
pub struct HistoryPlan {
    pub args: Vec<OsString>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifyPlan {
    pub args: Vec<OsString>,
}

#[derive(Debug, Eq, PartialEq)]
pub struct DoctorPlan {
    pub mode: DoctorMode,
    pub path: Option<PathBuf>,
    pub json: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub enum DoctorMode {
    Workspace,
    Authority,
    Registry,
}

#[derive(Debug, Eq, PartialEq)]
pub struct ListPlan {
    pub kind: ListKind,
    pub filter: FilterMode,
    pub json: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum FilterMode {
    #[default]
    All,
    OkOnly,
    InvalidOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ListKind {
    All,
    Tools,
    Skills,
    Graphs,
    Packets,
    Overlays,
}

#[derive(Debug, Eq, PartialEq)]
pub struct NewPlan {
    pub name: String,
    pub directory: Option<PathBuf>,
    pub json: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub struct InitPlan {
    pub global: bool,
    pub prefetch_official: bool,
    pub json: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub struct ToolPlan {
    pub action: ToolAction,
    pub path: Option<PathBuf>,
    pub ref_or_query: Option<String>,
    pub all: bool,
    pub source: Option<String>,
    pub json: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub enum ToolAction {
    Build,
    Search,
    Inspect,
}

// rust-style-allow: long-function because router routing is the cutover gate:
// every native command branch and fail-closed decision is reviewed here.
pub fn route_args(args: Vec<OsString>) -> RouterAction {
    if args.is_empty() || single_arg_is(&args, "--help") || single_arg_is(&args, "-h") {
        return RouterAction::PrintHelp;
    }

    if single_arg_is(&args, "--version") || single_arg_is(&args, "-V") {
        return RouterAction::PrintVersion;
    }

    if first_arg_is(&args, "harness") {
        return native_harness_plan(&args);
    }

    if first_arg_is(&args, "config") {
        return crate::config::parse_config_plan(&args)
            .map_or_else(RouterAction::Error, RouterAction::RunConfig);
    }

    if first_arg_is(&args, "login") {
        if nested_help_requested(&args) {
            return RouterAction::PrintLoginHelp;
        }
        return crate::login::parse_login_plan(&args)
            .map_or_else(RouterAction::Error, RouterAction::RunLogin);
    }

    if first_arg_is(&args, "policy") {
        return parse_policy_plan(&args).map_or_else(RouterAction::Error, RouterAction::RunPolicy);
    }

    if first_arg_is(&args, "publish") {
        if nested_help_requested(&args) {
            return RouterAction::PrintPublishHelp;
        }
        return crate::publish::parse_publish_plan(&args)
            .map_or_else(RouterAction::Error, RouterAction::RunPublish);
    }

    if first_arg_is(&args, "kernel") {
        return parse_kernel_plan(&args).map_or_else(RouterAction::Error, RouterAction::RunKernel);
    }

    if first_arg_is(&args, "payment") {
        return parse_payment_plan(&args)
            .map_or_else(RouterAction::Error, RouterAction::RunPayment);
    }

    if first_arg_is(&args, "parser") {
        return parse_parser_plan(&args).map_or_else(RouterAction::Error, RouterAction::RunParser);
    }

    if first_arg_is(&args, "doctor") {
        return parse_doctor_plan(&args).map_or_else(RouterAction::Error, RouterAction::RunDoctor);
    }

    if first_arg_is(&args, "dev") {
        return parse_dev_plan(&args).map_or_else(RouterAction::Error, RouterAction::RunDev);
    }

    if first_arg_is(&args, "export") {
        if args.len() == 2
            && args
                .get(1)
                .and_then(|arg| arg.to_str())
                .is_some_and(|arg| matches!(arg, "--help" | "-h"))
        {
            return RouterAction::PrintHelp;
        }
        return crate::export::parse_export_plan(&args)
            .map_or_else(RouterAction::Error, RouterAction::RunExport);
    }

    if first_arg_is(&args, "list") {
        if nested_help_requested(&args) {
            return RouterAction::PrintListHelp;
        }
        return parse_list_plan(&args).map_or_else(RouterAction::Error, RouterAction::RunList);
    }

    if first_arg_is(&args, "new") {
        return parse_new_plan(&args).map_or_else(RouterAction::Error, RouterAction::RunNew);
    }

    if first_arg_is(&args, "init") {
        return parse_init_plan(&args).map_or_else(RouterAction::Error, RouterAction::RunInit);
    }

    if first_arg_is(&args, "history") {
        if nested_help_requested(&args) {
            return RouterAction::PrintHistoryHelp;
        }
        return RouterAction::RunHistory(HistoryPlan { args });
    }

    if first_arg_is(&args, "resume") {
        if nested_help_requested(&args) {
            return RouterAction::PrintResumeHelp;
        }
        return crate::resume::parse_resume_plan(&args).map_or_else(
            |message| json_or_human_error(&args, message),
            RouterAction::RunResume,
        );
    }

    if first_arg_is(&args, "verify") {
        if nested_help_requested(&args) {
            return RouterAction::PrintVerifyHelp;
        }
        return RouterAction::RunVerify(VerifyPlan { args });
    }

    if first_arg_is(&args, "mcp") {
        if mcp_runner_before_serve(&args) {
            return RouterAction::Error(
                "runx mcp --runner must follow the serve subcommand".to_owned(),
            );
        }
        return crate::mcp::parse_mcp_plan(&args)
            .map_or_else(RouterAction::Error, RouterAction::RunMcp);
    }

    if first_arg_is(&args, "tool") {
        return parse_tool_plan(&args).map_or_else(RouterAction::Error, RouterAction::RunTool);
    }

    if first_arg_is(&args, "registry") {
        if nested_help_requested(&args) {
            return RouterAction::PrintRegistryHelp;
        }
        if args.len() == 1 {
            return RouterAction::PrintRegistryUsageError;
        }
        return parse_registry_plan(&args).map_or_else(
            |message| json_or_human_error(&args, message),
            RouterAction::RunRegistry,
        );
    }

    if first_arg_is(&args, "add") {
        if nested_help_requested(&args) {
            return RouterAction::PrintAddHelp;
        }
        return parse_add_plan(&args).unwrap_or_else(|message| json_or_human_error(&args, message));
    }

    if first_arg_is(&args, "skill") {
        if nested_help_requested(&args) {
            return RouterAction::PrintSkillHelp;
        }
        if second_arg_is(&args, "add") {
            return json_or_human_error(
                &args,
                "runx skill add has been removed; use runx add <ref>".to_owned(),
            );
        }
        return crate::skill::parse_skill_plan(&args).map_or_else(
            |message| json_or_human_error(&args, message),
            RouterAction::RunSkill,
        );
    }

    RouterAction::Error(format!(
        "unknown command {}",
        args.first()
            .and_then(|arg| arg.to_str())
            .unwrap_or("<non-utf8>")
    ))
}

pub fn help_text() -> String {
    "\
runx

Usage:
  runx <command> [args]
  runx --help
  runx --version

Commands:
  runx new <name> [--directory dir] [--json]
  runx init [-g|--global] [--prefetch official] [--json]
  runx verify [receipt-id] [--receipt-dir dir] [--receipt <path|->] [--notary <path|-> --notary-key trusted.pem] [-j|--json]
  runx history [query] [--skill s] [--status s] [--source s] [--actor a] [--artifact-type t] [--since iso] [--until iso] [--receipt-dir dir] [--json]
  runx resume <run-id> <answers.json> [-R dir] [-j|--json]
  runx list [tools|skills|graphs|packets|overlays] [--ok-only|--invalid-only] [-j|--json]
  runx login [--provider github|google|gitlab] [--for default|publish] [--api-url url] [--local-api] [-j|--json]
  runx config set|get|list [provider|model|api-key|public-token] [value] [-j|--json]
  runx policy inspect|lint <policy.json> [--json]
  runx publish <receipt.json> [--api-url url] [--token token] [--local-api] [-j|--json]
  runx kernel eval --input <file|-> --json
  runx payment admission issue --input <file|-> --json
  runx parser eval --input <file|-> --json
  runx doctor [path|authority|registry] [--json]
  runx dev [root] [--lane lane] [--json]
  runx export <claude|codex> [skill-ref...] [--project] [--json]
  runx mcp serve <skill-ref...> [--receipt-dir dir] [--http-listen [addr]] [--http-allow-non-loopback]
  runx skill <skill-ref|owner/name@version|skill-dir|SKILL.md> [runner] [-p profile] [-i key=value] [--input-json key=json] [-j] [--registry url|path] [--digest sha256] [--flag value] [--credential descriptor --secret-env NAME] [-R dir]
  runx skill inspect <skill-ref|owner/name@version|skill-dir|SKILL.md> [runner] [-j] [--registry url|path] [--digest sha256]
  runx add <skill-ref|github-url> [--registry url|path] [--version version] [--ref git-ref] [--digest sha256] [--to dir] [--api-base-url url] [--json]
  runx harness <fixture.yaml...|skill-dir|SKILL.md> [-R dir] [-j|--json]
  runx tool build <tool-dir>|--all [--json]
  runx tool search <query> [--source source] [--json]
  runx tool inspect <ref> [--source source] [--json]
  runx registry search|read|resolve|install|publish ... --json
"
    .to_owned()
}

pub fn history_help_text() -> String {
    "\
runx history

Usage:
  runx history [query] [--skill s] [--status s] [--source s] [--actor a] [--artifact-type t] [--since iso] [--until iso] [--receipt-dir dir] [--json]

Options:
  --skill s
  --status s
  --source s
  --actor a
  --artifact-type t
  --since iso
  --until iso
  --receipt-dir dir
  --json
"
    .to_owned()
}

pub fn resume_help_text() -> String {
    "\
runx resume

Usage:
  runx resume <run-id> <answers.json> [-R dir] [-j|--json]

Options:
  -R, --receipts dir
  --receipt-dir dir
  -j, --json
"
    .to_owned()
}

pub fn list_help_text() -> String {
    "\
runx list

Usage:
  runx list [tools|skills|graphs|packets|overlays] [--ok-only|--invalid-only] [-j|--json]

Options:
  --ok-only
  --invalid-only
  -j, --json
"
    .to_owned()
}

pub fn login_help_text() -> String {
    "\
runx login

Usage:
  runx login [--provider github|google|gitlab] [--for default|publish] [--api-url url] [--local-api] [-j|--json]

Options:
  --provider provider
  --for purpose
  --api-url url
  --api-base-url url
  --local-api
  -j, --json
"
    .to_owned()
}

pub fn publish_help_text() -> String {
    "\
runx publish

Usage:
  runx publish <receipt.json> [--api-url url] [--token token] [--local-api] [-j|--json]

Options:
  --api-url url       Public API base URL (default: RUNX_PUBLIC_API_BASE_URL or https://api.runx.ai)
  --api-base-url url  Alias for --api-url
  --token token       Public API token (default: RUNX_PUBLIC_API_TOKEN or runx login)
  --local-api         Allow loopback/private public API URLs for local dogfood only
  --allow-local-api   Alias for --local-api
  -j, --json          Print the raw notary response as JSON
"
    .to_owned()
}

pub fn add_help_text() -> String {
    "\
runx add

Usage:
  runx add <skill-ref|github-url> [--registry url|path] [--version version] [--ref git-ref] [--digest sha256] [--to dir] [--api-base-url url] [--json]

Options:
  --registry url|path  Registry URL or local registry path for skill refs
  --version version    Registry version for skill refs
  --ref git-ref        Git ref for GitHub repository URLs
  --digest sha256      Expected package digest for skill refs
  --to dir             Install destination for skill refs
  --api-base-url url   Hosted index API for GitHub repository URLs
  -j, --json
"
    .to_owned()
}

pub fn registry_help_text() -> String {
    "\
runx registry

Usage:
  runx registry search <query> [--registry url|path] [--registry-dir dir] [--limit n] [-j|--json]
  runx registry read <ref> [--registry url|path] [--registry-dir dir] [--version version] [-j|--json]
  runx registry resolve <ref> [--registry url|path] [--registry-dir dir] [--version version] [-j|--json]
  runx registry install <ref> [--registry url|path] [--registry-dir dir] [--version version] [--digest sha256] [--to dir] [-j|--json]
  runx registry publish <SKILL.md|skill-dir> [--registry url|path] [--owner owner] [--version version] [--profile X.yaml] [--trust-tier tier] [--upsert] [-j|--json]

Options:
  --registry url|path
  --registry-dir dir
  --version version
  --digest sha256
  --to dir
  --owner owner
  --profile X.yaml
  --trust-tier first_party|verified|community
  --limit n
  --upsert
  -j, --json
"
    .to_owned()
}

pub fn verify_help_text() -> String {
    "\
runx verify

Usage:
  runx verify [receipt-id] [--receipt-dir dir] [--receipt <path|->] [--notary <path|-> --notary-key trusted.pem] [-j|--json]

Options:
  --receipt-dir dir
  --receipt <path|->
  --notary <path|->
  --notary-key trusted.pem
  -j, --json
"
    .to_owned()
}

pub fn skill_help_text() -> String {
    "\
runx skill

Usage:
  runx skill <skill-ref|owner/name@version|skill-dir|SKILL.md> [runner] [-p profile] [-i key=value] [--input-json key=json] [-j] [--registry url|path] [--digest sha256] [--flag value] [--credential descriptor --secret-env NAME] [-R dir]
  runx skill inspect <skill-ref|owner/name@version|skill-dir|SKILL.md> [runner] [-j] [--registry url|path] [--digest sha256]

Options:
  -p, --profile name       Use a local credential profile from .runx/credentials.json
  -i, --input key=value    Set a structured input; repeat for multiple inputs
  --input-json key=json    Set an input that must parse as JSON
  -R, --receipts dir       Write receipts under dir
  --receipt-dir dir        Alias for --receipts
  -j, --json               Print machine-readable output
  --registry url|path
  --digest sha256
  --flag value
  --credential descriptor  One-shot local credential descriptor
  --secret-env NAME        Env var holding the one-shot credential secret
"
    .to_owned()
}

pub fn json_failure_output(message: &str, code: &str) -> String {
    let message = json_string(message, "failed to serialize error message");
    let code = json_string(code, "runtime_error");
    format!(
        "{{\n  \"status\": \"failure\",\n  \"error\": {{\n    \"message\": {message},\n    \"code\": {code}\n  }}\n}}\n"
    )
}

pub fn json_requested(args: &[OsString]) -> bool {
    args.iter().any(|arg| {
        arg.to_str()
            .is_some_and(|token| token == "--json" || token.starts_with("--json="))
    })
}

fn single_arg_is(args: &[OsString], expected: &str) -> bool {
    args.len() == 1 && first_arg_is(args, expected)
}

fn second_arg_is(args: &[OsString], expected: &str) -> bool {
    args.get(1).is_some_and(|arg| arg == OsStr::new(expected))
}

fn json_or_human_error(args: &[OsString], message: String) -> RouterAction {
    if json_requested(args) {
        RouterAction::JsonError(JsonErrorPlan {
            message,
            code: "invalid_args".to_owned(),
            exit_code: 64,
        })
    } else {
        RouterAction::Error(message)
    }
}

fn json_string(value: &str, fallback: &str) -> String {
    match serde_json::to_string(value) {
        Ok(value) => value,
        Err(_) => format!("\"{fallback}\""),
    }
}

fn nested_help_requested(args: &[OsString]) -> bool {
    args.iter()
        .skip(1)
        .any(|arg| matches!(arg.to_str(), Some("--help" | "-h")))
}

fn first_arg_is(args: &[OsString], expected: &str) -> bool {
    args.first().is_some_and(|arg| arg == OsStr::new(expected))
}

fn mcp_runner_before_serve(args: &[OsString]) -> bool {
    args.iter()
        .skip(1)
        .take_while(|arg| arg.as_os_str() != OsStr::new("serve"))
        .any(|arg| {
            arg.to_str()
                .is_some_and(|token| token == "--runner" || token.starts_with("--runner="))
        })
}

// rust-style-allow: long-function - harness flag parsing stays local to the
// router boundary so native dispatch does not grow a second parser surface.
fn native_harness_plan(args: &[OsString]) -> RouterAction {
    let mut fixture_paths = Vec::new();
    let mut receipt_dir = None;
    let mut index = 1;

    while index < args.len() {
        let Some(token) = args.get(index).and_then(|arg| arg.to_str()) else {
            return RouterAction::Error("harness arguments must be UTF-8".to_owned());
        };

        if !token.starts_with('-') {
            fixture_paths.push(args[index].clone());
            index += 1;
            continue;
        }

        let (flag, inline_value) = split_flag(token);
        match flag {
            "--json" | "-j" => {
                if inline_value.is_some() {
                    return RouterAction::Error("--json does not take a value".to_owned());
                }
                index += 1;
            }
            "--receipt-dir" | "--receipts" => match inline_value {
                Some(value) => {
                    receipt_dir = Some(OsString::from(value));
                    index += 1;
                }
                None => {
                    let Some(value) = args.get(index + 1) else {
                        return RouterAction::Error(
                            "--receipt-dir requires a directory".to_owned(),
                        );
                    };
                    receipt_dir = Some(value.clone());
                    index += 2;
                }
            },
            "-R" => {
                if inline_value.is_some() {
                    return RouterAction::Error(
                        "-R requires a separate directory value".to_owned(),
                    );
                }
                let Some(value) = args.get(index + 1) else {
                    return RouterAction::Error("-R requires a directory".to_owned());
                };
                receipt_dir = Some(value.clone());
                index += 2;
            }
            _ => return RouterAction::Error(format!("unknown harness flag {flag}")),
        }
    }

    if fixture_paths.is_empty() {
        return RouterAction::Error(
            "runx harness requires a fixture path or skill package".to_owned(),
        );
    }

    RouterAction::RunHarness(HarnessPlan {
        fixture_paths,
        receipt_dir,
    })
}

fn parse_new_plan(args: &[OsString]) -> Result<NewPlan, String> {
    let mut name = None;
    let mut directory = None;
    let mut json = false;
    let mut positional_directory = None;
    let mut extra_positionals = Vec::new();
    let mut index = 1;

    while index < args.len() {
        let token = os_arg(args, index, "new")?;
        if !token.starts_with("--") {
            if name.is_none() {
                name = Some(token.to_owned());
            } else if positional_directory.is_none() {
                positional_directory = Some(PathBuf::from(token));
            } else {
                extra_positionals.push(token.to_owned());
            }
            index += 1;
            continue;
        }

        let (flag, inline_value) = split_flag(token);
        match flag {
            "--json" => {
                if inline_value.is_some() {
                    return Err("--json does not take a value".to_owned());
                }
                json = true;
                index += 1;
            }
            "--directory" | "--dir" => {
                let (value, next_index) = flag_value(args, index, flag, inline_value, "new")?;
                directory = Some(PathBuf::from(value));
                index = next_index;
            }
            _ => return Err(format!("unknown new flag {flag}")),
        }
    }

    if !extra_positionals.is_empty() {
        return Err("runx new accepts at most one directory argument".to_owned());
    }

    Ok(NewPlan {
        name: name.ok_or_else(|| "runx new requires a package name".to_owned())?,
        directory: directory.or(positional_directory),
        json,
    })
}

fn parse_add_plan(args: &[OsString]) -> Result<RouterAction, String> {
    let parsed = parse_add_args(args)?;
    if is_github_repo_url_like(parsed.subject.as_deref().unwrap_or_default()) {
        return add_url_plan(parsed).map(RouterAction::RunAddUrl);
    }
    add_registry_plan(parsed).map(RouterAction::RunRegistry)
}

#[derive(Default)]
struct AddParseState {
    subject: Option<String>,
    registry: Option<String>,
    version: Option<String>,
    repo_ref: Option<String>,
    expected_digest: Option<String>,
    destination: Option<PathBuf>,
    api_base_url: Option<String>,
    json: bool,
}

fn parse_add_args(args: &[OsString]) -> Result<AddParseState, String> {
    let mut parsed = AddParseState::default();
    let mut index = 1;
    while index < args.len() {
        let token = os_arg(args, index, "add")?;
        if !token.starts_with("--") {
            if parsed.subject.is_some() {
                return Err("runx add accepts exactly one ref or repository URL".to_owned());
            }
            parsed.subject = Some(token.to_owned());
            index += 1;
            continue;
        }

        let (flag, inline_value) = split_flag(token);
        index = parse_add_flag(&mut parsed, args, index, flag, inline_value)?;
    }
    if parsed.subject.is_none() {
        return Err("runx add requires a skill ref or repository URL".to_owned());
    }
    Ok(parsed)
}

fn parse_add_flag(
    parsed: &mut AddParseState,
    args: &[OsString],
    index: usize,
    flag: &str,
    inline_value: Option<&str>,
) -> Result<usize, String> {
    match flag {
        "--json" => {
            if inline_value.is_some() {
                return Err("--json does not take a value".to_owned());
            }
            parsed.json = true;
            Ok(index + 1)
        }
        "--registry" => set_add_string(args, index, flag, inline_value, &mut parsed.registry),
        "--version" => set_add_string(args, index, flag, inline_value, &mut parsed.version),
        "--ref" => set_add_string(args, index, flag, inline_value, &mut parsed.repo_ref),
        "--digest" => set_add_string(args, index, flag, inline_value, &mut parsed.expected_digest),
        "--to" | "--destination" => {
            let (value, next_index) = flag_value(args, index, flag, inline_value, "add")?;
            parsed.destination = Some(PathBuf::from(value));
            Ok(next_index)
        }
        "--api-base-url" | "--apiBaseUrl" => {
            set_add_string(args, index, flag, inline_value, &mut parsed.api_base_url)
        }
        _ => Err(format!("unknown add flag {flag}")),
    }
}

fn set_add_string(
    args: &[OsString],
    index: usize,
    flag: &str,
    inline_value: Option<&str>,
    slot: &mut Option<String>,
) -> Result<usize, String> {
    let (value, next_index) = flag_value(args, index, flag, inline_value, "add")?;
    *slot = Some(value);
    Ok(next_index)
}

fn add_url_plan(parsed: AddParseState) -> Result<AddUrlPlan, String> {
    if parsed.registry.is_some() {
        return Err(
            "runx add <github-url> uses --api-base-url for the hosted index API, not --registry"
                .to_owned(),
        );
    }
    if parsed.version.is_some() {
        return Err("runx add <github-url> uses --ref for git refs, not --version".to_owned());
    }
    if parsed.expected_digest.is_some() || parsed.destination.is_some() {
        return Err(
            "runx add <github-url> indexes the repository and does not support --to or --digest"
                .to_owned(),
        );
    }
    Ok(AddUrlPlan {
        repo: parsed.subject.unwrap_or_default(),
        repo_ref: parsed.repo_ref,
        api_base_url: parsed.api_base_url,
        json: parsed.json,
    })
}

fn add_registry_plan(parsed: AddParseState) -> Result<RegistryPlan, String> {
    if parsed.repo_ref.is_some() {
        return Err(
            "runx add <skill-ref> uses --version for registry versions, not --ref".to_owned(),
        );
    }
    if parsed.api_base_url.is_some() {
        return Err("runx add <skill-ref> does not accept --api-base-url".to_owned());
    }
    Ok(RegistryPlan {
        action: RegistryAction::Install,
        subject: parsed.subject.unwrap_or_default(),
        registry: parsed.registry,
        registry_dir: None,
        version: parsed.version,
        expected_digest: parsed.expected_digest,
        destination: parsed.destination,
        owner: None,
        profile: None,
        trust_tier: None,
        limit: None,
        upsert: false,
        json: parsed.json,
    })
}

fn is_github_repo_url_like(value: &str) -> bool {
    let value = value.trim();
    let Some(path) = value
        .strip_prefix("https://github.com/")
        .or_else(|| value.strip_prefix("http://github.com/"))
        .or_else(|| value.strip_prefix("github.com/"))
    else {
        return false;
    };
    let mut parts = path.split('/').filter(|part| !part.is_empty());
    parts.next().is_some() && parts.next().is_some()
}

fn parse_init_plan(args: &[OsString]) -> Result<InitPlan, String> {
    let mut global = false;
    let mut prefetch_official = false;
    let mut json = false;
    let mut index = 1;

    while index < args.len() {
        let token = os_arg(args, index, "init")?;
        if token == "-g" {
            global = true;
            index += 1;
            continue;
        }
        if !token.starts_with("--") {
            return Err(format!("unexpected init argument {token}"));
        }

        let (flag, inline_value) = split_flag(token);
        match flag {
            "--json" => {
                if inline_value.is_some() {
                    return Err("--json does not take a value".to_owned());
                }
                json = true;
                index += 1;
            }
            "--global" => {
                if inline_value.is_some() {
                    return Err("--global does not take a value".to_owned());
                }
                global = true;
                index += 1;
            }
            "--prefetch" | "--prefetchOfficial" | "--prefetch-official" => {
                if matches!(inline_value, Some("false") | Some("0")) {
                    prefetch_official = false;
                    index += 1;
                    continue;
                }
                let (value, next_index) = optional_flag_value(args, index, inline_value, "init")?;
                prefetch_official = value.is_none_or(|value| truthy(&value));
                index = next_index;
            }
            _ => return Err(format!("unknown init flag {flag}")),
        }
    }

    Ok(InitPlan {
        global,
        prefetch_official,
        json,
    })
}

fn parse_dev_plan(args: &[OsString]) -> Result<DevPlan, String> {
    let mut root = None;
    let mut lane = None;
    let mut json = false;
    let mut index = 1;

    while index < args.len() {
        let token = os_arg(args, index, "dev")?;
        if !token.starts_with("--") {
            if root.is_some() {
                return Err("runx dev accepts at most one root path".to_owned());
            }
            root = Some(PathBuf::from(token));
            index += 1;
            continue;
        }

        let (flag, inline_value) = split_flag(token);
        match flag {
            "--json" => {
                if inline_value.is_some() {
                    return Err("--json does not take a value".to_owned());
                }
                json = true;
                index += 1;
            }
            "--lane" => {
                let (value, next_index) = flag_value(args, index, flag, inline_value, "dev")?;
                if value.is_empty() {
                    return Err("--lane must not be empty".to_owned());
                }
                lane = Some(value);
                index = next_index;
            }
            _ => return Err(format!("unknown dev flag {flag}")),
        }
    }

    Ok(DevPlan { root, lane, json })
}

fn parse_doctor_plan(args: &[OsString]) -> Result<DoctorPlan, String> {
    let mut mode = DoctorMode::Workspace;
    let mut path = None;
    let mut json = false;
    let mut index = 1;

    while index < args.len() {
        let token = os_arg(args, index, "doctor")?;
        if !token.starts_with('-') {
            if matches!(token, "authority" | "registry")
                && path.is_none()
                && mode == DoctorMode::Workspace
            {
                mode = if token == "authority" {
                    DoctorMode::Authority
                } else {
                    DoctorMode::Registry
                };
                index += 1;
                continue;
            }
            if mode != DoctorMode::Workspace {
                return Err(format!(
                    "runx doctor {} does not accept a path",
                    doctor_mode_name(&mode)
                ));
            }
            if path.is_some() {
                return Err("runx doctor accepts at most one path".to_owned());
            }
            path = Some(PathBuf::from(token));
            index += 1;
            continue;
        }

        let (flag, inline_value) = split_flag(token);
        match flag {
            "--json" | "-j" => {
                if inline_value.is_some() {
                    return Err("--json does not take a value".to_owned());
                }
                json = true;
                index += 1;
            }
            _ => return Err(format!("unknown doctor flag {flag}")),
        }
    }

    Ok(DoctorPlan { mode, path, json })
}

fn doctor_mode_name(mode: &DoctorMode) -> &'static str {
    match mode {
        DoctorMode::Workspace => "workspace",
        DoctorMode::Authority => "authority",
        DoctorMode::Registry => "registry",
    }
}

fn parse_list_plan(args: &[OsString]) -> Result<ListPlan, String> {
    let mut kind = ListKind::All;
    let mut filter = FilterMode::All;
    let mut json = false;
    let mut saw_kind = false;
    let mut index = 1;

    while index < args.len() {
        let token = os_arg(args, index, "list")?;
        if !token.starts_with('-') {
            if saw_kind {
                return Err("runx list accepts at most one kind".to_owned());
            }
            kind = parse_list_kind(token).ok_or_else(|| {
                "runx list kind must be tools, skills, graphs, packets, or overlays".to_owned()
            })?;
            saw_kind = true;
            index += 1;
            continue;
        }

        let (flag, inline_value) = split_flag(token);
        if inline_value.is_some() {
            return Err(format!("{flag} does not take a value"));
        }
        let requested = match flag {
            "--json" | "-j" => {
                json = true;
                index += 1;
                continue;
            }
            "--ok-only" | "--okOnly" => FilterMode::OkOnly,
            "--invalid-only" | "--invalidOnly" => FilterMode::InvalidOnly,
            _ => return Err(format!("unknown list flag {flag}")),
        };
        if filter != FilterMode::All && filter != requested {
            return Err("runx list accepts either --ok-only or --invalid-only".to_owned());
        }
        filter = requested;
        index += 1;
    }

    Ok(ListPlan { kind, filter, json })
}

fn parse_list_kind(value: &str) -> Option<ListKind> {
    match value {
        "tools" => Some(ListKind::Tools),
        "skills" => Some(ListKind::Skills),
        "graphs" => Some(ListKind::Graphs),
        "packets" => Some(ListKind::Packets),
        "overlays" => Some(ListKind::Overlays),
        _ => None,
    }
}

fn parse_kernel_plan(args: &[OsString]) -> Result<KernelPlan, String> {
    let subcommand = os_arg(args, 1, "kernel")?;
    if subcommand != "eval" {
        return Err(format!("unknown kernel subcommand {subcommand}"));
    }
    let parsed = parse_json_eval_input(
        args,
        2,
        JsonEvalCommand {
            command: "kernel",
            subject: "kernel eval",
            duplicate_input: "runx kernel eval accepts exactly one --input",
            requires_json: "runx kernel eval requires --json",
            requires_input: "runx kernel eval requires --input <file|->",
        },
    )?;
    Ok(KernelPlan {
        input: parsed.input.into_kernel_source(),
        json: true,
    })
}

// rust-style-allow: long-function because this flat argument parser walks the
// payment subcommand grammar in a single readable pass; extracting sub-parsers
// would obscure which flags belong to which positional verb.
fn parse_payment_plan(args: &[OsString]) -> Result<PaymentPlan, String> {
    let topic = os_arg(args, 1, "payment")?;
    if topic != "admission" {
        return Err(format!("unknown payment subcommand {topic}"));
    }
    let action = os_arg(args, 2, "payment admission")?;
    if action != "issue" {
        return Err(format!("unknown payment admission subcommand {action}"));
    }
    let parsed = parse_json_eval_input(
        args,
        3,
        JsonEvalCommand {
            command: "payment admission issue",
            subject: "payment admission issue",
            duplicate_input: "runx payment admission issue accepts exactly one --input",
            requires_json: "runx payment admission issue requires --json",
            requires_input: "runx payment admission issue requires --input <file|->",
        },
    )?;
    Ok(PaymentPlan {
        action: PaymentAction::IssueAdmission(PaymentAdmissionPlan {
            input: parsed.input.into_payment_source(),
            json: true,
        }),
    })
}

fn parse_parser_plan(args: &[OsString]) -> Result<ParserPlan, String> {
    let subcommand = os_arg(args, 1, "parser")?;
    if subcommand != "eval" {
        return Err(format!("unknown parser subcommand {subcommand}"));
    }
    let parsed = parse_json_eval_input(
        args,
        2,
        JsonEvalCommand {
            command: "parser",
            subject: "parser eval",
            duplicate_input: "runx parser eval accepts exactly one --input",
            requires_json: "runx parser eval requires --json",
            requires_input: "runx parser eval requires --input <file|->",
        },
    )?;
    Ok(ParserPlan {
        input: parsed.input.into_parser_source(),
        json: true,
    })
}

struct JsonEvalCommand {
    command: &'static str,
    subject: &'static str,
    duplicate_input: &'static str,
    requires_json: &'static str,
    requires_input: &'static str,
}

struct JsonEvalPlan {
    input: JsonEvalInput,
}

enum JsonEvalInput {
    Stdin,
    Path(PathBuf),
}

impl JsonEvalInput {
    fn into_kernel_source(self) -> KernelInputSource {
        match self {
            Self::Stdin => KernelInputSource::Stdin,
            Self::Path(path) => KernelInputSource::Path(path),
        }
    }

    fn into_payment_source(self) -> PaymentInputSource {
        match self {
            Self::Stdin => PaymentInputSource::Stdin,
            Self::Path(path) => PaymentInputSource::Path(path),
        }
    }

    fn into_parser_source(self) -> ParserInputSource {
        match self {
            Self::Stdin => ParserInputSource::Stdin,
            Self::Path(path) => ParserInputSource::Path(path),
        }
    }
}

fn parse_json_eval_input(
    args: &[OsString],
    mut index: usize,
    command: JsonEvalCommand,
) -> Result<JsonEvalPlan, String> {
    let mut input = None;
    let mut json = false;
    while index < args.len() {
        let token = os_arg(args, index, command.command)?;
        if !token.starts_with("--") {
            return Err(format!("unexpected {} argument {token}", command.subject));
        }

        let (flag, inline_value) = split_flag(token);
        match flag {
            "--json" => {
                if inline_value.is_some() {
                    return Err("--json does not take a value".to_owned());
                }
                json = true;
                index += 1;
            }
            "--input" => {
                if input.is_some() {
                    return Err(command.duplicate_input.to_owned());
                }
                let (value, next_index) =
                    flag_value(args, index, flag, inline_value, command.command)?;
                input = Some(if value == "-" {
                    JsonEvalInput::Stdin
                } else {
                    JsonEvalInput::Path(PathBuf::from(value))
                });
                index = next_index;
            }
            _ => return Err(format!("unknown {} flag {flag}", command.subject)),
        }
    }
    if !json {
        return Err(command.requires_json.to_owned());
    }
    Ok(JsonEvalPlan {
        input: input.ok_or_else(|| command.requires_input.to_owned())?,
    })
}

fn parse_policy_plan(args: &[OsString]) -> Result<PolicyPlan, String> {
    let subcommand = os_arg(args, 1, "policy")?;
    let action = match subcommand {
        "inspect" => PolicyAction::Inspect,
        "lint" => PolicyAction::Lint,
        _ => return Err(format!("unknown policy subcommand {subcommand}")),
    };
    let mut json = false;
    let mut positionals = Vec::new();
    let mut index = 2;

    while index < args.len() {
        let token = os_arg(args, index, "policy")?;
        if !token.starts_with("--") {
            positionals.push(PathBuf::from(token));
            index += 1;
            continue;
        }

        let (flag, inline_value) = split_flag(token);
        match flag {
            "--json" => {
                if inline_value.is_some() {
                    return Err("--json does not take a value".to_owned());
                }
                json = true;
                index += 1;
            }
            _ => return Err(format!("unknown policy flag {flag}")),
        }
    }

    let [path] = positionals.as_slice() else {
        return Err("runx policy inspect|lint requires exactly one policy path".to_owned());
    };
    Ok(PolicyPlan {
        action,
        path: path.clone(),
        json,
    })
}

fn parse_tool_plan(args: &[OsString]) -> Result<ToolPlan, String> {
    let subcommand = os_arg(args, 1, "tool")?;
    let action = match subcommand {
        "build" => ToolAction::Build,
        "search" => ToolAction::Search,
        "inspect" => ToolAction::Inspect,
        _ => return Err(format!("unknown tool subcommand {subcommand}")),
    };
    let mut json = false;
    let mut all = false;
    let mut source = None;
    let mut positionals = Vec::new();
    let mut index = 2;

    while index < args.len() {
        let token = os_arg(args, index, "tool")?;
        if !token.starts_with("--") {
            positionals.push(token.to_owned());
            index += 1;
            continue;
        }

        let (flag, inline_value) = split_flag(token);
        match flag {
            "--json" => {
                if inline_value.is_some() {
                    return Err("--json does not take a value".to_owned());
                }
                json = true;
                index += 1;
            }
            "--all" => {
                if inline_value.is_some() {
                    return Err("--all does not take a value".to_owned());
                }
                all = true;
                index += 1;
            }
            "--source" => {
                let (value, next_index) = flag_value(args, index, flag, inline_value, "tool")?;
                source = Some(value);
                index = next_index;
            }
            _ => return Err(format!("unknown tool flag {flag}")),
        }
    }

    match action {
        ToolAction::Build => build_tool_plan(positionals, all, source, json),
        ToolAction::Search => search_tool_plan(positionals, all, source, json),
        ToolAction::Inspect => inspect_tool_plan(positionals, all, source, json),
    }
}

fn build_tool_plan(
    positionals: Vec<String>,
    all: bool,
    source: Option<String>,
    json: bool,
) -> Result<ToolPlan, String> {
    if source.is_some() {
        return Err("runx tool build does not accept --source".to_owned());
    }
    if all && !positionals.is_empty() {
        return Err("runx tool build accepts either --all or one tool directory".to_owned());
    }
    if !all && positionals.len() != 1 {
        return Err("runx tool build requires a tool directory or --all".to_owned());
    }

    Ok(ToolPlan {
        action: ToolAction::Build,
        path: positionals.first().map(PathBuf::from),
        ref_or_query: None,
        all,
        source: None,
        json,
    })
}

fn search_tool_plan(
    positionals: Vec<String>,
    all: bool,
    source: Option<String>,
    json: bool,
) -> Result<ToolPlan, String> {
    if all {
        return Err("runx tool search does not accept --all".to_owned());
    }
    let query = positionals.join(" ");
    if query.is_empty() {
        return Err("runx tool search requires a query".to_owned());
    }

    Ok(ToolPlan {
        action: ToolAction::Search,
        path: None,
        ref_or_query: Some(query),
        all: false,
        source,
        json,
    })
}

fn inspect_tool_plan(
    positionals: Vec<String>,
    all: bool,
    source: Option<String>,
    json: bool,
) -> Result<ToolPlan, String> {
    if all {
        return Err("runx tool inspect does not accept --all".to_owned());
    }
    let tool_ref = positionals.join(" ");
    if tool_ref.is_empty() {
        return Err("runx tool inspect requires a tool reference".to_owned());
    }

    Ok(ToolPlan {
        action: ToolAction::Inspect,
        path: None,
        ref_or_query: Some(tool_ref),
        all: false,
        source,
        json,
    })
}

fn parse_registry_plan(args: &[OsString]) -> Result<RegistryPlan, String> {
    let subcommand = os_arg(args, 1, "registry")?;
    let action = parse_registry_action(subcommand)?;
    let mut state = RegistryParseState::default();
    parse_registry_args(args, &mut state)?;
    let subject = registry_subject(&action, subcommand, &mut state.positionals)?;

    Ok(RegistryPlan {
        action,
        subject,
        registry: state.registry,
        registry_dir: state.registry_dir,
        version: state.version,
        expected_digest: state.expected_digest,
        destination: state.destination,
        owner: state.owner,
        profile: state.profile,
        trust_tier: state.trust_tier,
        limit: state.limit,
        upsert: state.upsert,
        json: state.json,
    })
}

#[derive(Default)]
struct RegistryParseState {
    json: bool,
    upsert: bool,
    registry: Option<String>,
    registry_dir: Option<PathBuf>,
    version: Option<String>,
    expected_digest: Option<String>,
    destination: Option<PathBuf>,
    owner: Option<String>,
    profile: Option<PathBuf>,
    trust_tier: Option<runx_runtime::registry::TrustTier>,
    limit: Option<usize>,
    positionals: Vec<String>,
}

fn parse_registry_action(subcommand: &str) -> Result<RegistryAction, String> {
    match subcommand {
        "search" => Ok(RegistryAction::Search),
        "read" => Ok(RegistryAction::Read),
        "resolve" => Ok(RegistryAction::Resolve),
        "install" => Ok(RegistryAction::Install),
        "publish" => Ok(RegistryAction::Publish),
        _ => Err(format!("unknown registry subcommand {subcommand}")),
    }
}

fn parse_registry_args(args: &[OsString], state: &mut RegistryParseState) -> Result<(), String> {
    let mut index = 2;
    while index < args.len() {
        let token = os_arg(args, index, "registry")?;
        if !token.starts_with("--") {
            state.positionals.push(token.to_owned());
            index += 1;
            continue;
        }

        let (flag, inline_value) = split_flag(token);
        index = parse_registry_flag(args, index, flag, inline_value, state)?;
    }
    Ok(())
}

fn parse_registry_flag(
    args: &[OsString],
    index: usize,
    flag: &str,
    inline_value: Option<&str>,
    state: &mut RegistryParseState,
) -> Result<usize, String> {
    match flag {
        "--json" => set_registry_bool_flag(flag, inline_value, &mut state.json, index),
        "--upsert" => set_registry_bool_flag(flag, inline_value, &mut state.upsert, index),
        "--registry" => {
            set_registry_string_flag(args, index, flag, inline_value, &mut state.registry)
        }
        "--registry-dir" | "--registryDir" => {
            set_registry_path_flag(args, index, flag, inline_value, &mut state.registry_dir)
        }
        "--version" => {
            set_registry_string_flag(args, index, flag, inline_value, &mut state.version)
        }
        "--digest" => {
            set_registry_string_flag(args, index, flag, inline_value, &mut state.expected_digest)
        }
        "--to" | "--destination" => {
            set_registry_path_flag(args, index, flag, inline_value, &mut state.destination)
        }
        "--owner" => set_registry_string_flag(args, index, flag, inline_value, &mut state.owner),
        "--profile" => set_registry_path_flag(args, index, flag, inline_value, &mut state.profile),
        "--trust-tier" | "--trustTier" => {
            set_registry_trust_tier_flag(args, index, flag, inline_value, state)
        }
        "--limit" => set_registry_limit_flag(args, index, flag, inline_value, state),
        _ => Err(format!("unknown registry flag {flag}")),
    }
}

fn set_registry_trust_tier_flag(
    args: &[OsString],
    index: usize,
    flag: &str,
    inline_value: Option<&str>,
    state: &mut RegistryParseState,
) -> Result<usize, String> {
    if state.trust_tier.is_some() {
        return Err(format!("{flag} was provided more than once"));
    }
    let (value, next_index) = flag_value(args, index, flag, inline_value, "registry")?;
    state.trust_tier = Some(parse_registry_trust_tier(&value)?);
    Ok(next_index)
}

fn parse_registry_trust_tier(value: &str) -> Result<runx_runtime::registry::TrustTier, String> {
    match value {
        "first_party" | "first-party" => Ok(runx_runtime::registry::TrustTier::FirstParty),
        "verified" => Ok(runx_runtime::registry::TrustTier::Verified),
        "community" => Ok(runx_runtime::registry::TrustTier::Community),
        _ => Err(format!(
            "invalid registry trust tier {value}; expected first_party, verified, or community"
        )),
    }
}

fn set_registry_bool_flag(
    flag: &str,
    inline_value: Option<&str>,
    target: &mut bool,
    index: usize,
) -> Result<usize, String> {
    if inline_value.is_some() {
        return Err(format!("{flag} does not take a value"));
    }
    *target = true;
    Ok(index + 1)
}

fn set_registry_string_flag(
    args: &[OsString],
    index: usize,
    flag: &str,
    inline_value: Option<&str>,
    target: &mut Option<String>,
) -> Result<usize, String> {
    let (value, next_index) = flag_value(args, index, flag, inline_value, "registry")?;
    *target = Some(value);
    Ok(next_index)
}

fn set_registry_path_flag(
    args: &[OsString],
    index: usize,
    flag: &str,
    inline_value: Option<&str>,
    target: &mut Option<PathBuf>,
) -> Result<usize, String> {
    let (value, next_index) = flag_value(args, index, flag, inline_value, "registry")?;
    *target = Some(PathBuf::from(value));
    Ok(next_index)
}

fn set_registry_limit_flag(
    args: &[OsString],
    index: usize,
    flag: &str,
    inline_value: Option<&str>,
    state: &mut RegistryParseState,
) -> Result<usize, String> {
    let (value, next_index) = flag_value(args, index, flag, inline_value, "registry")?;
    state.limit = Some(
        value
            .parse::<usize>()
            .map_err(|_| "--limit must be a positive integer".to_owned())?,
    );
    Ok(next_index)
}

fn registry_subject(
    action: &RegistryAction,
    subcommand: &str,
    positionals: &mut Vec<String>,
) -> Result<String, String> {
    match action {
        RegistryAction::Search => {
            if positionals.is_empty() {
                return Err("runx registry search requires a query".to_owned());
            }
            Ok(positionals.join(" "))
        }
        RegistryAction::Read | RegistryAction::Resolve | RegistryAction::Install => {
            if positionals.len() != 1 {
                return Err(format!(
                    "runx registry {subcommand} requires exactly one ref"
                ));
            }
            Ok(positionals.remove(0))
        }
        RegistryAction::Publish => {
            if positionals.len() != 1 {
                return Err(
                    "runx registry publish requires exactly one skill markdown path".to_owned(),
                );
            }
            Ok(positionals.remove(0))
        }
    }
}

fn truthy(value: &str) -> bool {
    matches!(value, "true" | "1" | "yes" | "official")
}

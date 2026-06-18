use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use runx_contracts::{JsonObject, JsonValue};
use runx_runtime::registry::RegistryPublishHarnessReport;
use serde::Serialize;

use super::{RegistryCliError, internal_error};

pub(super) fn read_skill_package(
    subject: &str,
    profile: Option<&Path>,
    env: &BTreeMap<String, String>,
    cwd: &Path,
    include_harness: bool,
) -> Result<SkillPackage, RegistryCliError> {
    let subject_path = runx_runtime::resolve_path_from_user_input(subject, env, cwd, true);
    let metadata = fs::metadata(&subject_path).map_err(|error| RegistryCliError {
        message: format!(
            "failed to read skill package {}: {error}",
            subject_path.display()
        ),
        exit_code: 1,
    })?;
    let markdown_path = if metadata.is_dir() {
        subject_path.join("SKILL.md")
    } else {
        subject_path.clone()
    };
    let markdown = fs::read_to_string(&markdown_path).map_err(|error| RegistryCliError {
        message: format!(
            "failed to read skill markdown {}: {error}",
            markdown_path.display()
        ),
        exit_code: 1,
    })?;
    let profile_path = profile
        .map(|path| super::resolve_path(path, env, cwd, true))
        .or_else(|| {
            let candidate = markdown_path.parent()?.join("X.yaml");
            candidate.exists().then_some(candidate)
        });
    let profile_document = match profile_path {
        Some(ref path) => Some(fs::read_to_string(path).map_err(|error| RegistryCliError {
            message: format!("failed to read skill profile {}: {error}", path.display()),
            exit_code: 1,
        })?),
        None => None,
    };
    let harness_package = if include_harness {
        publish_harness_package(
            &markdown_path,
            profile_path.as_deref(),
            &markdown,
            profile_document.as_deref(),
        )?
    } else {
        PublishHarnessPackage {
            path: None,
            temp_dir: None,
        }
    };
    let package_files = if include_harness {
        collect_publish_package_files(&markdown_path, profile_path.as_deref())?
    } else {
        Vec::new()
    };
    Ok(SkillPackage {
        markdown,
        profile_document,
        harness_path: harness_package.path,
        harness_temp_dir: harness_package.temp_dir,
        package_files,
    })
}

pub(super) fn run_publish_harness(
    harness_path: Option<&Path>,
) -> Result<RegistryPublishHarnessReport, RegistryCliError> {
    let Some(harness_path) = harness_path else {
        return Ok(RegistryPublishHarnessReport::not_declared());
    };
    let receipt_dir = publish_harness_receipt_dir()?;
    let request = runx_runtime::InlineHarnessRequest {
        skill_path: harness_path.to_path_buf(),
        receipt_dir: Some(receipt_dir.clone()),
    };
    let report = crate::runtime::local_orchestrator().run_inline_harness(&request);
    let _ignored = fs::remove_dir_all(&receipt_dir);
    let report = report.map_err(|error| {
        internal_error(format!(
            "inline harness failed for {}: {error}",
            harness_path.display()
        ))
    })?;
    let report = publish_harness_report(report);
    if report.failed() {
        return Err(internal_error(format!(
            "Harness failed for {}: {}",
            harness_path.display(),
            report.assertion_errors.join("; ")
        )));
    }
    Ok(report)
}

#[derive(Clone, Debug)]
pub(super) struct SkillPackage {
    pub(super) markdown: String,
    pub(super) profile_document: Option<String>,
    pub(super) harness_path: Option<PathBuf>,
    pub(super) harness_temp_dir: Option<PathBuf>,
    pub(super) package_files: Vec<HostedSkillPackageFile>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(super) struct HostedSkillPackageFile {
    pub(super) path: String,
    pub(super) content: String,
}

struct PublishHarnessPackage {
    path: Option<PathBuf>,
    temp_dir: Option<PathBuf>,
}

const MAX_REMOTE_PUBLISH_FILE_BYTES: u64 = 512 * 1024;
const MAX_REMOTE_PUBLISH_TOTAL_BYTES: u64 = 2 * 1024 * 1024;
const MAX_REMOTE_PUBLISH_FILE_COUNT: usize = 128;

fn publish_harness_package(
    markdown_path: &Path,
    profile_path: Option<&Path>,
    markdown: &str,
    profile_document: Option<&str>,
) -> Result<PublishHarnessPackage, RegistryCliError> {
    let Some(profile_path) = profile_path else {
        return Ok(PublishHarnessPackage {
            path: None,
            temp_dir: None,
        });
    };
    if let Some(path) = colocated_package_harness_path(markdown_path, profile_path) {
        return Ok(PublishHarnessPackage {
            path: Some(path),
            temp_dir: None,
        });
    }
    let Some(profile_document) = profile_document else {
        return Ok(PublishHarnessPackage {
            path: None,
            temp_dir: None,
        });
    };
    let temp_dir = unique_temp_dir("runx-publish-profile-harness")?;
    copy_publish_harness_sidecars(markdown_path, &temp_dir)?;
    fs::write(temp_dir.join("SKILL.md"), markdown).map_err(|error| {
        internal_error(format!(
            "failed to write publish harness skill fixture {}: {error}",
            temp_dir.join("SKILL.md").display()
        ))
    })?;
    fs::write(temp_dir.join("X.yaml"), profile_document).map_err(|error| {
        internal_error(format!(
            "failed to write publish harness profile fixture {}: {error}",
            temp_dir.join("X.yaml").display()
        ))
    })?;
    Ok(PublishHarnessPackage {
        path: Some(temp_dir.clone()),
        temp_dir: Some(temp_dir),
    })
}

fn copy_publish_harness_sidecars(
    markdown_path: &Path,
    temp_dir: &Path,
) -> Result<(), RegistryCliError> {
    if markdown_path.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
        return Ok(());
    }
    let Some(package_dir) = markdown_path.parent() else {
        return Ok(());
    };
    copy_dir_contents(package_dir, temp_dir)
}

fn copy_dir_contents(source_dir: &Path, destination_dir: &Path) -> Result<(), RegistryCliError> {
    for entry in fs::read_dir(source_dir).map_err(|error| {
        internal_error(format!(
            "failed to read publish harness package directory {}: {error}",
            source_dir.display()
        ))
    })? {
        let entry = entry.map_err(|error| {
            internal_error(format!(
                "failed to read publish harness package entry in {}: {error}",
                source_dir.display()
            ))
        })?;
        let entry_type = entry.file_type().map_err(|error| {
            internal_error(format!(
                "failed to inspect publish harness package entry {}: {error}",
                entry.path().display()
            ))
        })?;
        let destination = destination_dir.join(entry.file_name());
        if entry_type.is_dir() {
            fs::create_dir_all(&destination).map_err(|error| {
                internal_error(format!(
                    "failed to create publish harness package directory {}: {error}",
                    destination.display()
                ))
            })?;
            copy_dir_contents(&entry.path(), &destination)?;
        } else if entry_type.is_file() {
            fs::copy(entry.path(), &destination).map_err(|error| {
                internal_error(format!(
                    "failed to copy publish harness package entry {} to {}: {error}",
                    entry.path().display(),
                    destination.display()
                ))
            })?;
        } else {
            return Err(internal_error(format!(
                "publish harness package entry {} is not a regular file or directory",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

fn collect_publish_package_files(
    markdown_path: &Path,
    profile_path: Option<&Path>,
) -> Result<Vec<HostedSkillPackageFile>, RegistryCliError> {
    if markdown_path.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
        return Ok(Vec::new());
    }
    let Some(package_dir) = markdown_path.parent() else {
        return Ok(Vec::new());
    };
    let package_dir = fs::canonicalize(package_dir).map_err(|error| {
        internal_error(format!(
            "failed to canonicalize skill package directory {}: {error}",
            package_dir.display()
        ))
    })?;
    let profile_path = profile_path.and_then(|path| fs::canonicalize(path).ok());
    let markdown_path = fs::canonicalize(markdown_path).map_err(|error| {
        internal_error(format!(
            "failed to canonicalize skill markdown {}: {error}",
            markdown_path.display()
        ))
    })?;
    let consumed_root_scripts = consumed_root_scripts_from_profile(profile_path.as_ref())?;
    collect_allowed_publish_package_files(
        &package_dir,
        &markdown_path,
        profile_path.as_ref(),
        &consumed_root_scripts,
    )
}

fn collect_allowed_publish_package_files(
    package_dir: &Path,
    markdown_path: &Path,
    profile_path: Option<&PathBuf>,
    consumed_root_scripts: &BTreeSet<String>,
) -> Result<Vec<HostedSkillPackageFile>, RegistryCliError> {
    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    collect_allowed_publish_package_files_from_dir(
        package_dir,
        package_dir,
        markdown_path,
        profile_path,
        consumed_root_scripts,
        &mut files,
        &mut total_bytes,
    )?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn collect_allowed_publish_package_files_from_dir(
    package_dir: &Path,
    current_dir: &Path,
    markdown_path: &Path,
    profile_path: Option<&PathBuf>,
    consumed_root_scripts: &BTreeSet<String>,
    files: &mut Vec<HostedSkillPackageFile>,
    total_bytes: &mut u64,
) -> Result<(), RegistryCliError> {
    for entry in fs::read_dir(current_dir).map_err(|error| {
        internal_error(format!(
            "failed to read remote publish package directory {}: {error}",
            current_dir.display()
        ))
    })? {
        let entry = entry.map_err(|error| {
            internal_error(format!(
                "failed to read remote publish package entry in {}: {error}",
                current_dir.display()
            ))
        })?;
        let candidate = entry.path();
        let metadata = fs::symlink_metadata(&candidate).map_err(|error| {
            internal_error(format!(
                "failed to inspect remote publish package entry {}: {error}",
                candidate.display()
            ))
        })?;
        let relative = publish_relative_path(package_dir, &candidate)?;
        if metadata.file_type().is_dir() {
            if should_descend_remote_publish_dir(&relative) {
                collect_allowed_publish_package_files_from_dir(
                    package_dir,
                    &candidate,
                    markdown_path,
                    profile_path,
                    consumed_root_scripts,
                    files,
                    total_bytes,
                )?;
            }
            continue;
        }
        if !is_allowed_remote_publish_package_file(&relative, consumed_root_scripts) {
            continue;
        }
        if !metadata.file_type().is_file() {
            return Err(internal_error(format!(
                "remote publish package file {} is not a regular file",
                candidate.display()
            )));
        }
        let canonical = fs::canonicalize(&candidate).map_err(|error| {
            internal_error(format!(
                "failed to canonicalize remote publish package file {}: {error}",
                candidate.display()
            ))
        })?;
        if &canonical == markdown_path || Some(&canonical) == profile_path {
            continue;
        }
        if metadata.len() > MAX_REMOTE_PUBLISH_FILE_BYTES {
            return Err(internal_error(format!(
                "remote publish package file {} exceeds {} bytes",
                canonical.display(),
                MAX_REMOTE_PUBLISH_FILE_BYTES
            )));
        }
        *total_bytes += metadata.len();
        if *total_bytes > MAX_REMOTE_PUBLISH_TOTAL_BYTES {
            return Err(internal_error(format!(
                "remote publish package files exceed {} total bytes",
                MAX_REMOTE_PUBLISH_TOTAL_BYTES
            )));
        }
        if files.len() >= MAX_REMOTE_PUBLISH_FILE_COUNT {
            return Err(internal_error(format!(
                "remote publish package cannot contain more than {MAX_REMOTE_PUBLISH_FILE_COUNT} package files"
            )));
        }
        if should_reject_remote_publish_file(&relative) {
            return Err(internal_error(format!(
                "remote publish package file {relative} looks like a secret or local credential; remove it before publishing"
            )));
        }
        let content = fs::read_to_string(&canonical).map_err(|error| {
            internal_error(format!(
                "remote publish package file {} must be UTF-8 text: {error}",
                canonical.display()
            ))
        })?;
        files.push(HostedSkillPackageFile {
            path: relative,
            content,
        });
    }
    Ok(())
}

fn publish_relative_path(package_dir: &Path, candidate: &Path) -> Result<String, RegistryCliError> {
    let relative = candidate.strip_prefix(package_dir).map_err(|error| {
        internal_error(format!(
            "failed to relativize remote publish package entry {}: {error}",
            candidate.display()
        ))
    })?;
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn should_descend_remote_publish_dir(relative: &str) -> bool {
    let name = relative.rsplit('/').next().unwrap_or(relative);
    !matches!(
        name,
        ".git"
            | ".runx"
            | ".scafld"
            | ".ssh"
            | "assets"
            | "dist"
            | "fixtures"
            | "node_modules"
            | "src"
            | "target"
    )
}

fn is_allowed_remote_publish_package_file(
    relative: &str,
    consumed_root_scripts: &BTreeSet<String>,
) -> bool {
    if relative.is_empty()
        || relative
            .split('/')
            .any(|segment| segment.is_empty() || segment.starts_with('.'))
    {
        return false;
    }
    if relative.split('/').any(|segment| {
        matches!(
            segment,
            "assets" | "dist" | "fixtures" | "node_modules" | "src" | "target"
        )
    }) {
        return false;
    }
    let file_name = relative.rsplit('/').next().unwrap_or(relative);
    if !relative.contains('/') && (file_name.ends_with(".mjs") || file_name.ends_with(".js")) {
        return consumed_root_scripts.contains(relative);
    }
    if relative.contains("/references/") || relative.starts_with("references/") {
        return file_name.ends_with(".md");
    }
    matches!(file_name, "SKILL.md" | "X.yaml" | "manifest.json")
        || matches!(
            file_name,
            "run.mjs" | "run.js" | "harness.mjs" | "harness.js"
        )
}

fn consumed_root_scripts_from_profile(
    profile_path: Option<&PathBuf>,
) -> Result<BTreeSet<String>, RegistryCliError> {
    let Some(profile_path) = profile_path else {
        return Ok(BTreeSet::new());
    };
    let document = fs::read_to_string(profile_path).map_err(|error| {
        internal_error(format!(
            "failed to read profile while selecting publish package files {}: {error}",
            profile_path.display()
        ))
    })?;
    let manifest = runx_parser::validate_runner_manifest(
        runx_parser::parse_runner_manifest_yaml(&document).map_err(|error| {
            internal_error(format!(
                "failed to parse profile while selecting publish package files {}: {error}",
                profile_path.display()
            ))
        })?,
    )
    .map_err(|error| {
        internal_error(format!(
            "failed to validate profile while selecting publish package files {}: {error}",
            profile_path.display()
        ))
    })?;
    let mut scripts = BTreeSet::new();
    for runner in manifest.runners.values() {
        collect_root_scripts_from_source(&runner.source, &mut scripts);
    }
    Ok(scripts)
}

fn collect_root_scripts_from_source(
    source: &runx_parser::SkillSource,
    scripts: &mut BTreeSet<String>,
) {
    collect_root_scripts_from_command(&source.command, &source.args, scripts);
    if let Some(graph) = &source.graph {
        for step in &graph.steps {
            if let Some(run) = &step.run {
                collect_root_scripts_from_run_object(run, scripts);
            }
        }
    }
}

fn collect_root_scripts_from_run_object(run: &JsonObject, scripts: &mut BTreeSet<String>) {
    let command = json_string(run.get("command"));
    let args = run
        .get("args")
        .and_then(|value| match value {
            JsonValue::Array(values) => Some(
                values
                    .iter()
                    .filter_map(|value| match value {
                        JsonValue::String(value) => Some(value.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        })
        .unwrap_or_default();
    collect_root_scripts_from_command(&command, &args, scripts);
}

fn collect_root_scripts_from_command(
    command: &Option<String>,
    args: &[String],
    scripts: &mut BTreeSet<String>,
) {
    if let Some(command) = command
        && let Some(script) = normalize_consumed_root_script(command)
    {
        scripts.insert(script);
    }
    for arg in args {
        if let Some(script) = normalize_consumed_root_script(arg) {
            scripts.insert(script);
        }
    }
}

fn normalize_consumed_root_script(value: &str) -> Option<String> {
    let script = value
        .trim()
        .strip_prefix("./")
        .unwrap_or_else(|| value.trim());
    if script.contains('/') || script.is_empty() {
        return None;
    }
    (script.ends_with(".mjs") || script.ends_with(".js")).then(|| script.to_owned())
}

fn json_string(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(value)) => Some(value.clone()),
        _ => None,
    }
}

fn should_reject_remote_publish_file(relative: &str) -> bool {
    let Some(file_name) = relative.rsplit('/').next() else {
        return true;
    };
    let lower = file_name.to_ascii_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || matches!(
            lower.as_str(),
            ".npmrc"
                | ".pypirc"
                | ".netrc"
                | "credentials.json"
                | "credential.json"
                | "secrets.json"
                | "secret.json"
                | "id_rsa"
                | "id_ed25519"
        )
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
}

fn colocated_package_harness_path(markdown_path: &Path, profile_path: &Path) -> Option<PathBuf> {
    let profile_file = profile_path.file_name()?.to_str()?;
    if profile_file != "X.yaml" {
        return None;
    }
    let markdown_dir = markdown_path.parent()?;
    let profile_dir = profile_path.parent()?;
    if markdown_dir != profile_dir {
        return None;
    }
    Some(markdown_dir.to_path_buf())
}

fn publish_harness_receipt_dir() -> Result<PathBuf, RegistryCliError> {
    unique_temp_dir("runx-publish-harness")
}

fn unique_temp_dir(prefix: &str) -> Result<PathBuf, RegistryCliError> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| internal_error(error.to_string()))?
        .as_nanos();
    let path = env::temp_dir().join(format!("{prefix}-{}-{nanos}", process::id()));
    fs::create_dir_all(&path).map_err(|error| {
        internal_error(format!(
            "failed to create temporary directory {}: {error}",
            path.display()
        ))
    })?;
    Ok(path)
}

fn publish_harness_report(
    report: runx_runtime::InlineHarnessReport,
) -> RegistryPublishHarnessReport {
    RegistryPublishHarnessReport {
        status: report.status.to_owned(),
        case_count: report.case_count,
        assertion_error_count: report.assertion_error_count,
        assertion_errors: report.assertion_errors,
        case_names: report.case_names,
        receipt_ids: report.receipt_ids,
        graph_case_count: report.graph_case_count,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        collect_publish_package_files, should_reject_remote_publish_file, unique_temp_dir,
    };
    use std::fs;

    #[test]
    fn remote_publish_rejects_common_secret_file_names() {
        for path in [
            ".env",
            ".env.local",
            ".npmrc",
            "credentials.json",
            "nested/secrets.json",
            "private.pem",
            "tls/client.key",
            "id_ed25519",
        ] {
            assert!(
                should_reject_remote_publish_file(path),
                "{path} should not be publishable as a skill package sidecar"
            );
        }
    }

    #[test]
    fn remote_publish_allows_normal_skill_sidecars() {
        for path in ["run.mjs", "run.js", "harness.mjs", "harness.js"] {
            assert!(
                !should_reject_remote_publish_file(path),
                "{path} should remain publishable as a skill package sidecar"
            );
        }
    }

    #[test]
    fn remote_publish_package_includes_consumed_skill_material()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = unique_temp_dir("runx-publish-consumed-material-test")?;
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: sidecars\n---\n# Sidecars\n",
        )?;
        fs::write(
            dir.join("X.yaml"),
            r#"skill: sidecars
runners:
  main:
    default: true
    type: graph
    graph:
      name: sidecars
      steps:
        - id: inspect
          run:
            type: cli-tool
            command: node
            args:
              - ./inspect_repo.mjs
"#,
        )?;
        fs::write(dir.join("run.mjs"), "console.log('run')\n")?;
        fs::write(dir.join("harness.mjs"), "console.log('harness')\n")?;
        fs::write(dir.join("inspect_repo.mjs"), "console.log('root runner')\n")?;
        fs::write(dir.join("notes.txt"), "not packaged\n")?;

        fs::create_dir_all(dir.join("context/review-rubric"))?;
        fs::write(
            dir.join("context/review-rubric/SKILL.md"),
            "---\nname: review-rubric\n---\n# Review\n",
        )?;
        fs::write(
            dir.join("context/review-rubric/X.yaml"),
            "skill: review-rubric\ncatalog:\n  role: context\n",
        )?;

        fs::create_dir_all(dir.join("references"))?;
        fs::write(dir.join("references/operator.md"), "# Operator\n")?;

        fs::create_dir_all(dir.join("tools/frantic/post"))?;
        fs::write(
            dir.join("tools/frantic/post/manifest.json"),
            "{\"schema\":\"runx.tool.manifest.v1\",\"name\":\"frantic.post\"}\n",
        )?;
        fs::write(
            dir.join("tools/frantic/post/run.mjs"),
            "console.log('tool')\n",
        )?;
        fs::create_dir_all(dir.join("tools/frantic/post/src"))?;
        fs::write(
            dir.join("tools/frantic/post/src/index.ts"),
            "console.log('not packaged')\n",
        )?;

        fs::create_dir_all(dir.join("graph/quote"))?;
        fs::write(
            dir.join("graph/quote/SKILL.md"),
            "---\nname: quote-stage\n---\n# Quote\n",
        )?;
        fs::write(dir.join("graph/quote/X.yaml"), "skill: quote-stage\n")?;
        fs::write(dir.join("graph/quote/run.mjs"), "console.log('stage')\n")?;

        fs::create_dir_all(dir.join("push-outbox"))?;
        fs::write(
            dir.join("push-outbox/SKILL.md"),
            "---\nname: push-outbox\n---\n# Push\n",
        )?;
        fs::write(dir.join("push-outbox/manifest.json"), "{}\n")?;

        fs::write(dir.join(".env"), "SECRET=not-packaged\n")?;
        fs::create_dir_all(dir.join("fixtures"))?;
        fs::write(dir.join("fixtures/happy-path.yaml"), "case: happy\n")?;

        let files =
            collect_publish_package_files(&dir.join("SKILL.md"), Some(&dir.join("X.yaml")))?;
        let paths = files.into_iter().map(|file| file.path).collect::<Vec<_>>();

        assert!(paths.contains(&"inspect_repo.mjs".to_owned()));
        assert!(!paths.contains(&"run.mjs".to_owned()));
        assert!(!paths.contains(&"harness.mjs".to_owned()));
        assert!(paths.contains(&"context/review-rubric/SKILL.md".to_owned()));
        assert!(paths.contains(&"context/review-rubric/X.yaml".to_owned()));
        assert!(paths.contains(&"references/operator.md".to_owned()));
        assert!(paths.contains(&"tools/frantic/post/manifest.json".to_owned()));
        assert!(paths.contains(&"tools/frantic/post/run.mjs".to_owned()));
        assert!(paths.contains(&"graph/quote/SKILL.md".to_owned()));
        assert!(paths.contains(&"graph/quote/X.yaml".to_owned()));
        assert!(paths.contains(&"graph/quote/run.mjs".to_owned()));
        assert!(paths.contains(&"push-outbox/SKILL.md".to_owned()));
        assert!(paths.contains(&"push-outbox/manifest.json".to_owned()));
        assert!(!paths.contains(&"notes.txt".to_owned()));
        assert!(!paths.contains(&".env".to_owned()));
        assert!(!paths.contains(&"tools/frantic/post/src/index.ts".to_owned()));
        assert!(!paths.contains(&"fixtures/happy-path.yaml".to_owned()));

        let _ignored = fs::remove_dir_all(dir);
        Ok(())
    }
}

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use runx_contracts::{
    DoctorDiagnostic, DoctorDiagnosticSeverity, DoctorLocation, DoctorRepair,
    DoctorRepairConfidence, DoctorRepairKind, DoctorRepairRisk, DoctorReport, DoctorReportSchema,
    DoctorStatus, DoctorSummary, JsonNumber, JsonObject, JsonValue, sha256_prefixed,
};
use runx_parser::{parse_runner_manifest_yaml, validate_runner_manifest};
use runx_receipts::canonical_stable_json;
use serde::Deserialize;

use crate::RuntimeError;
use crate::filesystem::{find_files_named, read_dir_sorted, read_to_string};
use crate::path_util::{count_yaml_files, lexical_normalize, project_path};
use crate::tool_catalogs::build::hash_tool_source;

// rust-style-allow: large-file - this first doctor slice keeps parity checks and builders together until follow-up diagnostics add natural module boundaries.

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DoctorOptions;

#[derive(Deserialize)]
struct ToolManifestProbe {
    source_hash: Option<String>,
}

#[must_use]
pub fn default_doctor_options() -> DoctorOptions {
    DoctorOptions
}

pub fn run_doctor(root: &Path, options: &DoctorOptions) -> Result<DoctorReport, RuntimeError> {
    let _ = options;
    let root = lexical_normalize(root);

    let mut diagnostics = Vec::new();
    diagnostics.extend(discover_cross_package_reach_in_diagnostics(&root)?);
    diagnostics.extend(discover_tool_diagnostics(&root)?);
    diagnostics.extend(discover_skill_diagnostics(&root)?);
    diagnostics.sort_by(|left, right| {
        left.location
            .path
            .cmp(&right.location.path)
            .then_with(|| left.id.cmp(&right.id))
    });

    let summary = summary(&diagnostics);
    let status = if summary.errors > 0 {
        DoctorStatus::Failure
    } else {
        DoctorStatus::Success
    };
    Ok(DoctorReport {
        schema: DoctorReportSchema::V1,
        status,
        summary,
        diagnostics,
    })
}

// rust-style-allow: long-function - cross-package reach-in parity mirrors the TypeScript scanner in one read-only pass.
fn discover_cross_package_reach_in_diagnostics(
    root: &Path,
) -> Result<Vec<DoctorDiagnostic>, RuntimeError> {
    let packages_root = root.join("packages");
    if !packages_root.exists() {
        return Ok(Vec::new());
    }

    let mut diagnostics = Vec::new();
    for entry in list_source_files(&packages_root)? {
        let Some(source_package) = workspace_package_name(root, &entry) else {
            continue;
        };
        let contents = read_to_string(&entry)?;
        for specifier in extract_import_specifiers(&contents) {
            if !specifier.starts_with('.') {
                continue;
            }
            let resolved = lexical_normalize(
                &entry
                    .parent()
                    .map_or_else(PathBuf::new, Path::to_path_buf)
                    .join(&specifier),
            );
            let target_segments = project_segments(root, &resolved);
            if target_segments.len() < 3
                || target_segments[0] != "packages"
                || target_segments[2] != "src"
            {
                continue;
            }
            let target_package = target_segments[1].clone();
            if target_package == source_package {
                continue;
            }

            let source_path = project_path(root, &entry);
            let resolved_path = project_path(root, &resolved);
            let target = object([
                ("kind", string_value("workspace")),
                ("ref", string_value(&source_path)),
            ]);
            let location = DoctorLocation {
                path: source_path.clone(),
                json_pointer: None,
            };
            let evidence = object([
                ("specifier", string_value(&specifier)),
                ("source_package", string_value(&source_package)),
                ("target_package", string_value(&target_package)),
                ("resolved_path", string_value(&resolved_path)),
            ]);
            diagnostics.push(create_diagnostic(DiagnosticParts {
                id: "runx.structure.cross_package_reach_in",
                severity: DoctorDiagnosticSeverity::Error,
                title: "Cross-package src reach-in is forbidden",
                message: format!(
                    "{source_path} imports {specifier}, reaching into packages/{target_package}/src directly."
                ),
                target,
                location,
                evidence: Some(evidence),
                repairs: vec![manual_repair(
                    "replace_with_package_boundary_import",
                    DoctorRepairConfidence::High,
                    DoctorRepairRisk::Low,
                    false,
                )],
            })?);
        }
    }
    Ok(diagnostics)
}

// rust-style-allow: long-function - tool diagnostics keep manifest, fixture, and
// generated repair evidence in one read-only pass.
fn discover_tool_diagnostics(root: &Path) -> Result<Vec<DoctorDiagnostic>, RuntimeError> {
    let tools_root = root.join("tools");
    let mut diagnostics = Vec::new();
    for namespace_entry in read_dir_sorted(&tools_root)? {
        if !namespace_entry.is_dir {
            continue;
        }
        for tool_entry in read_dir_sorted(&namespace_entry.path)? {
            if !tool_entry.is_dir {
                continue;
            }
            let tool_dir = tool_entry.path;
            let tool_ref = format!("{}.{}", namespace_entry.name, tool_entry.name);
            let removed_format_path = tool_dir.join("tool.yaml");
            if removed_format_path.exists() {
                diagnostics.push(removed_tool_yaml_diagnostic(
                    root,
                    &tool_ref,
                    &removed_format_path,
                )?);
            }

            let manifest_path = tool_dir.join("manifest.json");
            if !manifest_path.exists() {
                continue;
            }
            let manifest_contents = read_to_string(&manifest_path)?;
            let manifest = serde_json::from_str::<ToolManifestProbe>(&manifest_contents).map_err(
                |source| {
                    RuntimeError::json(
                        format!(
                            "reading tool manifest {}",
                            project_path(root, &manifest_path)
                        ),
                        source,
                    )
                },
            )?;
            if let Some(source_hash) = &manifest.source_hash {
                let actual_source_hash = hash_tool_source(&tool_dir).map_err(|source| {
                    RuntimeError::effect_state("checking tool manifest source hash", source)
                })?;
                if source_hash != &actual_source_hash {
                    diagnostics.push(tool_manifest_stale_diagnostic(
                        root,
                        &tool_ref,
                        &manifest_path,
                        &tool_dir,
                        &actual_source_hash,
                        source_hash,
                    )?);
                }
            }
            let fixture_count = count_yaml_files(&tool_dir.join("fixtures"))?;
            if fixture_count == 0 {
                diagnostics.push(tool_fixture_missing_diagnostic(
                    root,
                    &tool_ref,
                    &manifest_path,
                    &tool_dir.join("fixtures"),
                    fixture_count,
                )?);
            }
        }
    }
    Ok(diagnostics)
}

fn removed_tool_yaml_diagnostic(
    root: &Path,
    tool_ref: &str,
    removed_format_path: &Path,
) -> Result<DoctorDiagnostic, RuntimeError> {
    let location_path = project_path(root, removed_format_path);
    let expected_manifest =
        project_path(root, &removed_format_path.with_file_name("manifest.json"));
    let target = object([
        ("kind", string_value("tool")),
        ("ref", string_value(tool_ref)),
    ]);
    let location = DoctorLocation {
        path: location_path.clone(),
        json_pointer: None,
    };
    let evidence = object([("expected_manifest", string_value(&expected_manifest))]);
    create_diagnostic(DiagnosticParts {
        id: "runx.tool.manifest.removed_format",
        severity: DoctorDiagnosticSeverity::Error,
        title: "tool.yaml is no longer supported",
        message: format!("Tool {tool_ref} still uses tool.yaml. Runx resolves manifest.json only."),
        target,
        location,
        evidence: Some(evidence),
        repairs: vec![manual_repair(
            "replace_removed_tool_manifest",
            DoctorRepairConfidence::High,
            DoctorRepairRisk::Medium,
            true,
        )],
    })
}

fn tool_fixture_missing_diagnostic(
    root: &Path,
    tool_ref: &str,
    manifest_path: &Path,
    fixtures_path: &Path,
    fixture_count: u64,
) -> Result<DoctorDiagnostic, RuntimeError> {
    let location_path = project_path(root, manifest_path);
    let expected_location = project_path(root, fixtures_path);
    let target = object([
        ("kind", string_value("tool")),
        ("ref", string_value(tool_ref)),
    ]);
    let location = DoctorLocation {
        path: location_path.clone(),
        json_pointer: None,
    };
    let evidence = object([
        ("fixture_count", number_value(fixture_count)),
        ("expected_location", string_value(&expected_location)),
    ]);
    create_diagnostic(DiagnosticParts {
        id: "runx.tool.fixture.missing",
        severity: DoctorDiagnosticSeverity::Error,
        title: "Tool has no deterministic fixture",
        message: format!("Tool {tool_ref} declares a manifest but has no deterministic fixture."),
        target,
        location,
        evidence: Some(evidence),
        repairs: vec![manual_repair(
            "add_tool_fixture",
            DoctorRepairConfidence::Medium,
            DoctorRepairRisk::Low,
            false,
        )],
    })
}

fn tool_manifest_stale_diagnostic(
    root: &Path,
    tool_ref: &str,
    manifest_path: &Path,
    tool_dir: &Path,
    expected_hash: &str,
    actual_hash: &str,
) -> Result<DoctorDiagnostic, RuntimeError> {
    let location_path = project_path(root, manifest_path);
    let tool_path = project_path(root, tool_dir);
    let target = object([
        ("kind", string_value("tool")),
        ("ref", string_value(tool_ref)),
    ]);
    let location = DoctorLocation {
        path: location_path.clone(),
        json_pointer: Some("/source_hash".to_owned()),
    };
    let evidence = object([
        ("expected", string_value(expected_hash)),
        ("actual", string_value(actual_hash)),
    ]);
    create_diagnostic(DiagnosticParts {
        id: "runx.tool.manifest.stale",
        severity: DoctorDiagnosticSeverity::Error,
        title: "Tool manifest is stale",
        message: format!("Tool {tool_ref} source_hash does not match current source files."),
        target,
        location,
        evidence: Some(evidence),
        repairs: vec![run_command_repair(
            "rebuild_tool_manifest",
            format!("runx tool build {tool_path}"),
            DoctorRepairConfidence::High,
            DoctorRepairRisk::Low,
            false,
        )],
    })
}

fn discover_skill_diagnostics(root: &Path) -> Result<Vec<DoctorDiagnostic>, RuntimeError> {
    let mut diagnostics = Vec::new();
    for profile_path in discover_skill_profile_paths(root)? {
        let contents = read_to_string(&profile_path)?;
        if !contents.contains("runners:") {
            continue;
        }
        let skill_dir = profile_path.parent().map_or(root, |parent| parent);
        let skill_name = skill_dir.file_name().map_or_else(
            || ".".to_owned(),
            |name| name.to_string_lossy().into_owned(),
        );
        if let Err(message) = validate_skill_profile(&contents) {
            diagnostics.push(skill_profile_invalid_diagnostic(
                root,
                &profile_path,
                &skill_name,
                &message,
            )?);
            continue;
        }
        let coverage_root = skill_coverage_root(root, &profile_path);
        let fixture_count = count_yaml_files(&coverage_root.join("fixtures"))?;
        let mut harness_case_count = inline_harness_case_count(&contents);
        let package_profile = coverage_root.join("X.yaml");
        if package_profile != profile_path && package_profile.is_file() {
            harness_case_count += inline_harness_case_count(&read_to_string(&package_profile)?);
        }
        if fixture_count == 0 && harness_case_count == 0 {
            diagnostics.push(skill_fixture_missing_diagnostic(
                root,
                &profile_path,
                &skill_name,
                fixture_count,
                harness_case_count,
            )?);
        }
    }
    Ok(diagnostics)
}

fn skill_coverage_root(root: &Path, profile_path: &Path) -> PathBuf {
    let skills_root = root.join("skills");
    let Ok(relative) = profile_path.strip_prefix(&skills_root) else {
        return profile_path.parent().unwrap_or(root).to_path_buf();
    };
    let components = relative.components().collect::<Vec<_>>();
    let Some(graph_index) = components
        .iter()
        .position(|component| component.as_os_str() == "graph")
    else {
        return profile_path.parent().unwrap_or(root).to_path_buf();
    };
    components[..graph_index]
        .iter()
        .fold(skills_root, |path, component| path.join(component))
}

/// Parse and validate a skill execution profile (X.yaml) the same way the
/// publish path does, so doctor catches an invalid harness status, an unknown
/// runner shape, or malformed YAML before publish rather than at publish time.
fn validate_skill_profile(contents: &str) -> Result<(), String> {
    let raw = parse_runner_manifest_yaml(contents).map_err(|error| error.to_string())?;
    validate_runner_manifest(raw).map_err(|error| error.to_string())?;
    Ok(())
}

fn skill_fixture_missing_diagnostic(
    root: &Path,
    profile_path: &Path,
    skill_name: &str,
    fixture_count: u64,
    harness_case_count: u64,
) -> Result<DoctorDiagnostic, RuntimeError> {
    let location_path = project_path(root, profile_path);
    let target = object([
        ("kind", string_value("skill")),
        ("ref", string_value(skill_name)),
    ]);
    let location = DoctorLocation {
        path: location_path.clone(),
        json_pointer: Some("/harness".to_owned()),
    };
    let evidence = object([
        ("fixture_count", number_value(fixture_count)),
        ("harness_case_count", number_value(harness_case_count)),
    ]);
    create_diagnostic(DiagnosticParts {
        id: "runx.skill.fixture.missing",
        severity: DoctorDiagnosticSeverity::Error,
        title: "Skill has no harness coverage",
        message: format!(
            "Skill {skill_name} declares an execution profile but has no fixtures or inline harness.cases."
        ),
        target,
        location,
        evidence: Some(evidence),
        repairs: vec![manual_repair(
            "add_inline_harness_case",
            DoctorRepairConfidence::Medium,
            DoctorRepairRisk::Low,
            false,
        )],
    })
}

fn skill_profile_invalid_diagnostic(
    root: &Path,
    profile_path: &Path,
    skill_name: &str,
    message: &str,
) -> Result<DoctorDiagnostic, RuntimeError> {
    let location_path = project_path(root, profile_path);
    let target = object([
        ("kind", string_value("skill")),
        ("ref", string_value(skill_name)),
    ]);
    let location = DoctorLocation {
        path: location_path.clone(),
        json_pointer: Some("/runners".to_owned()),
    };
    let evidence = object([("error", string_value(message))]);
    create_diagnostic(DiagnosticParts {
        id: "runx.skill.profile.invalid",
        severity: DoctorDiagnosticSeverity::Error,
        title: "Skill execution profile is invalid",
        message: format!("Skill {skill_name} has an invalid execution profile: {message}"),
        target,
        location,
        evidence: Some(evidence),
        repairs: vec![manual_repair(
            "fix_execution_profile",
            DoctorRepairConfidence::High,
            DoctorRepairRisk::Low,
            true,
        )],
    })
}

struct DiagnosticParts {
    id: &'static str,
    severity: DoctorDiagnosticSeverity,
    title: &'static str,
    message: String,
    target: JsonObject,
    location: DoctorLocation,
    evidence: Option<JsonObject>,
    repairs: Vec<DoctorRepair>,
}

fn create_diagnostic(parts: DiagnosticParts) -> Result<DoctorDiagnostic, RuntimeError> {
    let instance_id = diagnostic_instance_id(
        parts.id,
        &parts.target,
        &parts.location,
        parts.evidence.as_ref(),
    )?;
    Ok(DoctorDiagnostic {
        id: parts.id.to_owned(),
        instance_id,
        severity: parts.severity,
        title: parts.title.to_owned(),
        message: parts.message,
        target: parts.target,
        location: parts.location,
        evidence: parts.evidence,
        repairs: parts.repairs,
    })
}

/// Canonical, order-independent identity hash of a diagnostic.
///
/// The hash material is the single typed source of truth (`target`,
/// `location`, `evidence`) assembled into a `JsonObject` (a `BTreeMap`, sorted
/// at every level) and rendered through the shared `runx.stable-json.v1`
/// canonical writer. The TypeScript doctor mirrors this exactly via
/// `canonicalJsonStringify({id, target, location, evidence})`, so both
/// languages produce byte-identical canonical JSON and identical ids.
fn diagnostic_instance_id(
    id: &str,
    target: &JsonObject,
    location: &DoctorLocation,
    evidence: Option<&JsonObject>,
) -> Result<String, RuntimeError> {
    let mut material: JsonObject = BTreeMap::new();
    material.insert("id".to_owned(), JsonValue::String(id.to_owned()));
    material.insert("target".to_owned(), JsonValue::Object(target.clone()));
    material.insert(
        "location".to_owned(),
        JsonValue::Object(location_object(location)),
    );
    if let Some(evidence) = evidence {
        material.insert("evidence".to_owned(), JsonValue::Object(evidence.clone()));
    }
    let canonical = canonical_stable_json(&JsonValue::Object(material)).map_err(|source| {
        RuntimeError::effect_state("canonicalizing doctor hash material", source)
    })?;
    Ok(sha256_prefixed(canonical.as_bytes()))
}

/// Convert a typed `DoctorLocation` into its canonical-hash object form,
/// omitting `json_pointer` when absent so the hash material matches the
/// serialized wire shape (which skips `None`).
fn location_object(location: &DoctorLocation) -> JsonObject {
    let mut object: JsonObject = BTreeMap::new();
    object.insert("path".to_owned(), JsonValue::String(location.path.clone()));
    if let Some(json_pointer) = &location.json_pointer {
        object.insert(
            "json_pointer".to_owned(),
            JsonValue::String(json_pointer.clone()),
        );
    }
    object
}

fn manual_repair(
    id: &str,
    confidence: DoctorRepairConfidence,
    risk: DoctorRepairRisk,
    requires_human_review: bool,
) -> DoctorRepair {
    DoctorRepair {
        id: id.to_owned(),
        kind: DoctorRepairKind::Manual,
        confidence,
        risk,
        path: None,
        json_pointer: None,
        contents: None,
        patch: None,
        command: None,
        requires_human_review,
    }
}

fn run_command_repair(
    id: &str,
    command: String,
    confidence: DoctorRepairConfidence,
    risk: DoctorRepairRisk,
    requires_human_review: bool,
) -> DoctorRepair {
    DoctorRepair {
        id: id.to_owned(),
        kind: DoctorRepairKind::RunCommand,
        confidence,
        risk,
        path: None,
        json_pointer: None,
        contents: None,
        patch: None,
        command: Some(command),
        requires_human_review,
    }
}

fn summary(diagnostics: &[DoctorDiagnostic]) -> DoctorSummary {
    let mut errors = 0;
    let mut warnings = 0;
    let mut infos = 0;
    for diagnostic in diagnostics {
        match diagnostic.severity {
            DoctorDiagnosticSeverity::Error => errors += 1,
            DoctorDiagnosticSeverity::Warning => warnings += 1,
            DoctorDiagnosticSeverity::Info => infos += 1,
        }
    }
    DoctorSummary {
        errors,
        warnings,
        infos,
    }
}

fn discover_skill_profile_paths(root: &Path) -> Result<Vec<PathBuf>, RuntimeError> {
    let mut paths = Vec::new();
    let root_profile = root.join("X.yaml");
    if root_profile.exists() {
        paths.push(root_profile);
    }
    paths.extend(find_files_named(&root.join("skills"), "X.yaml")?);
    paths.sort();
    Ok(paths)
}

fn inline_harness_case_count(contents: &str) -> u64 {
    if contents.contains("harness:") && contents.contains("cases:") {
        1
    } else {
        0
    }
}

fn list_source_files(directory: &Path) -> Result<Vec<PathBuf>, RuntimeError> {
    let mut files = Vec::new();
    for entry in read_dir_sorted(directory)? {
        if entry.name == "dist" || entry.name == "node_modules" {
            continue;
        }
        if entry.is_dir {
            files.extend(list_source_files(&entry.path)?);
        } else if entry.is_file && is_source_path(&entry.path) {
            files.push(entry.path);
        }
    }
    files.sort();
    Ok(files)
}

fn is_source_path(path: &Path) -> bool {
    path.extension()
        .map(|extension| {
            matches!(
                extension.to_string_lossy().as_ref(),
                "ts" | "tsx" | "js" | "jsx" | "mts" | "mjs" | "cts" | "cjs"
            )
        })
        .unwrap_or(false)
}

fn extract_import_specifiers(contents: &str) -> Vec<String> {
    let mut specifiers = Vec::new();
    for line in contents.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("import ") && !trimmed.starts_with("export ") {
            continue;
        }
        for quote in ['"', '\''] {
            let Some(start) = trimmed.find(quote) else {
                continue;
            };
            let rest = &trimmed[start + quote.len_utf8()..];
            let Some(end) = rest.find(quote) else {
                continue;
            };
            let specifier = rest[..end].to_owned();
            if !specifiers.contains(&specifier) {
                specifiers.push(specifier);
            }
        }
    }
    specifiers
}

fn workspace_package_name(root: &Path, file_path: &Path) -> Option<String> {
    let segments = project_segments(root, file_path);
    if segments
        .first()
        .is_some_and(|segment| segment == "packages")
    {
        segments.get(1).cloned()
    } else {
        None
    }
}

fn project_segments(root: &Path, path: &Path) -> Vec<String> {
    project_path(root, path)
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn object(entries: impl IntoIterator<Item = (&'static str, JsonValue)>) -> JsonObject {
    BTreeMap::from_iter(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value)),
    )
}

fn string_value(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}

fn number_value(value: u64) -> JsonValue {
    JsonValue::Number(JsonNumber::U64(value))
}

#[cfg(test)]
mod tests {
    use super::validate_skill_profile;

    const VALID_PROFILE: &str = r#"
runners:
  main:
    default: true
    type: agent-task
    agent: builder
    task: probe
    outputs:
      result: string
    inputs:
      objective:
        type: string
        required: true
        description: "x"
harness:
  cases:
    - name: ok
      inputs:
        objective: x
      caller:
        answers:
          agent_task.probe.output:
            result: ok
      expect:
        status: sealed
        receipt:
          schema: runx.receipt.v1
          state: sealed
          disposition: closed
"#;

    const INVALID_HARNESS_STATUS_PROFILE: &str = r#"
runners:
  main:
    default: true
    type: agent-task
    agent: builder
    task: probe
    outputs:
      result: string
    inputs:
      objective:
        type: string
        required: true
        description: "x"
harness:
  cases:
    - name: bad
      inputs:
        objective: x
      caller:
        answers:
          agent_task.probe.output:
            result: ok
      expect:
        status: success
        receipt:
          schema: runx.receipt.v1
          state: sealed
          disposition: closed
"#;

    #[test]
    fn valid_execution_profile_passes() {
        assert!(validate_skill_profile(VALID_PROFILE).is_ok());
    }

    #[test]
    fn invalid_harness_status_is_rejected() {
        let result = validate_skill_profile(INVALID_HARNESS_STATUS_PROFILE);
        assert!(
            result.is_err(),
            "an invalid harness expect.status must be rejected by doctor"
        );
        if let Err(message) = result {
            assert!(
                message.contains("must be sealed"),
                "unexpected error message: {message}"
            );
        }
    }
}

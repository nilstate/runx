// rust-style-allow: large-file because native list discovery intentionally keeps
// tool, skill, graph, packet, and overlay projection in one audited cutover
// surface until the TypeScript list command is fully retired.
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub use runx_contracts::{
    RunxListEmit, RunxListItem, RunxListItemKind, RunxListReport, RunxListRequestedKind,
    RunxListSchema, RunxListSource, RunxListStatus,
};
use serde::Deserialize;

use crate::RuntimeError;
use crate::filesystem::{read_dir_sorted, read_to_string};
use crate::path_util::{count_yaml_files, display_path, lexical_normalize, project_path};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunxListOptions {
    pub root: PathBuf,
    pub requested_kind: RunxListRequestedKind,
}

#[must_use]
pub fn default_list_options(root: PathBuf) -> RunxListOptions {
    RunxListOptions {
        root,
        requested_kind: RunxListRequestedKind::All,
    }
}

pub fn list_authoring_primitives(
    options: &RunxListOptions,
) -> Result<RunxListReport, RuntimeError> {
    let root = lexical_normalize(&options.root);
    let mut items = discover_list_items(&root, options.requested_kind)?;
    sort_list_items(&mut items);
    Ok(RunxListReport {
        schema: RunxListSchema::V1,
        root: display_path(&root),
        requested_kind: options.requested_kind,
        items,
    })
}

fn discover_list_items(
    root: &Path,
    requested_kind: RunxListRequestedKind,
) -> Result<Vec<RunxListItem>, RuntimeError> {
    let mut items = Vec::new();
    if matches!(
        requested_kind,
        RunxListRequestedKind::All | RunxListRequestedKind::Tools
    ) {
        items.extend(discover_tool_list_items(root)?);
    }
    if matches!(
        requested_kind,
        RunxListRequestedKind::All | RunxListRequestedKind::Skills | RunxListRequestedKind::Graphs
    ) {
        items.extend(
            discover_skill_and_graph_list_items(root)?
                .into_iter()
                .filter(|item| match requested_kind {
                    RunxListRequestedKind::All => true,
                    RunxListRequestedKind::Skills => {
                        matches!(item.kind, RunxListItemKind::Skill | RunxListItemKind::Graph)
                    }
                    RunxListRequestedKind::Graphs => item.kind == RunxListItemKind::Graph,
                    _ => false,
                }),
        );
    }
    if matches!(
        requested_kind,
        RunxListRequestedKind::All | RunxListRequestedKind::Packets
    ) {
        items.extend(discover_packet_list_items(root)?);
    }
    if matches!(
        requested_kind,
        RunxListRequestedKind::All | RunxListRequestedKind::Overlays
    ) {
        items.extend(discover_overlay_list_items(root)?);
    }
    Ok(items)
}

fn discover_tool_list_items(root: &Path) -> Result<Vec<RunxListItem>, RuntimeError> {
    let tools_root = root.join("tools");
    let mut items = Vec::new();
    for namespace_entry in read_dir_sorted(&tools_root)? {
        if !namespace_entry.is_dir {
            continue;
        }
        for tool_entry in read_dir_sorted(&namespace_entry.path)? {
            if !tool_entry.is_dir {
                continue;
            }
            let manifest_path = tool_entry.path.join("manifest.json");
            if !manifest_path.exists() {
                continue;
            }
            let relative_path = project_path(root, &manifest_path);
            match read_validated_tool_manifest(&manifest_path) {
                Ok(tool) => items.push(RunxListItem {
                    kind: RunxListItemKind::Tool,
                    name: tool.name,
                    source: RunxListSource::Local,
                    path: relative_path,
                    status: RunxListStatus::Ok,
                    diagnostics: None,
                    scopes: Some(tool.scopes),
                    emits: tool
                        .artifacts
                        .as_ref()
                        .map(tool_emits)
                        .filter(|items| !items.is_empty()),
                    fixtures: Some(count_yaml_files(&tool_entry.path.join("fixtures"))?),
                    harness_cases: None,
                    steps: None,
                    wraps: None,
                }),
                Err(()) => items.push(invalid_item(
                    RunxListItemKind::Tool,
                    format!("{}.{}", namespace_entry.name, tool_entry.name),
                    relative_path,
                    "runx.tool.manifest.invalid",
                )),
            }
        }
    }
    Ok(items)
}

fn read_validated_tool_manifest(manifest_path: &Path) -> Result<runx_parser::ValidatedTool, ()> {
    let source = fs::read_to_string(manifest_path).map_err(|_| ())?;
    let raw = runx_parser::parse_tool_manifest_json(&source).map_err(|_| ())?;
    runx_parser::validate_tool_manifest(raw).map_err(|_| ())
}

fn tool_emits(artifacts: &runx_parser::SkillArtifactContract) -> Vec<RunxListEmit> {
    if let Some(named_emits) = &artifacts.named_emits {
        return named_emits
            .iter()
            .map(|(name, packet)| RunxListEmit {
                name: name.clone(),
                packet: Some(packet.clone()),
            })
            .collect();
    }
    artifacts
        .wrap_as
        .iter()
        .map(|name| RunxListEmit {
            name: name.clone(),
            packet: None,
        })
        .collect()
}

fn discover_skill_and_graph_list_items(root: &Path) -> Result<Vec<RunxListItem>, RuntimeError> {
    let mut items = Vec::new();
    for profile_path in discover_skill_profile_paths(root)? {
        let skill_dir = profile_path.parent().map_or(root, |parent| parent);
        let fallback_name = fallback_skill_name(root, skill_dir);
        let relative_path = project_path(root, &profile_path);
        match read_validated_runner_manifest(&profile_path) {
            Ok(manifest) => {
                let graph_steps = manifest
                    .runners
                    .values()
                    .filter_map(|runner| {
                        runner
                            .source
                            .graph
                            .as_ref()
                            .map(|graph| graph.steps.len() as u64)
                    })
                    .collect::<Vec<_>>();
                let is_graph = !graph_steps.is_empty();
                items.push(RunxListItem {
                    kind: if is_graph {
                        RunxListItemKind::Graph
                    } else {
                        RunxListItemKind::Skill
                    },
                    name: manifest.skill.unwrap_or(fallback_name),
                    source: RunxListSource::Local,
                    path: relative_path,
                    status: RunxListStatus::Ok,
                    diagnostics: None,
                    scopes: None,
                    emits: None,
                    fixtures: Some(count_yaml_files(&skill_dir.join("fixtures"))?),
                    harness_cases: Some(
                        manifest
                            .harness
                            .as_ref()
                            .map_or(0, |harness| harness.cases.len() as u64),
                    ),
                    steps: is_graph.then(|| graph_steps.iter().sum()),
                    wraps: None,
                });
            }
            Err(()) => items.push(invalid_item(
                RunxListItemKind::Skill,
                fallback_name,
                relative_path,
                "runx.skill.profile.invalid",
            )),
        }
    }
    Ok(items)
}

fn read_validated_runner_manifest(
    profile_path: &Path,
) -> Result<runx_parser::SkillRunnerManifest, ()> {
    let source = fs::read_to_string(profile_path).map_err(|_| ())?;
    let raw = runx_parser::parse_runner_manifest_yaml(&source).map_err(|_| ())?;
    runx_parser::validate_runner_manifest(raw).map_err(|_| ())
}

// rust-style-allow: long-function because packet discovery keeps glob expansion,
// schema-id extraction, and duplicate-id diagnostics in one deterministic pass.
fn discover_packet_list_items(root: &Path) -> Result<Vec<RunxListItem>, RuntimeError> {
    let package_json_path = root.join("package.json");
    if !package_json_path.exists() {
        return Ok(Vec::new());
    }

    let source = read_to_string(&package_json_path)?;
    let package_json = match serde_json::from_str::<PackageJson>(&source) {
        Ok(package_json) => package_json,
        Err(_) => {
            return Ok(vec![invalid_item(
                RunxListItemKind::Packet,
                "package.json".to_owned(),
                "package.json".to_owned(),
                "runx.packet.package.invalid",
            )]);
        }
    };

    let mut items = Vec::new();
    let mut seen = BTreeMap::<String, String>::new();
    for packet_glob in package_json
        .runx
        .as_ref()
        .map(|runx| runx.packets.as_slice())
        .unwrap_or_default()
    {
        let files = expand_local_glob(root, packet_glob)?;
        if files.is_empty() {
            items.push(invalid_item(
                RunxListItemKind::Packet,
                packet_glob.clone(),
                "package.json".to_owned(),
                "runx.packet.ref.missing",
            ));
            continue;
        }
        for file_path in files {
            let relative_path = project_path(root, &file_path);
            let source = match fs::read_to_string(&file_path) {
                Ok(source) => source,
                Err(_) => {
                    items.push(invalid_item(
                        RunxListItemKind::Packet,
                        relative_path.clone(),
                        relative_path,
                        "runx.packet.schema.invalid",
                    ));
                    continue;
                }
            };
            let schema = match serde_json::from_str::<PacketSchema>(&source) {
                Ok(schema) => schema,
                _ => {
                    items.push(invalid_item(
                        RunxListItemKind::Packet,
                        relative_path.clone(),
                        relative_path,
                        "runx.packet.schema.invalid",
                    ));
                    continue;
                }
            };
            let Some(packet_id) = packet_id(&schema) else {
                items.push(invalid_item(
                    RunxListItemKind::Packet,
                    relative_path.clone(),
                    relative_path,
                    "runx.packet.id.mismatch",
                ));
                continue;
            };
            if let Some(existing_source) = seen.get(&packet_id) {
                if existing_source != &source {
                    items.push(invalid_item(
                        RunxListItemKind::Packet,
                        packet_id,
                        relative_path,
                        "runx.packet.id.collision",
                    ));
                    continue;
                }
            }
            seen.insert(packet_id.clone(), source);
            items.push(RunxListItem {
                kind: RunxListItemKind::Packet,
                name: packet_id,
                source: RunxListSource::Local,
                path: relative_path,
                status: RunxListStatus::Ok,
                diagnostics: None,
                scopes: None,
                emits: None,
                fixtures: None,
                harness_cases: None,
                steps: None,
                wraps: None,
            });
        }
    }
    Ok(items)
}

fn discover_overlay_list_items(root: &Path) -> Result<Vec<RunxListItem>, RuntimeError> {
    let overlays_root = root.join("skills-overlays");
    let mut items = Vec::new();
    for vendor_entry in read_dir_sorted(&overlays_root)? {
        if !vendor_entry.is_dir {
            continue;
        }
        for skill_entry in read_dir_sorted(&vendor_entry.path)? {
            if !skill_entry.is_dir {
                continue;
            }
            let profile_path = skill_entry.path.join("X.yaml");
            if !profile_path.exists() {
                continue;
            }
            let contents = read_to_string(&profile_path)?;
            items.push(RunxListItem {
                kind: RunxListItemKind::Overlay,
                name: format!("{}/{}", vendor_entry.name, skill_entry.name),
                source: RunxListSource::Local,
                path: project_path(root, &profile_path),
                status: RunxListStatus::Ok,
                diagnostics: None,
                scopes: None,
                emits: None,
                fixtures: None,
                harness_cases: None,
                steps: None,
                wraps: overlay_wraps(&contents),
            });
        }
    }
    Ok(items)
}

fn invalid_item(
    kind: RunxListItemKind,
    name: String,
    path: String,
    diagnostic: &str,
) -> RunxListItem {
    RunxListItem {
        kind,
        name,
        source: RunxListSource::Local,
        path,
        status: RunxListStatus::Invalid,
        diagnostics: Some(vec![diagnostic.to_owned()]),
        scopes: None,
        emits: None,
        fixtures: None,
        harness_cases: None,
        steps: None,
        wraps: None,
    }
}

#[derive(Deserialize)]
struct PackageJson {
    runx: Option<PackageRunxConfig>,
}

#[derive(Deserialize)]
struct PackageRunxConfig {
    #[serde(default)]
    packets: Vec<String>,
}

#[derive(Deserialize)]
struct PacketSchema {
    #[serde(rename = "x-runx-packet-id")]
    packet_id: Option<String>,
    #[serde(rename = "$id")]
    schema_id: Option<String>,
}

fn packet_id(schema: &PacketSchema) -> Option<String> {
    schema
        .packet_id
        .as_deref()
        .or(schema.schema_id.as_deref())
        .map(str::to_owned)
}

fn expand_local_glob(root: &Path, glob: &str) -> Result<Vec<PathBuf>, RuntimeError> {
    if !glob.contains('*') {
        let path = root.join(glob);
        return Ok(path.exists().then_some(path).into_iter().collect());
    }

    let normalized = glob.replace('\\', "/");
    let Some(star) = normalized.find('*') else {
        return Ok(Vec::new());
    };
    let base = &normalized[..star];
    let base_dir = base.rfind('/').map_or("", |slash| &base[..=slash]);
    let suffix = &normalized[star + 1..];
    let mut files = read_dir_sorted(&root.join(base_dir))?
        .into_iter()
        .filter(|entry| entry.is_file && display_path(&entry.path).ends_with(suffix))
        .map(|entry| entry.path)
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

fn discover_skill_profile_paths(root: &Path) -> Result<Vec<PathBuf>, RuntimeError> {
    let mut paths = Vec::new();
    let root_profile = root.join("X.yaml");
    if root_profile.exists() {
        paths.push(root_profile);
    }
    for skill_entry in read_dir_sorted(&root.join("skills"))? {
        if !skill_entry.is_dir {
            continue;
        }
        let profile_path = skill_entry.path.join("X.yaml");
        if profile_path.exists() {
            paths.push(profile_path);
        }
    }
    paths.sort();
    Ok(paths)
}

fn fallback_skill_name(root: &Path, skill_dir: &Path) -> String {
    if skill_dir == root {
        return root.file_name().map_or_else(
            || ".".to_owned(),
            |name| name.to_string_lossy().into_owned(),
        );
    }
    skill_dir.file_name().map_or_else(
        || ".".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

fn overlay_wraps(contents: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix("wraps:")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn sort_list_items(items: &mut [RunxListItem]) {
    items.sort_by(|left, right| {
        source_order(left.source)
            .cmp(&source_order(right.source))
            .then_with(|| kind_order(left.kind).cmp(&kind_order(right.kind)))
            .then_with(|| left.name.cmp(&right.name))
    });
}

fn source_order(source: RunxListSource) -> u8 {
    match source {
        RunxListSource::Local => 0,
        RunxListSource::Workspace => 1,
        RunxListSource::Dependencies => 2,
        RunxListSource::BuiltIn => 3,
    }
}

fn kind_order(kind: RunxListItemKind) -> u8 {
    match kind {
        RunxListItemKind::Tool => 0,
        RunxListItemKind::Skill => 1,
        RunxListItemKind::Graph => 2,
        RunxListItemKind::Packet => 3,
        RunxListItemKind::Overlay => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_wraps_reads_plain_wraps_line() {
        assert_eq!(
            overlay_wraps("name: demo\n  wraps: vendor/base\n"),
            Some("vendor/base".to_owned())
        );
    }

    #[test]
    fn sorts_by_kind_then_name() {
        let mut items = vec![
            valid_item(RunxListItemKind::Packet, "b"),
            valid_item(RunxListItemKind::Tool, "z"),
            valid_item(RunxListItemKind::Tool, "a"),
            valid_item(RunxListItemKind::Skill, "a"),
        ];
        sort_list_items(&mut items);
        assert_eq!(
            items
                .iter()
                .map(|item| (item.kind, item.name.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (RunxListItemKind::Tool, "a"),
                (RunxListItemKind::Tool, "z"),
                (RunxListItemKind::Skill, "a"),
                (RunxListItemKind::Packet, "b"),
            ]
        );
    }

    fn valid_item(kind: RunxListItemKind, name: &str) -> RunxListItem {
        RunxListItem {
            kind,
            name: name.to_owned(),
            source: RunxListSource::Local,
            path: ".".to_owned(),
            status: RunxListStatus::Ok,
            diagnostics: None,
            scopes: None,
            emits: None,
            fixtures: None,
            harness_cases: None,
            steps: None,
            wraps: None,
        }
    }
}

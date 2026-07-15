// rust-style-allow: large-file - transitive preflight discovery keeps traversal,
// admission provenance, limits, and its focused fixtures in one auditable module.
//! Runtime-owned preflight expansion for the complete skill chain shown to an
//! operator before execution. Discovery uses the same validated graph, child
//! skill, registry admission, and context-skill loaders as execution.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::{ContextEntry, JsonObject, JsonValue, sha256_prefixed};
use runx_parser::{ExecutionGraph, GraphStep, SkillRunnerDefinition, SourceKind, ValidatedSkill};
use serde::{Deserialize, Serialize};

use crate::RuntimeError;
use crate::services::{WorkspaceEnv, merge_inferred_tool_roots};
use crate::tool_catalogs::{ToolCatalogError, ToolInspectOptions, resolve_local_tool};

use super::graph::{
    LoadedStepSkill, LoadedStepSkillDefinition, LoadedStepSkillRegistryProvenance,
    StepSkillLoadOptions, load_step_skill,
};
use super::skill_context::load_context_skills;
use super::skill_front::SkillRunError;
use super::skill_front::runner_manifest::{
    load_runner_manifest, resolve_skill_dir, selected_runner,
};

const MAX_CHAIN_DEPTH: usize = 16;
const MAX_CHAIN_NODES: usize = 128;
const MAX_CHAIN_CONTENT_BYTES: usize = 4 * 1024 * 1024;
const OPERATOR_CONTEXT_CREATED_AT: &str = "operator-context-preflight";

#[derive(Clone, Debug)]
pub struct SkillOperatorContextOptions {
    env: BTreeMap<String, String>,
    cwd: PathBuf,
    max_depth: usize,
    max_nodes: usize,
    max_content_bytes: usize,
}

impl SkillOperatorContextOptions {
    #[must_use]
    pub fn new(env: BTreeMap<String, String>, cwd: PathBuf) -> Self {
        Self {
            env,
            cwd,
            max_depth: MAX_CHAIN_DEPTH,
            max_nodes: MAX_CHAIN_NODES,
            max_content_bytes: MAX_CHAIN_CONTENT_BYTES,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SkillOperatorContextChain {
    pub entry: SkillOperatorContextNode,
    pub node_count: usize,
    pub content_bytes: usize,
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_content_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SkillOperatorContextNode {
    pub node_path: String,
    pub package: SkillOperatorContextPackage,
    pub skill_markdown: SkillOperatorContextDocument,
    pub runner: SkillOperatorContextRunner,
    pub steps: Vec<SkillOperatorContextStep>,
    pub tools: Vec<SkillOperatorContextTool>,
    pub terminal: SkillOperatorContextTerminal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillOperatorContextPackage {
    pub directory: PathBuf,
    pub reference: Option<String>,
    pub source: String,
    pub source_label: String,
    pub registry: Option<SkillOperatorContextRegistry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillOperatorContextRegistry {
    pub reference: String,
    pub source: String,
    pub source_label: String,
    pub skill_id: String,
    pub version: String,
    pub digest: String,
    pub package_digest: Option<String>,
    pub trust_tier: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillOperatorContextDocument {
    pub path: Option<PathBuf>,
    pub source_label: String,
    pub sha256: String,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SkillOperatorContextRunner {
    pub name: String,
    pub source_type: String,
    pub selection: String,
    pub requested_name: Option<String>,
    pub raw: JsonValue,
    pub allowed_tools: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SkillOperatorContextStep {
    pub node_path: String,
    pub id: String,
    pub target: SkillOperatorContextTarget,
    pub raw: JsonValue,
    pub mutating: bool,
    pub allowed_tools: Vec<String>,
    pub context_skills: Vec<SkillOperatorContextContextSkill>,
    pub tool_refs: Vec<String>,
    pub child: Option<Box<SkillOperatorContextNode>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SkillOperatorContextTarget {
    Skill {
        reference: String,
        runner: Option<String>,
    },
    Tool {
        name: String,
    },
    Run {
        source_type: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillOperatorContextContextSkill {
    pub reference: String,
    pub source: String,
    pub name: String,
    pub document: SkillOperatorContextDocument,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillOperatorContextTool {
    pub name: String,
    pub source: String,
    pub path: Option<PathBuf>,
    pub sha256: Option<String>,
    pub content: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillOperatorContextTerminal {
    ExpandedGraph,
    Runner,
    LegacyMarkdown,
}

pub fn load_skill_operator_context_chain(
    skill_path: &Path,
    selected_runner_name: Option<&str>,
    options: SkillOperatorContextOptions,
) -> Result<SkillOperatorContextChain, SkillRunError> {
    let skill_dir = resolve_skill_dir(skill_path)?;
    let manifest = load_runner_manifest(&skill_dir)?;
    let runner = selected_runner(&manifest, selected_runner_name)?.clone();
    let workspace = WorkspaceEnv::new(options.env.clone(), options.cwd.clone());
    let env = workspace.skill_env_for_skill(&skill_dir);
    let mut state = ExpansionState::new(options);
    let entry = state.expand_runner_node(NodeInput {
        node_path: "entry".to_owned(),
        package: local_package(&skill_dir, None),
        skill_dir,
        runner,
        requested_runner: selected_runner_name.map(str::to_owned),
        env,
        depth: 0,
    })?;
    Ok(SkillOperatorContextChain {
        entry,
        node_count: state.node_count,
        content_bytes: state.content_bytes,
        max_depth: state.options.max_depth,
        max_nodes: state.options.max_nodes,
        max_content_bytes: state.options.max_content_bytes,
    })
}

struct ExpansionState {
    options: SkillOperatorContextOptions,
    node_count: usize,
    content_bytes: usize,
    ancestry: BTreeSet<String>,
}

struct NodeInput {
    node_path: String,
    package: SkillOperatorContextPackage,
    skill_dir: PathBuf,
    runner: SkillRunnerDefinition,
    requested_runner: Option<String>,
    env: BTreeMap<String, String>,
    depth: usize,
}

impl ExpansionState {
    fn new(options: SkillOperatorContextOptions) -> Self {
        Self {
            options,
            node_count: 0,
            content_bytes: 0,
            ancestry: BTreeSet::new(),
        }
    }

    fn expand_runner_node(
        &mut self,
        input: NodeInput,
    ) -> Result<SkillOperatorContextNode, SkillRunError> {
        self.admit_node(input.depth)?;
        let identity = node_identity(&input.package, &input.skill_dir, &input.runner.name)?;
        if !self.ancestry.insert(identity.clone()) {
            return Err(blocked(format!(
                "operator context chain contains a cycle at {} ({identity})",
                input.node_path
            )));
        }

        let result = self.build_runner_node(&input);
        self.ancestry.remove(&identity);
        result
    }

    fn build_runner_node(
        &mut self,
        input: &NodeInput,
    ) -> Result<SkillOperatorContextNode, SkillRunError> {
        let skill_markdown = self.load_document(&input.skill_dir.join("SKILL.md"))?;
        let raw = JsonValue::Object(input.runner.raw.clone());
        self.add_bytes(serialized_bytes(&raw)?)?;
        let graph = input.runner.source.graph.as_ref();
        let tool_names = referenced_tools(&input.runner, graph);
        let tools = self.load_tools(&input.skill_dir, &tool_names, &input.env)?;
        let steps = match graph {
            Some(graph) => self.expand_graph_steps(
                &input.node_path,
                &input.skill_dir,
                graph,
                &input.env,
                input.depth,
            )?,
            None => Vec::new(),
        };
        let terminal = if graph.is_some() {
            SkillOperatorContextTerminal::ExpandedGraph
        } else {
            SkillOperatorContextTerminal::Runner
        };
        Ok(SkillOperatorContextNode {
            node_path: input.node_path.clone(),
            package: input.package.clone(),
            skill_markdown,
            runner: runner_context(&input.runner, input.requested_runner.as_deref(), raw),
            steps,
            tools,
            terminal,
        })
    }

    fn expand_legacy_node(
        &mut self,
        node_path: String,
        package: SkillOperatorContextPackage,
        skill_dir: PathBuf,
        skill: ValidatedSkill,
        env: BTreeMap<String, String>,
        depth: usize,
    ) -> Result<SkillOperatorContextNode, SkillRunError> {
        self.admit_node(depth)?;
        let identity = node_identity(&package, &skill_dir, &skill.name)?;
        if !self.ancestry.insert(identity.clone()) {
            return Err(blocked(format!(
                "operator context chain contains a cycle at {node_path} ({identity})"
            )));
        }
        let result = (|| {
            let skill_markdown = self.load_document(&skill_dir.join("SKILL.md"))?;
            let raw = JsonValue::Object(skill.raw.frontmatter.clone());
            self.add_bytes(serialized_bytes(&raw)?)?;
            let allowed_tools = skill.allowed_tools.clone().unwrap_or_default();
            let graph = skill.source.graph.as_ref();
            let mut tool_names = allowed_tools.iter().cloned().collect::<BTreeSet<_>>();
            if let Some(graph) = graph {
                for step in &graph.steps {
                    tool_names.extend(step_tool_refs(step));
                }
            }
            let tools = self.load_tools(&skill_dir, &tool_names, &env)?;
            let steps = match graph {
                Some(graph) => {
                    self.expand_graph_steps(&node_path, &skill_dir, graph, &env, depth)?
                }
                None => Vec::new(),
            };
            let terminal = if graph.is_some() {
                SkillOperatorContextTerminal::ExpandedGraph
            } else {
                SkillOperatorContextTerminal::LegacyMarkdown
            };
            Ok(SkillOperatorContextNode {
                node_path,
                package,
                skill_markdown,
                runner: SkillOperatorContextRunner {
                    name: skill.name,
                    source_type: skill.source.source_type.to_string(),
                    selection: "legacy-markdown".to_owned(),
                    requested_name: None,
                    raw,
                    allowed_tools,
                },
                steps,
                tools,
                terminal,
            })
        })();
        self.ancestry.remove(&identity);
        result
    }

    fn expand_graph_steps(
        &mut self,
        parent_path: &str,
        graph_dir: &Path,
        graph: &ExecutionGraph,
        env: &BTreeMap<String, String>,
        depth: usize,
    ) -> Result<Vec<SkillOperatorContextStep>, SkillRunError> {
        graph
            .steps
            .iter()
            .map(|step| self.expand_graph_step(parent_path, graph_dir, step, env, depth))
            .collect()
    }

    // rust-style-allow: long-function - one graph-step expansion must resolve
    // its exclusive target, attached context, child provenance, and recursion together.
    fn expand_graph_step(
        &mut self,
        parent_path: &str,
        graph_dir: &Path,
        step: &GraphStep,
        env: &BTreeMap<String, String>,
        depth: usize,
    ) -> Result<SkillOperatorContextStep, SkillRunError> {
        let node_path = format!("{parent_path}.{}", step.id);
        let raw = contract_value(step, "serializing operator context graph step")?;
        let mut context_skills = Vec::new();
        let mut child = None;
        let target = if let Some(reference) = &step.skill {
            let loaded = load_step_skill(graph_dir, step, StepSkillLoadOptions { env })?;
            context_skills = self.load_step_context(graph_dir, step, env)?;
            if !context_skills.is_empty()
                && !matches!(
                    loaded.source.source_type,
                    SourceKind::Agent | SourceKind::AgentStep
                )
            {
                return Err(RuntimeError::InvalidRunStep {
                    step_id: step.id.clone(),
                    reason: "context_skills is only supported for agent and agent-task steps"
                        .to_owned(),
                }
                .into());
            }
            child = Some(Box::new(self.expand_loaded_child(
                node_path.clone(),
                reference,
                step.runner.as_deref(),
                loaded,
                env,
                depth + 1,
            )?));
            SkillOperatorContextTarget::Skill {
                reference: reference.clone(),
                runner: step.runner.clone(),
            }
        } else if let Some(name) = &step.tool {
            SkillOperatorContextTarget::Tool { name: name.clone() }
        } else if let Some(run) = &step.run {
            context_skills = self.load_step_context(graph_dir, step, env)?;
            SkillOperatorContextTarget::Run {
                source_type: run
                    .get("type")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("agent-task")
                    .to_owned(),
            }
        } else {
            return Err(blocked(format!(
                "operator context graph step '{}' has no target",
                step.id
            )));
        };
        let tool_refs = step_tool_refs(step);
        Ok(SkillOperatorContextStep {
            node_path,
            id: step.id.clone(),
            target,
            raw,
            mutating: step.mutating,
            allowed_tools: step.allowed_tools.clone().unwrap_or_default(),
            context_skills,
            tool_refs,
            child,
        })
    }

    fn expand_loaded_child(
        &mut self,
        node_path: String,
        reference: &str,
        requested_runner: Option<&str>,
        loaded: LoadedStepSkill,
        env: &BTreeMap<String, String>,
        depth: usize,
    ) -> Result<SkillOperatorContextNode, SkillRunError> {
        let package = loaded_package(&loaded, reference);
        let mut child_env = env.clone();
        merge_inferred_tool_roots(&mut child_env, &loaded.directory);
        match loaded.definition {
            LoadedStepSkillDefinition::Runner(runner) => self.expand_runner_node(NodeInput {
                node_path,
                package,
                skill_dir: loaded.directory,
                runner,
                requested_runner: requested_runner.map(str::to_owned),
                env: child_env,
                depth,
            }),
            LoadedStepSkillDefinition::Legacy(skill) => self.expand_legacy_node(
                node_path,
                package,
                loaded.directory,
                skill,
                child_env,
                depth,
            ),
        }
    }

    fn load_step_context(
        &mut self,
        graph_dir: &Path,
        step: &GraphStep,
        env: &BTreeMap<String, String>,
    ) -> Result<Vec<SkillOperatorContextContextSkill>, SkillRunError> {
        let entries = load_context_skills(
            &step.id,
            graph_dir,
            &step.context_skills,
            env,
            OPERATOR_CONTEXT_CREATED_AT,
        )?;
        step.context_skills
            .iter()
            .zip(entries)
            .map(|(reference, entry)| self.context_skill(reference, entry))
            .collect()
    }

    fn context_skill(
        &mut self,
        reference: &str,
        entry: ContextEntry,
    ) -> Result<SkillOperatorContextContextSkill, SkillRunError> {
        let source = context_string(&entry.data, "source")?;
        let name = context_string(&entry.data, "name")?;
        let content = context_string(&entry.data, "content")?;
        let sha256 = context_string(&entry.data, "sha256")?;
        let path = entry
            .data
            .get("path")
            .and_then(JsonValue::as_str)
            .map(PathBuf::from);
        let source_label = entry
            .data
            .get("source_label")
            .and_then(JsonValue::as_str)
            .or_else(|| path.as_ref().and_then(|value| value.to_str()))
            .unwrap_or(source.as_str())
            .to_owned();
        self.add_bytes(content.len())?;
        Ok(SkillOperatorContextContextSkill {
            reference: reference.to_owned(),
            source,
            name,
            document: SkillOperatorContextDocument {
                path,
                source_label,
                sha256,
                content,
            },
        })
    }

    fn load_document(
        &mut self,
        path: &Path,
    ) -> Result<SkillOperatorContextDocument, SkillRunError> {
        let content = fs::read_to_string(path)
            .map_err(|source| RuntimeError::io(format!("reading {}", path.display()), source))?;
        self.add_bytes(content.len())?;
        Ok(SkillOperatorContextDocument {
            path: Some(path.to_path_buf()),
            source_label: path.to_string_lossy().into_owned(),
            sha256: sha256_prefixed(content.as_bytes()),
            content,
        })
    }

    fn load_tools(
        &mut self,
        skill_dir: &Path,
        names: &BTreeSet<String>,
        env: &BTreeMap<String, String>,
    ) -> Result<Vec<SkillOperatorContextTool>, SkillRunError> {
        if names.is_empty() {
            return Ok(Vec::new());
        }
        names
            .iter()
            .map(
                |name| match resolve_referenced_local_tool(skill_dir, name, env)? {
                    Some((path, content)) => {
                        self.add_bytes(content.len())?;
                        Ok(SkillOperatorContextTool {
                            name: name.clone(),
                            source: "local-manifest".to_owned(),
                            path: Some(path),
                            sha256: Some(sha256_prefixed(content.as_bytes())),
                            content: Some(content),
                        })
                    }
                    None => Err(blocked(format!(
                        "operator context could not resolve required local tool '{name}'"
                    ))),
                },
            )
            .collect()
    }

    fn admit_node(&mut self, depth: usize) -> Result<(), SkillRunError> {
        if depth > self.options.max_depth {
            return Err(blocked(format!(
                "operator context chain exceeds maximum depth {}",
                self.options.max_depth
            )));
        }
        self.node_count = self
            .node_count
            .checked_add(1)
            .ok_or_else(|| blocked("operator context node count overflow"))?;
        if self.node_count > self.options.max_nodes {
            return Err(blocked(format!(
                "operator context chain exceeds maximum node count {}",
                self.options.max_nodes
            )));
        }
        Ok(())
    }

    fn add_bytes(&mut self, bytes: usize) -> Result<(), SkillRunError> {
        self.content_bytes = self
            .content_bytes
            .checked_add(bytes)
            .ok_or_else(|| blocked("operator context content byte count overflow"))?;
        if self.content_bytes > self.options.max_content_bytes {
            return Err(blocked(format!(
                "operator context chain exceeds maximum content bytes {}",
                self.options.max_content_bytes
            )));
        }
        Ok(())
    }
}

fn runner_context(
    runner: &SkillRunnerDefinition,
    requested_runner: Option<&str>,
    raw: JsonValue,
) -> SkillOperatorContextRunner {
    let selection = if requested_runner.is_some() {
        "requested"
    } else if runner.default {
        "default"
    } else {
        "only"
    };
    SkillOperatorContextRunner {
        name: runner.name.clone(),
        source_type: runner.source.source_type.to_string(),
        selection: selection.to_owned(),
        requested_name: requested_runner.map(str::to_owned),
        raw,
        allowed_tools: runner.allowed_tools.clone().unwrap_or_default(),
    }
}

fn local_package(skill_dir: &Path, reference: Option<String>) -> SkillOperatorContextPackage {
    SkillOperatorContextPackage {
        directory: skill_dir.to_path_buf(),
        reference,
        source: "local-path".to_owned(),
        source_label: skill_dir.to_string_lossy().into_owned(),
        registry: None,
    }
}

fn loaded_package(loaded: &LoadedStepSkill, reference: &str) -> SkillOperatorContextPackage {
    match loaded.registry.as_ref() {
        Some(registry) => SkillOperatorContextPackage {
            directory: loaded.directory.clone(),
            reference: Some(reference.to_owned()),
            source: registry.source.clone(),
            source_label: registry.source_label.clone(),
            registry: Some(registry_context(registry)),
        },
        None => local_package(&loaded.directory, Some(reference.to_owned())),
    }
}

fn registry_context(value: &LoadedStepSkillRegistryProvenance) -> SkillOperatorContextRegistry {
    SkillOperatorContextRegistry {
        reference: value.reference.clone(),
        source: value.source.clone(),
        source_label: value.source_label.clone(),
        skill_id: value.skill_id.clone(),
        version: value.version.clone(),
        digest: value.digest.clone(),
        package_digest: value.package_digest.clone(),
        trust_tier: value.trust_tier.clone(),
    }
}

fn node_identity(
    package: &SkillOperatorContextPackage,
    skill_dir: &Path,
    runner_name: &str,
) -> Result<String, SkillRunError> {
    if let Some(registry) = &package.registry {
        return Ok(format!(
            "registry:{}@{}:{}:{}",
            registry.skill_id,
            registry.version,
            registry
                .package_digest
                .as_deref()
                .unwrap_or(&registry.digest),
            runner_name
        ));
    }
    let canonical = fs::canonicalize(skill_dir).map_err(|source| {
        RuntimeError::io(
            format!("canonicalizing skill directory {}", skill_dir.display()),
            source,
        )
    })?;
    Ok(format!("local:{}:{runner_name}", canonical.display()))
}

fn referenced_tools(
    runner: &SkillRunnerDefinition,
    graph: Option<&ExecutionGraph>,
) -> BTreeSet<String> {
    let mut names = runner
        .allowed_tools
        .iter()
        .flatten()
        .cloned()
        .collect::<BTreeSet<_>>();
    if let Some(graph) = graph {
        for step in &graph.steps {
            names.extend(step_tool_refs(step));
        }
    }
    names
}

fn step_tool_refs(step: &GraphStep) -> Vec<String> {
    let mut names = step
        .allowed_tools
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect::<BTreeSet<_>>();
    if let Some(tool) = &step.tool {
        names.insert(tool.clone());
    }
    names.into_iter().collect()
}

fn resolve_referenced_local_tool(
    skill_dir: &Path,
    name: &str,
    env: &BTreeMap<String, String>,
) -> Result<Option<(PathBuf, String)>, SkillRunError> {
    let options = ToolInspectOptions {
        root: crate::config::resolve_runx_workspace_base(env, skill_dir),
        tool_ref: name.to_owned(),
        source: None,
        search_from_directory: skill_dir.to_path_buf(),
        tool_roots: env
            .get("RUNX_TOOL_ROOTS")
            .map(|value| {
                std::env::split_paths(value)
                    .filter(|path| !path.as_os_str().is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        fixture_catalog_enabled: false,
        allow_explicit_manifest_path: true,
    };
    match resolve_local_tool(&options) {
        Ok(resolution) => {
            let content = fs::read_to_string(&resolution.manifest_path).map_err(|source| {
                RuntimeError::io(
                    format!("reading {}", resolution.manifest_path.display()),
                    source,
                )
            })?;
            Ok(Some((resolution.manifest_path, content)))
        }
        Err(ToolCatalogError::NotFound(_)) => Ok(None),
        Err(ToolCatalogError::InvalidRequest(message))
            if message.contains("must include a namespace") =>
        {
            Ok(None)
        }
        Err(error) => Err(blocked(format!(
            "operator context could not resolve tool '{name}': {error}"
        ))),
    }
}

fn context_string(data: &JsonObject, field: &str) -> Result<String, SkillRunError> {
    data.get(field)
        .and_then(JsonValue::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            blocked(format!(
                "resolved context skill is missing string field {field}"
            ))
        })
}

fn contract_value(
    value: &impl serde::Serialize,
    operation: &str,
) -> Result<JsonValue, SkillRunError> {
    let value =
        serde_json::to_value(value).map_err(|source| RuntimeError::json(operation, source))?;
    serde_json::from_value(value)
        .map_err(|source| RuntimeError::json("normalizing operator context value", source).into())
}

fn serialized_bytes(value: &JsonValue) -> Result<usize, SkillRunError> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|source| RuntimeError::json("serializing operator context content", source).into())
}

fn blocked(message: impl Into<String>) -> SkillRunError {
    SkillRunError::Invalid(message.into())
}

#[cfg(test)]
mod tests {
    use std::error::Error;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn operator_context_expands_local_child_agent_runner() -> Result<(), Box<dyn Error>> {
        let temp = tempdir()?;
        let entry = temp.path().join("entry");
        let child = entry.join("child");
        write_skill(&entry, "entry", "# Entry")?;
        write_skill(&child, "child", "# Child contract")?;
        write_file(
            &child.join("X.yaml"),
            r#"skill: child
runners:
  review:
    default: true
    type: agent-task
    agent: reviewer
    task: review
"#,
        )?;
        write_file(
            &entry.join("X.yaml"),
            r#"skill: entry
runners:
  main:
    default: true
    type: graph
    graph:
      name: entry
      steps:
        - id: review
          skill: ./child
"#,
        )?;

        let chain = load_skill_operator_context_chain(
            &entry,
            None,
            SkillOperatorContextOptions::new(BTreeMap::new(), temp.path().to_path_buf()),
        )?;
        let child = chain.entry.steps[0].child.as_ref().ok_or("missing child")?;
        assert_eq!(child.node_path, "entry.review");
        assert_eq!(child.runner.name, "review");
        assert!(child.skill_markdown.content.contains("# Child contract"));
        assert_eq!(child.terminal, SkillOperatorContextTerminal::Runner);
        Ok(())
    }

    #[test]
    fn operator_context_uses_child_graph_dir_for_inner_context() -> Result<(), Box<dyn Error>> {
        let temp = tempdir()?;
        let entry = temp.path().join("entry");
        let child = entry.join("child");
        let rubric = child.join("context/rubric");
        write_skill(&entry, "entry", "# Entry")?;
        write_skill(&child, "child", "# Child")?;
        write_skill(&rubric, "rubric", "child-local rubric")?;
        write_file(
            &child.join("X.yaml"),
            r#"skill: child
runners:
  graph:
    default: true
    type: graph
    graph:
      name: child
      steps:
        - id: judge
          run:
            type: agent-task
            agent: reviewer
            task: judge
          context_skills:
            - ./context/rubric
"#,
        )?;
        write_entry_graph(&entry, "./child", "")?;

        let chain = load_skill_operator_context_chain(
            &entry,
            None,
            SkillOperatorContextOptions::new(BTreeMap::new(), temp.path().to_path_buf()),
        )?;
        let child = chain.entry.steps[0].child.as_ref().ok_or("missing child")?;
        let context = &child.steps[0].context_skills[0];
        assert_eq!(context.reference, "./context/rubric");
        assert!(context.document.content.contains("child-local rubric"));
        assert_eq!(context.document.path, Some(rubric.join("SKILL.md")));
        Ok(())
    }

    #[test]
    fn operator_context_uses_parent_graph_dir_for_child_agent_context() -> Result<(), Box<dyn Error>>
    {
        let temp = tempdir()?;
        let entry = temp.path().join("entry");
        let child = entry.join("child");
        let rubric = entry.join("context/rubric");
        write_skill(&entry, "entry", "# Entry")?;
        write_skill(&child, "child", "# Child")?;
        write_skill(&rubric, "rubric", "parent-local rubric")?;
        write_file(
            &child.join("X.yaml"),
            r#"skill: child
runners:
  agent:
    default: true
    type: agent-task
    agent: reviewer
    task: judge
"#,
        )?;
        write_entry_graph(
            &entry,
            "./child",
            "          context_skills:\n            - ./context/rubric\n",
        )?;

        let chain = load_skill_operator_context_chain(
            &entry,
            None,
            SkillOperatorContextOptions::new(BTreeMap::new(), temp.path().to_path_buf()),
        )?;
        let context = &chain.entry.steps[0].context_skills[0];
        assert!(context.document.content.contains("parent-local rubric"));
        assert_eq!(context.document.path, Some(rubric.join("SKILL.md")));
        Ok(())
    }

    #[test]
    fn operator_context_rejects_context_on_child_graph() -> Result<(), Box<dyn Error>> {
        let temp = tempdir()?;
        let entry = temp.path().join("entry");
        let child = entry.join("child");
        write_skill(&entry, "entry", "# Entry")?;
        write_skill(&child, "child", "# Child")?;
        write_skill(&entry.join("context/rubric"), "rubric", "rubric")?;
        write_file(
            &child.join("X.yaml"),
            r#"skill: child
runners:
  graph:
    default: true
    type: graph
    graph:
      name: child
      steps:
        - id: judge
          run:
            type: agent-task
            agent: reviewer
            task: judge
"#,
        )?;
        write_entry_graph(
            &entry,
            "./child",
            "          context_skills:\n            - ./context/rubric\n",
        )?;

        let error = operator_context_error(
            load_skill_operator_context_chain(
                &entry,
                None,
                SkillOperatorContextOptions::new(BTreeMap::new(), temp.path().to_path_buf()),
            ),
            "child graph context must fail",
        )?;
        assert!(
            error
                .to_string()
                .contains("context_skills is only supported for agent and agent-task steps")
        );
        Ok(())
    }

    #[test]
    fn operator_context_rejects_registry_child_without_registry_env() -> Result<(), Box<dyn Error>>
    {
        let temp = tempdir()?;
        let entry = temp.path().join("entry");
        write_skill(&entry, "entry", "# Entry")?;
        write_entry_graph(&entry, "registry:acme/child@1.0.0", "")?;

        let error = operator_context_error(
            load_skill_operator_context_chain(
                &entry,
                None,
                SkillOperatorContextOptions::new(BTreeMap::new(), temp.path().to_path_buf()),
            ),
            "missing registry env must fail",
        )?;
        assert!(
            error
                .to_string()
                .contains("RUNX_REGISTRY_DIR is not configured")
        );
        Ok(())
    }

    #[test]
    fn operator_context_includes_admitted_registry_child_provenance() -> Result<(), Box<dyn Error>>
    {
        use crate::registry::{
            IngestSkillOptions, RegistryPackageFile, create_file_registry_store,
            ingest_skill_markdown,
        };

        let temp = tempdir()?;
        let registry_dir = temp.path().join("registry");
        let store = create_file_registry_store(&registry_dir);
        ingest_skill_markdown(
            &store,
            "---\nname: registry-child\n---\n# Registry Child\n",
            IngestSkillOptions {
                owner: Some("acme".to_owned()),
                version: Some("1.0.0".to_owned()),
                created_at: Some("2026-07-12T00:00:00Z".to_owned()),
                profile_document: Some(
                    "skill: registry-child\nrunners:\n  agent:\n    default: true\n    type: agent-task\n    agent: reviewer\n    task: review\n"
                        .to_owned(),
                ),
                package_files: vec![RegistryPackageFile {
                    path: "references/rubric.md".to_owned(),
                    content: "registry package rubric".to_owned(),
                }],
                ..IngestSkillOptions::default()
            },
        )?;
        let entry = temp.path().join("entry");
        write_skill(&entry, "entry", "# Entry")?;
        write_entry_graph(&entry, "registry:acme/registry-child@1.0.0", "")?;
        let env = [(
            "RUNX_REGISTRY_DIR".to_owned(),
            registry_dir.to_string_lossy().into_owned(),
        )]
        .into_iter()
        .collect();

        let chain = load_skill_operator_context_chain(
            &entry,
            None,
            SkillOperatorContextOptions::new(env, temp.path().to_path_buf()),
        )?;
        let child = chain.entry.steps[0]
            .child
            .as_ref()
            .ok_or("missing registry child")?;
        let registry = child
            .package
            .registry
            .as_ref()
            .ok_or("missing registry provenance")?;
        assert_eq!(registry.reference, "registry:acme/registry-child@1.0.0");
        assert_eq!(registry.skill_id, "acme/registry-child");
        assert_eq!(registry.version, "1.0.0");
        assert!(registry.digest.starts_with("sha256:"));
        assert!(registry.package_digest.is_some());
        assert_eq!(registry.trust_tier, "community");
        assert!(!registry.source.is_empty());
        assert!(!registry.source_label.is_empty());
        Ok(())
    }

    #[test]
    fn operator_context_rejects_cycles_and_depth_overflow() -> Result<(), Box<dyn Error>> {
        let temp = tempdir()?;
        let entry = temp.path().join("entry");
        write_skill(&entry, "entry", "# Entry")?;
        write_entry_graph(&entry, ".", "")?;
        let error = operator_context_error(
            load_skill_operator_context_chain(
                &entry,
                None,
                SkillOperatorContextOptions::new(BTreeMap::new(), temp.path().to_path_buf()),
            ),
            "cycle must fail",
        )?;
        assert!(error.to_string().contains("contains a cycle"));

        let mut previous = temp.path().join("deep-entry");
        write_skill(&previous, "deep-entry", "# Deep")?;
        let root = previous.clone();
        for index in 0..=MAX_CHAIN_DEPTH {
            let next = previous.join(format!("child-{index}"));
            write_skill(&next, &format!("child-{index}"), "# Child")?;
            write_entry_graph(&previous, &format!("./child-{index}"), "")?;
            previous = next;
        }
        write_file(
            &previous.join("X.yaml"),
            "skill: terminal\nrunners:\n  agent:\n    default: true\n    type: agent-task\n    agent: reviewer\n    task: done\n",
        )?;
        let error = operator_context_error(
            load_skill_operator_context_chain(
                &root,
                None,
                SkillOperatorContextOptions::new(BTreeMap::new(), temp.path().to_path_buf()),
            ),
            "depth overflow must fail",
        )?;
        assert!(error.to_string().contains("exceeds maximum depth"));
        Ok(())
    }

    #[test]
    fn operator_context_allows_repeated_dag_child_and_enforces_size_limits()
    -> Result<(), Box<dyn Error>> {
        let temp = tempdir()?;
        let entry = temp.path().join("entry");
        let child = entry.join("child");
        write_skill(&entry, "entry", "# Entry")?;
        write_skill(&child, "child", "# Child")?;
        write_file(
            &child.join("X.yaml"),
            "skill: child\nrunners:\n  agent:\n    default: true\n    type: agent-task\n    agent: reviewer\n    task: review\n",
        )?;
        write_file(
            &entry.join("X.yaml"),
            "skill: entry\nrunners:\n  main:\n    default: true\n    type: graph\n    graph:\n      name: entry\n      steps:\n        - id: first\n          skill: ./child\n        - id: second\n          skill: ./child\n",
        )?;
        let chain = load_skill_operator_context_chain(
            &entry,
            None,
            SkillOperatorContextOptions::new(BTreeMap::new(), temp.path().to_path_buf()),
        )?;
        assert_eq!(chain.node_count, 3);
        assert!(chain.entry.steps.iter().all(|step| step.child.is_some()));

        let mut options =
            SkillOperatorContextOptions::new(BTreeMap::new(), temp.path().to_path_buf());
        options.max_content_bytes = 1;
        let error = operator_context_error(
            load_skill_operator_context_chain(&entry, None, options),
            "content size limit must fail",
        )?;
        assert!(error.to_string().contains("maximum content bytes"));

        let mut options =
            SkillOperatorContextOptions::new(BTreeMap::new(), temp.path().to_path_buf());
        options.max_nodes = 1;
        let error = operator_context_error(
            load_skill_operator_context_chain(&entry, None, options),
            "node count limit must fail",
        )?;
        assert!(error.to_string().contains("maximum node count"));
        Ok(())
    }

    #[test]
    fn operator_context_surfaces_local_tool_manifest_and_mutating_step()
    -> Result<(), Box<dyn Error>> {
        let temp = tempdir()?;
        let entry = temp.path().join("entry");
        write_skill(&entry, "entry", "# Entry")?;
        write_file(
            &entry.join("tools/example/record/manifest.json"),
            r#"{
  "name": "example.record",
  "source": {
    "type": "cli-tool",
    "command": "true",
    "args": [],
    "input_mode": "none"
  }
}
"#,
        )?;
        write_file(
            &entry.join("X.yaml"),
            "skill: entry\nrunners:\n  main:\n    default: true\n    type: graph\n    graph:\n      name: entry\n      steps:\n        - id: record\n          tool: example.record\n          mutation: true\n          idempotency_key: record-1\n",
        )?;

        let chain = load_skill_operator_context_chain(
            &entry,
            None,
            SkillOperatorContextOptions::new(BTreeMap::new(), temp.path().to_path_buf()),
        )?;
        assert!(chain.entry.steps[0].mutating);
        assert_eq!(chain.entry.steps[0].tool_refs, ["example.record"]);
        assert_eq!(chain.entry.tools.len(), 1);
        assert_eq!(chain.entry.tools[0].name, "example.record");
        assert_eq!(chain.entry.tools[0].source, "local-manifest");
        assert!(
            chain.entry.tools[0]
                .content
                .as_deref()
                .is_some_and(|content| content.contains("cli-tool"))
        );
        Ok(())
    }

    fn write_skill(dir: &Path, name: &str, body: &str) -> Result<(), Box<dyn Error>> {
        fs::create_dir_all(dir)?;
        write_file(
            &dir.join("SKILL.md"),
            &format!("---\nname: {name}\n---\n{body}\n"),
        )
    }

    fn write_entry_graph(dir: &Path, child_ref: &str, extra: &str) -> Result<(), Box<dyn Error>> {
        write_file(
            &dir.join("X.yaml"),
            &format!(
                "skill: entry\nrunners:\n  main:\n    default: true\n    type: graph\n    graph:\n      name: entry\n      steps:\n        - id: child\n          skill: {child_ref}\n{extra}"
            ),
        )
    }

    fn write_file(path: &Path, content: &str) -> Result<(), Box<dyn Error>> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, content)?;
        Ok(())
    }

    fn operator_context_error(
        result: Result<SkillOperatorContextChain, SkillRunError>,
        message: &'static str,
    ) -> Result<SkillRunError, Box<dyn Error>> {
        match result {
            Ok(_) => Err(message.into()),
            Err(error) => Ok(error),
        }
    }
}

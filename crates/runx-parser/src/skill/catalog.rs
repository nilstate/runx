// Module rationale: catalog enums, parsing, and cross-field capability validation form one public metadata contract.
use std::collections::{BTreeMap, BTreeSet};

use runx_contracts::JsonObject;
use serde::{Deserialize, Serialize};

use crate::ValidationError;

use super::FIELDS;

const CATALOG_FIELDS: &[&str] = &[
    "approval",
    "audience",
    "canonical_skill",
    "completion",
    "execution",
    "kind",
    "part_of",
    "provider",
    "requires_adapter",
    "role",
    "runtime_path",
    "visibility",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogKind {
    Skill,
    Graph,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogAudience {
    Public,
    Builder,
    Operator,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogVisibility {
    Public,
    Internal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogRole {
    Canonical,
    Branded,
    Context,
    GraphStage,
    RuntimePath,
    HarnessFixture,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogExecution {
    Plan,
    Read,
    Execute,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogCompletion {
    Plan,
    RuntimeReceipt,
    ProviderReadback,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogApproval {
    None,
    Conditional,
    Required,
}

impl CatalogKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            CatalogKind::Skill => "skill",
            CatalogKind::Graph => "graph",
        }
    }
}

impl CatalogAudience {
    pub fn as_str(&self) -> &'static str {
        match self {
            CatalogAudience::Public => "public",
            CatalogAudience::Builder => "builder",
            CatalogAudience::Operator => "operator",
            CatalogAudience::System => "system",
        }
    }
}

impl CatalogVisibility {
    pub fn as_str(&self) -> &'static str {
        match self {
            CatalogVisibility::Public => "public",
            CatalogVisibility::Internal => "internal",
        }
    }
}

impl CatalogRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            CatalogRole::Canonical => "canonical",
            CatalogRole::Branded => "branded",
            CatalogRole::Context => "context",
            CatalogRole::GraphStage => "graph-stage",
            CatalogRole::RuntimePath => "runtime-path",
            CatalogRole::HarnessFixture => "harness-fixture",
        }
    }
}

impl CatalogExecution {
    pub fn as_str(&self) -> &'static str {
        match self {
            CatalogExecution::Plan => "plan",
            CatalogExecution::Read => "read",
            CatalogExecution::Execute => "execute",
        }
    }
}

impl CatalogCompletion {
    pub fn as_str(&self) -> &'static str {
        match self {
            CatalogCompletion::Plan => "plan",
            CatalogCompletion::RuntimeReceipt => "runtime_receipt",
            CatalogCompletion::ProviderReadback => "provider_readback",
        }
    }
}

impl CatalogApproval {
    pub fn as_str(&self) -> &'static str {
        match self {
            CatalogApproval::None => "none",
            CatalogApproval::Conditional => "conditional",
            CatalogApproval::Required => "required",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMetadata {
    pub kind: CatalogKind,
    pub audience: CatalogAudience,
    pub visibility: CatalogVisibility,
    pub role: CatalogRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_skill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub part_of: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<CatalogExecution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<CatalogCompletion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_adapter: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<CatalogApproval>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogSemanticCode {
    PublicPromiseMismatch,
    DefaultRunnerIsPlanningOnly,
    ProviderReadbackUnreachable,
    AdapterUnreachable,
    ApprovalUnreachable,
    MockDefault,
    FixtureDefault,
    MissingColdSelectionProof,
    MissingStandaloneDefaultProof,
    MissingComposedReuseProof,
}

impl CatalogSemanticCode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PublicPromiseMismatch => "public_promise_mismatch",
            Self::DefaultRunnerIsPlanningOnly => "default_runner_is_planning_only",
            Self::ProviderReadbackUnreachable => "provider_readback_unreachable",
            Self::AdapterUnreachable => "adapter_unreachable",
            Self::ApprovalUnreachable => "approval_unreachable",
            Self::MockDefault => "mock_default",
            Self::FixtureDefault => "fixture_default",
            Self::MissingColdSelectionProof => "missing_cold_selection_proof",
            Self::MissingStandaloneDefaultProof => "missing_standalone_default_proof",
            Self::MissingComposedReuseProof => "missing_composed_reuse_proof",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogProviderProof {
    #[default]
    None,
    Harness,
    Live,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogOperatorReadiness {
    pub evaluated: bool,
    pub cold_selection: bool,
    pub standalone_default: bool,
    pub composed_reuse: bool,
    pub provider_proof: CatalogProviderProof,
    pub supplied_agent_answers: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cold_selection_confusors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub standalone_case: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composed_case: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSemanticDiagnostic {
    pub code: CatalogSemanticCode,
    pub skill: String,
    pub runner: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_execution: Option<CatalogExecution>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_completion: Option<CatalogCompletion>,
    pub observed: Vec<String>,
    pub required_correction: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSemanticReport {
    pub mode: String,
    pub skill: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_runner: Option<String>,
    pub diagnostics: Vec<CatalogSemanticDiagnostic>,
    pub readiness: CatalogOperatorReadiness,
}

#[derive(Default)]
struct DefaultRunnerFacts {
    observations: BTreeSet<String>,
    provider_readback: bool,
    provider_boundary: bool,
    mutation: bool,
    adapter: bool,
    artifact: bool,
    agent: bool,
    mock: bool,
    fixture: bool,
    planning_name: bool,
}

/// Report semantic drift between a public catalog promise and its selected
/// default runner. Aggregate package admission rejects any diagnostic; raw
/// manifest callers may still inspect the structured report to explain the
/// required correction.
#[must_use]
pub fn analyze_catalog_semantics(
    skill: &str,
    manifest: &crate::SkillRunnerManifest,
) -> CatalogSemanticReport {
    let default = manifest
        .runners
        .values()
        .find(|runner| runner.default)
        .or_else(|| {
            (manifest.runners.len() == 1)
                .then(|| manifest.runners.values().next())
                .flatten()
        });
    let Some(runner) = default else {
        return CatalogSemanticReport {
            mode: "enforced".to_owned(),
            skill: skill.to_owned(),
            default_runner: None,
            diagnostics: Vec::new(),
            readiness: CatalogOperatorReadiness::default(),
        };
    };
    let Some(catalog) = manifest.catalog.as_ref() else {
        return CatalogSemanticReport {
            mode: "enforced".to_owned(),
            skill: skill.to_owned(),
            default_runner: Some(runner.name.clone()),
            diagnostics: Vec::new(),
            readiness: CatalogOperatorReadiness::default(),
        };
    };
    let facts = default_runner_facts(skill, manifest, runner);
    let observed = facts.observations.iter().cloned().collect::<Vec<_>>();
    let mut diagnostics = Vec::new();
    let public = catalog.visibility == CatalogVisibility::Public;
    let inferred_operation = public && inferred_operation_promise(skill);
    if inferred_operation && catalog.execution != Some(CatalogExecution::Execute) {
        diagnostics.push(semantic_diagnostic(
            CatalogSemanticCode::PublicPromiseMismatch,
            skill,
            runner,
            catalog,
            &observed,
            "declare execute/provider_readback for the operation promise or refocus the public capability so its name promises only the returned artifact",
        ));
    }
    if (catalog.execution == Some(CatalogExecution::Execute) || inferred_operation)
        && !facts.mutation
        && !facts.provider_readback
        && !facts.adapter
        && !facts.agent
    {
        diagnostics.push(semantic_diagnostic(
            CatalogSemanticCode::DefaultRunnerIsPlanningOnly,
            skill,
            runner,
            catalog,
            &observed,
            "make the default runner reach the advertised terminal operation; retain this runner as an explicit plan or inspect runner",
        ));
    } else if inferred_operation
        && facts.planning_name
        && !facts.mutation
        && !facts.provider_readback
    {
        diagnostics.push(semantic_diagnostic(
            CatalogSemanticCode::DefaultRunnerIsPlanningOnly,
            skill,
            runner,
            catalog,
            &observed,
            "select an end-to-end default and keep the planning runner explicitly named",
        ));
    }
    if catalog.completion == Some(CatalogCompletion::ProviderReadback) && !facts.provider_readback {
        diagnostics.push(semantic_diagnostic(
            CatalogSemanticCode::ProviderReadbackUnreachable,
            skill,
            runner,
            catalog,
            &observed,
            "route the default execution closure through provider.read/provider.mutate and return its durable readback, or correct completion metadata",
        ));
    }
    if catalog.requires_adapter == Some(true) && !facts.provider_readback && !facts.adapter {
        diagnostics.push(semantic_diagnostic(
            CatalogSemanticCode::AdapterUnreachable,
            skill,
            runner,
            catalog,
            &observed,
            "make a declared provider or adapter boundary reachable from the default runner, or remove requires_adapter",
        ));
    }
    if catalog.approval == Some(CatalogApproval::Required) && !facts.mutation {
        diagnostics.push(semantic_diagnostic(
            CatalogSemanticCode::ApprovalUnreachable,
            skill,
            runner,
            catalog,
            &observed,
            "place one exact approval at the reachable consequential mutation, or correct approval metadata",
        ));
    }
    if public && facts.mock {
        diagnostics.push(semantic_diagnostic(
            CatalogSemanticCode::MockDefault,
            skill,
            runner,
            catalog,
            &observed,
            "move mock execution to an explicit test runner and select a real or truthfully blocked production default",
        ));
    }
    if public && facts.fixture {
        diagnostics.push(semantic_diagnostic(
            CatalogSemanticCode::FixtureDefault,
            skill,
            runner,
            catalog,
            &observed,
            "move fixture execution to harness-only coverage and select an operator-facing default",
        ));
    }
    diagnostics.sort_by_key(|diagnostic| diagnostic.code);
    CatalogSemanticReport {
        mode: "enforced".to_owned(),
        skill: skill.to_owned(),
        default_runner: Some(runner.name.clone()),
        diagnostics,
        readiness: CatalogOperatorReadiness::default(),
    }
}

/// Add package-fixture evidence to the structural catalog report. This is the
/// only readiness owner used by complete package admission and inspection;
/// callers with a raw manifest receive structural facts with
/// `readiness.evaluated = false` rather than invented journey proof.
#[must_use]
pub fn analyze_package_catalog_semantics(
    skill: &str,
    manifest: &crate::SkillRunnerManifest,
    fixtures: &BTreeMap<String, crate::harness_fixture::HarnessFixture>,
) -> CatalogSemanticReport {
    let mut report = analyze_catalog_semantics(skill, manifest);
    let Some(catalog) = manifest.catalog.as_ref() else {
        return report;
    };
    if catalog.visibility != CatalogVisibility::Public {
        return report;
    }
    let Some(default_runner) = report.default_runner.as_deref() else {
        return report;
    };
    let Some(runner) = manifest.runners.get(default_runner) else {
        return report;
    };
    let facts = default_runner_facts(skill, manifest, runner);
    let readiness = package_operator_readiness(skill, manifest, fixtures, default_runner, &facts);
    let observed = readiness_observations(&readiness);
    if !readiness.cold_selection {
        report.diagnostics.push(semantic_diagnostic(
            CatalogSemanticCode::MissingColdSelectionProof,
            skill,
            runner,
            catalog,
            &observed,
            "add a standalone journey for the actual default runner with at least two nearby public skill confusors",
        ));
    }
    if !readiness.standalone_default {
        report.diagnostics.push(semantic_diagnostic(
            CatalogSemanticCode::MissingStandaloneDefaultProof,
            skill,
            runner,
            catalog,
            &observed,
            "run a standalone operator journey against the actual default runner rather than a convenient phase runner",
        ));
    }
    if !readiness.composed_reuse {
        report.diagnostics.push(semantic_diagnostic(
            CatalogSemanticCode::MissingComposedReuseProof,
            skill,
            runner,
            catalog,
            &observed,
            "add a composed journey that names reused prior evidence and work that must not be repeated",
        ));
    }
    report.diagnostics.sort_by_key(|diagnostic| diagnostic.code);
    report.readiness = readiness;
    report
}

fn package_operator_readiness(
    skill: &str,
    manifest: &crate::SkillRunnerManifest,
    fixtures: &BTreeMap<String, crate::harness_fixture::HarnessFixture>,
    default_runner: &str,
    facts: &DefaultRunnerFacts,
) -> CatalogOperatorReadiness {
    let mut readiness = CatalogOperatorReadiness {
        evaluated: true,
        ..CatalogOperatorReadiness::default()
    };
    if let Some(harness) = manifest.harness.as_ref() {
        for case in &harness.cases {
            update_operator_readiness(
                skill,
                default_runner,
                &case.name,
                true,
                case.runner.as_deref(),
                &case.operator_journeys,
                case.caller
                    .answers
                    .as_ref()
                    .is_some_and(|answers| !answers.is_empty()),
                case.expect.status.as_ref(),
                facts,
                &mut readiness,
            );
        }
    }
    for fixture in fixtures.values() {
        update_operator_readiness(
            skill,
            default_runner,
            &fixture.name,
            matches!(
                fixture.kind,
                crate::harness_fixture::HarnessFixtureKind::Skill
            ) && fixture.target == "..",
            fixture.runner.as_deref(),
            &fixture.operator_journeys,
            fixture
                .caller
                .get("answers")
                .and_then(runx_contracts::JsonValue::as_object)
                .is_some_and(|answers| !answers.is_empty()),
            fixture.expect.status.as_ref(),
            facts,
            &mut readiness,
        );
    }
    readiness
}

#[allow(clippy::too_many_arguments)]
fn update_operator_readiness(
    skill: &str,
    default_runner: &str,
    case_name: &str,
    package_runner_case: bool,
    selected_runner: Option<&str>,
    journeys: &[crate::OperatorJourneyClaim],
    supplied_agent_answers: bool,
    expected_status: Option<&crate::harness_fixture::HarnessExpectedStatus>,
    facts: &DefaultRunnerFacts,
    readiness: &mut CatalogOperatorReadiness,
) {
    for journey in journeys {
        let completed = matches!(
            expected_status,
            Some(crate::harness_fixture::HarnessExpectedStatus::Sealed)
        );
        let exercises_default = if package_runner_case {
            selected_runner.is_none_or(|runner| runner == default_runner)
        } else {
            journey.exercises_runner.as_deref() == Some(default_runner)
        };
        match journey.mode {
            crate::OperatorJourneyMode::Standalone if exercises_default && completed => {
                readiness.standalone_default = true;
                readiness
                    .standalone_case
                    .get_or_insert_with(|| case_name.to_owned());
                readiness.supplied_agent_answers |= supplied_agent_answers;
                let confusors = journey
                    .confusors
                    .iter()
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty() && *value != skill)
                    .collect::<BTreeSet<_>>();
                if confusors.len() >= 2 {
                    readiness.cold_selection = true;
                    readiness.cold_selection_confusors =
                        confusors.into_iter().map(str::to_owned).collect();
                }
                if facts.provider_readback
                    && !supplied_agent_answers
                    && matches!(
                        expected_status,
                        Some(crate::harness_fixture::HarnessExpectedStatus::Sealed)
                    )
                {
                    readiness.provider_proof = CatalogProviderProof::Harness;
                }
            }
            crate::OperatorJourneyMode::Composed if completed => {
                readiness.composed_reuse = true;
                readiness
                    .composed_case
                    .get_or_insert_with(|| case_name.to_owned());
            }
            crate::OperatorJourneyMode::Standalone
            | crate::OperatorJourneyMode::Composed
            | crate::OperatorJourneyMode::Refusal => {}
        }
    }
}

fn readiness_observations(readiness: &CatalogOperatorReadiness) -> Vec<String> {
    let mut observed = Vec::new();
    if readiness.cold_selection {
        observed.push("cold_selection_harness".to_owned());
    }
    if readiness.standalone_default {
        observed.push("standalone_default_harness".to_owned());
    }
    if readiness.composed_reuse {
        observed.push("composed_reuse_harness".to_owned());
    }
    if readiness.supplied_agent_answers {
        observed.push("supplied_agent_answers".to_owned());
    }
    observed.push(format!("provider_proof:{:?}", readiness.provider_proof).to_lowercase());
    observed
}

fn semantic_diagnostic(
    code: CatalogSemanticCode,
    skill: &str,
    runner: &super::SkillRunnerDefinition,
    catalog: &CatalogMetadata,
    observed: &[String],
    required_correction: &str,
) -> CatalogSemanticDiagnostic {
    CatalogSemanticDiagnostic {
        code,
        skill: skill.to_owned(),
        runner: runner.name.clone(),
        claimed_execution: catalog.execution,
        claimed_completion: catalog.completion,
        observed: observed.to_vec(),
        required_correction: required_correction.to_owned(),
    }
}

fn default_runner_facts(
    skill: &str,
    manifest: &crate::SkillRunnerManifest,
    runner: &super::SkillRunnerDefinition,
) -> DefaultRunnerFacts {
    let mut facts = DefaultRunnerFacts {
        planning_name: contains_word(&runner.name, &["plan", "draft", "prepare"]),
        mock: contains_word(&runner.name, &["mock", "demo"]),
        fixture: contains_word(&runner.name, &["fixture", "harness", "test"]),
        artifact: runner.artifacts.is_some(),
        agent: matches!(
            runner.source.source_type,
            super::SourceKind::Agent | super::SourceKind::AgentStep
        ),
        mutation: runner.mutating.unwrap_or(false),
        ..Default::default()
    };
    observe_source(manifest, &runner.source, &mut facts, &mut BTreeSet::new());
    facts.provider_readback = source_readback_reaches_result(
        manifest,
        &runner.source,
        &mut BTreeSet::from([runner.name.clone()]),
    );
    if facts.planning_name {
        facts.observations.insert("planning_runner_name".to_owned());
    }
    if facts.artifact {
        facts.observations.insert("declared_artifact".to_owned());
    }
    if facts.agent {
        facts.observations.insert("agent_act".to_owned());
    }
    if facts.provider_boundary {
        facts
            .observations
            .insert("provider_boundary_reachable".to_owned());
    }
    if facts.provider_readback {
        facts
            .observations
            .insert("provider_readback_result_path".to_owned());
    }
    if facts.mock || contains_word(skill, &["mock"]) {
        facts.observations.insert("mock_path".to_owned());
    }
    if facts.fixture {
        facts.observations.insert("fixture_path".to_owned());
    }
    facts
}

fn observe_source(
    manifest: &crate::SkillRunnerManifest,
    source: &super::SkillSource,
    facts: &mut DefaultRunnerFacts,
    visited_runners: &mut BTreeSet<String>,
) {
    match source.source_type {
        super::SourceKind::Graph => {
            if let Some(graph) = source.graph.as_ref() {
                for step in &graph.steps {
                    if let Some(tool) = step.tool.as_deref() {
                        facts.observations.insert(format!("tool:{tool}"));
                        if matches!(tool, "provider.read" | "provider.mutate") {
                            facts.provider_boundary = true;
                        }
                        if tool == "provider.mutate" {
                            facts.mutation = true;
                        }
                        if matches!(
                            tool,
                            "data.append_event"
                                | "data.read_events"
                                | "data.read_projection"
                                | "data.list_stream_heads"
                        ) {
                            facts.adapter = true;
                            facts
                                .observations
                                .insert("native_data_adapter_boundary".to_owned());
                        }
                        if tool == "data.append_event" {
                            facts.mutation = true;
                        }
                        if matches!(tool, "http.read" | "http.execute" | "web.fetch") {
                            facts.adapter = true;
                            facts.provider_boundary = true;
                            facts
                                .observations
                                .insert("native_network_boundary".to_owned());
                        }
                        if matches!(tool, "http.execute" | "command.execute") {
                            facts.mutation = true;
                            facts.provider_boundary = true;
                        }
                        if tool == "receipt.attest" {
                            facts.mutation = true;
                            facts
                                .observations
                                .insert("native_receipt_boundary".to_owned());
                        }
                    }
                    facts.mutation |= step.mutating;
                    if let Some(reference) = step.skill.as_deref() {
                        facts.observations.insert(format!("skill:{reference}"));
                        if reference
                            .trim_end_matches('/')
                            .split('/')
                            .next_back()
                            .is_some_and(|name| name == "data-store")
                        {
                            facts.adapter = true;
                            facts
                                .observations
                                .insert("native_data_adapter_boundary".to_owned());
                        }
                        if reference.contains("provider-operation") {
                            facts.adapter = true;
                            facts.provider_boundary = true;
                            facts
                                .observations
                                .insert("provider_operation_boundary".to_owned());
                        }
                        facts.mock |= contains_word(reference, &["mock", "demo"])
                            || step
                                .runner
                                .as_deref()
                                .is_some_and(|runner| contains_word(runner, &["mock", "demo"]));
                        facts.fixture |= contains_word(reference, &["fixture", "harness"]);
                        if !matches!(reference, "." | "./") && step.mutating {
                            facts.adapter = true;
                            facts.provider_boundary = true;
                            facts
                                .observations
                                .insert("external_mutation_boundary".to_owned());
                        }
                        if matches!(reference, "." | "./")
                            && let Some(runner_name) = step.runner.as_deref()
                            && visited_runners.insert(runner_name.to_owned())
                            && let Some(child) = manifest.runners.get(runner_name)
                        {
                            observe_source(manifest, &child.source, facts, visited_runners);
                        }
                    }
                    if let Some(run) = step.run.as_ref().and_then(|run| run.source()) {
                        observe_source(manifest, run, facts, visited_runners);
                    }
                }
            }
        }
        super::SourceKind::ExternalAdapter | super::SourceKind::ThreadOutboxProvider => {
            facts.adapter = true;
            facts.mutation = true;
            facts.provider_boundary = true;
            facts
                .observations
                .insert(format!("source:{}", source.source_type.as_str()));
        }
        super::SourceKind::Agent | super::SourceKind::AgentStep => {
            facts.agent = true;
            facts.observations.insert("agent_act".to_owned());
        }
        _ => {
            facts
                .observations
                .insert(format!("source:{}", source.source_type.as_str()));
        }
    }
}

fn source_readback_reaches_result(
    manifest: &crate::SkillRunnerManifest,
    source: &super::SkillSource,
    visited_runners: &mut BTreeSet<String>,
) -> bool {
    match source.source_type {
        super::SourceKind::ExternalAdapter | super::SourceKind::ThreadOutboxProvider => true,
        super::SourceKind::Graph => source.graph.as_ref().is_some_and(|graph| {
            let mut effect_steps = BTreeSet::new();
            for step in &graph.steps {
                let direct_effect = step.tool.as_deref().is_some_and(|tool| {
                    matches!(
                        tool,
                        "provider.read"
                            | "provider.mutate"
                            | "http.read"
                            | "http.execute"
                            | "web.fetch"
                            | "command.execute"
                    )
                }) || step.skill.as_deref().is_some_and(|reference| {
                    if matches!(reference, "." | "./") {
                        let Some(runner_name) = step.runner.as_deref() else {
                            return false;
                        };
                        if !visited_runners.insert(runner_name.to_owned()) {
                            return false;
                        }
                        let result = manifest.runners.get(runner_name).is_some_and(|runner| {
                            source_readback_reaches_result(
                                manifest,
                                &runner.source,
                                visited_runners,
                            )
                        });
                        visited_runners.remove(runner_name);
                        result
                    } else {
                        step.mutating || reference.contains("provider-operation")
                    }
                }) || step
                    .run
                    .as_ref()
                    .and_then(|run| run.source())
                    .is_some_and(|run| {
                        source_readback_reaches_result(manifest, run, visited_runners)
                    });
                if direct_effect || step_depends_on_any(step, &effect_steps) {
                    effect_steps.insert(step.id.clone());
                }
            }
            graph
                .result_from
                .iter()
                .any(|result| effect_steps.contains(result))
        }),
        _ => false,
    }
}

fn step_depends_on_any(step: &crate::GraphStep, producers: &BTreeSet<String>) -> bool {
    step.context
        .values()
        .any(|reference| reference_names_step(reference, producers))
        || step
            .context_edges
            .iter()
            .any(|edge| producers.contains(&edge.from_step))
        || step
            .when
            .as_ref()
            .is_some_and(|when| reference_names_step(&when.field, producers))
        || step
            .inputs
            .values()
            .any(|value| value_references_any_step(value, producers))
}

fn value_references_any_step(
    value: &runx_contracts::JsonValue,
    producers: &BTreeSet<String>,
) -> bool {
    match value {
        runx_contracts::JsonValue::String(value) => reference_names_step(value, producers),
        runx_contracts::JsonValue::Array(values) => values
            .iter()
            .any(|value| value_references_any_step(value, producers)),
        runx_contracts::JsonValue::Object(values) => values
            .values()
            .any(|value| value_references_any_step(value, producers)),
        _ => false,
    }
}

fn reference_names_step(reference: &str, producers: &BTreeSet<String>) -> bool {
    reference
        .split_once('.')
        .is_some_and(|(step, _)| producers.contains(step))
}

fn inferred_operation_promise(skill: &str) -> bool {
    contains_word(
        skill,
        &[
            "send", "sync", "notify", "spend", "refund", "settle", "publish", "file", "unseal",
            "pay", "charge", "release",
        ],
    ) || matches!(skill, "issue-to-pr" | "dispute-respond")
}

fn contains_word(value: &str, words: &[&str]) -> bool {
    value
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|segment| words.contains(&segment))
}

pub(crate) fn validate_catalog_metadata(
    value: Option<JsonObject>,
    label: &str,
) -> Result<Option<CatalogMetadata>, ValidationError> {
    let Some(value) = value else {
        return Ok(None);
    };
    FIELDS.reject_unknown_fields(&value, label, CATALOG_FIELDS)?;
    let kind = parse_catalog_kind(&value, label)?;
    let audience = parse_catalog_audience(&value, label)?;
    let visibility = parse_catalog_visibility(&value, label)?;
    let role = parse_catalog_role(&value, label)?;
    validate_catalog_role(visibility, role, label)?;
    let canonical_skill = FIELDS.optional_string(
        value.get("canonical_skill"),
        &format!("{label}.canonical_skill"),
    )?;
    let provider = FIELDS.optional_string(value.get("provider"), &format!("{label}.provider"))?;
    let runtime_path =
        FIELDS.optional_string(value.get("runtime_path"), &format!("{label}.runtime_path"))?;
    let part_of = FIELDS
        .optional_string_array(value.get("part_of"), &format!("{label}.part_of"))?
        .unwrap_or_default();
    let execution = parse_catalog_execution(&value, label)?;
    let completion = parse_catalog_completion(&value, label)?;
    let requires_adapter = FIELDS.optional_bool(
        value.get("requires_adapter"),
        &format!("{label}.requires_adapter"),
    )?;
    let approval = parse_catalog_approval(&value, label)?;
    let capability_fields = [
        execution.is_some(),
        completion.is_some(),
        requires_adapter.is_some(),
        approval.is_some(),
    ];
    if capability_fields.iter().any(|present| *present)
        && capability_fields.iter().any(|present| !*present)
    {
        return Err(FIELDS.validation_error(format!(
            "{label} capability metadata must declare execution, completion, requires_adapter, and approval together."
        )));
    }
    validate_catalog_bindings(role, &canonical_skill, &provider, &part_of, label)?;
    Ok(Some(CatalogMetadata {
        kind,
        audience,
        visibility,
        role,
        canonical_skill,
        provider,
        runtime_path,
        part_of,
        execution,
        completion,
        requires_adapter,
        approval,
    }))
}

fn parse_catalog_execution(
    value: &JsonObject,
    label: &str,
) -> Result<Option<CatalogExecution>, ValidationError> {
    match FIELDS
        .optional_string(value.get("execution"), &format!("{label}.execution"))?
        .as_deref()
    {
        Some("plan") => Ok(Some(CatalogExecution::Plan)),
        Some("read") => Ok(Some(CatalogExecution::Read)),
        Some("execute") => Ok(Some(CatalogExecution::Execute)),
        None => Ok(None),
        Some(_) => {
            Err(FIELDS
                .validation_error(format!("{label}.execution must be plan, read, or execute.")))
        }
    }
}

fn parse_catalog_completion(
    value: &JsonObject,
    label: &str,
) -> Result<Option<CatalogCompletion>, ValidationError> {
    match FIELDS
        .optional_string(value.get("completion"), &format!("{label}.completion"))?
        .as_deref()
    {
        Some("plan") => Ok(Some(CatalogCompletion::Plan)),
        Some("runtime_receipt") => Ok(Some(CatalogCompletion::RuntimeReceipt)),
        Some("provider_readback") => Ok(Some(CatalogCompletion::ProviderReadback)),
        None => Ok(None),
        Some(_) => Err(FIELDS.validation_error(format!(
            "{label}.completion must be plan, runtime_receipt, or provider_readback."
        ))),
    }
}

fn parse_catalog_approval(
    value: &JsonObject,
    label: &str,
) -> Result<Option<CatalogApproval>, ValidationError> {
    match FIELDS
        .optional_string(value.get("approval"), &format!("{label}.approval"))?
        .as_deref()
    {
        Some("none") => Ok(Some(CatalogApproval::None)),
        Some("conditional") => Ok(Some(CatalogApproval::Conditional)),
        Some("required") => Ok(Some(CatalogApproval::Required)),
        None => Ok(None),
        Some(_) => Err(FIELDS.validation_error(format!(
            "{label}.approval must be none, conditional, or required."
        ))),
    }
}

fn parse_catalog_kind(value: &JsonObject, label: &str) -> Result<CatalogKind, ValidationError> {
    match FIELDS
        .required_string(value.get("kind"), &format!("{label}.kind"))?
        .as_str()
    {
        "skill" => Ok(CatalogKind::Skill),
        "graph" => Ok(CatalogKind::Graph),
        _ => Err(FIELDS.validation_error(format!("{label}.kind must be skill or graph."))),
    }
}

fn parse_catalog_audience(
    value: &JsonObject,
    label: &str,
) -> Result<CatalogAudience, ValidationError> {
    match FIELDS
        .required_string(value.get("audience"), &format!("{label}.audience"))?
        .as_str()
    {
        "public" => Ok(CatalogAudience::Public),
        "builder" => Ok(CatalogAudience::Builder),
        "operator" => Ok(CatalogAudience::Operator),
        "system" => Ok(CatalogAudience::System),
        _ => Err(FIELDS.validation_error(format!(
            "{label}.audience must be public, builder, operator, or system."
        ))),
    }
}

fn parse_catalog_visibility(
    value: &JsonObject,
    label: &str,
) -> Result<CatalogVisibility, ValidationError> {
    match FIELDS
        .optional_string(value.get("visibility"), &format!("{label}.visibility"))?
        .as_deref()
    {
        Some("public") | None => Ok(CatalogVisibility::Public),
        Some("internal") => Ok(CatalogVisibility::Internal),
        Some(_) => {
            Err(FIELDS.validation_error(format!("{label}.visibility must be public or internal.")))
        }
    }
}

fn parse_catalog_role(value: &JsonObject, label: &str) -> Result<CatalogRole, ValidationError> {
    match FIELDS
        .required_string(value.get("role"), &format!("{label}.role"))?
        .as_str()
    {
        "canonical" => Ok(CatalogRole::Canonical),
        "branded" => Ok(CatalogRole::Branded),
        "context" => Ok(CatalogRole::Context),
        "graph-stage" => Ok(CatalogRole::GraphStage),
        "runtime-path" => Ok(CatalogRole::RuntimePath),
        "harness-fixture" => Ok(CatalogRole::HarnessFixture),
        _ => Err(FIELDS.validation_error(format!(
            "{label}.role must be canonical, branded, context, graph-stage, runtime-path, or harness-fixture."
        ))),
    }
}

fn validate_catalog_role(
    visibility: CatalogVisibility,
    role: CatalogRole,
    label: &str,
) -> Result<(), ValidationError> {
    if visibility == CatalogVisibility::Public
        && matches!(
            role,
            CatalogRole::GraphStage | CatalogRole::RuntimePath | CatalogRole::HarnessFixture
        )
    {
        return Err(FIELDS.validation_error(format!(
            "{label}.role cannot be {} when visibility is public.",
            role.as_str()
        )));
    }
    Ok(())
}

fn validate_catalog_bindings(
    role: CatalogRole,
    canonical_skill: &Option<String>,
    provider: &Option<String>,
    part_of: &[String],
    label: &str,
) -> Result<(), ValidationError> {
    if role == CatalogRole::Branded {
        if canonical_skill.is_none() {
            return Err(FIELDS.validation_error(format!(
                "{label}.canonical_skill is required when catalog.role is branded."
            )));
        }
        if provider.is_none() {
            return Err(FIELDS.validation_error(format!(
                "{label}.provider is required when catalog.role is branded."
            )));
        }
    }
    if matches!(
        role,
        CatalogRole::GraphStage | CatalogRole::RuntimePath | CatalogRole::HarnessFixture
    ) && part_of.is_empty()
    {
        return Err(FIELDS.validation_error(format!(
            "{label}.part_of is required when catalog.role is {}.",
            role.as_str()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(source: &str) -> Result<crate::SkillRunnerManifest, String> {
        let parsed =
            crate::parse_runner_manifest_yaml(source).map_err(|error| error.to_string())?;
        crate::validate_runner_manifest(parsed).map_err(|error| error.to_string())
    }

    #[test]
    fn catalog_semantic_report_flags_plan_only_default_and_unreachable_readback_for_enforcement()
    -> Result<(), String> {
        let manifest = manifest(
            r#"skill: github-sync
catalog:
  kind: skill
  audience: public
  visibility: public
  role: canonical
  execution: execute
  completion: provider_readback
  requires_adapter: true
  approval: required
runners:
  plan:
    default: true
    type: javascript
    module: plan.mjs
    outputs:
      plan: object
    artifacts:
      named_emits: { plan: plan }
      packets: { plan: runx.github_sync.plan.v1 }
"#,
        )?;
        let report = analyze_catalog_semantics("github-sync", &manifest);
        assert_eq!(report.mode, "enforced");
        assert_eq!(report.default_runner.as_deref(), Some("plan"));
        let codes = report
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code)
            .collect::<Vec<_>>();
        assert!(codes.contains(&CatalogSemanticCode::DefaultRunnerIsPlanningOnly));
        assert!(codes.contains(&CatalogSemanticCode::ProviderReadbackUnreachable));
        assert!(codes.contains(&CatalogSemanticCode::AdapterUnreachable));
        assert!(codes.contains(&CatalogSemanticCode::ApprovalUnreachable));
        assert!(report.diagnostics.iter().all(|diagnostic| {
            diagnostic.skill == "github-sync"
                && diagnostic.runner == "plan"
                && !diagnostic.required_correction.is_empty()
        }));
        Ok(())
    }

    #[test]
    fn catalog_semantic_report_identifies_mock_default_deterministically() -> Result<(), String> {
        let manifest = manifest(
            r#"skill: spend
catalog:
  kind: skill
  audience: public
  visibility: public
  role: canonical
  execution: execute
  completion: runtime_receipt
  requires_adapter: false
  approval: required
runners:
  mock:
    default: true
    type: javascript
    module: mock.mjs
    mutating: true
    idempotency: { required: true }
"#,
        )?;
        let first = analyze_catalog_semantics("spend", &manifest);
        let second = analyze_catalog_semantics("spend", &manifest);
        assert_eq!(first, second);
        assert!(
            first
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == CatalogSemanticCode::MockDefault)
        );
        Ok(())
    }

    #[test]
    fn package_semantic_report_requires_executable_cold_direct_and_composed_proof()
    -> Result<(), String> {
        let manifest = manifest(
            r#"skill: digest-note
catalog:
  kind: graph
  audience: public
  visibility: public
  role: context
  execution: read
  completion: runtime_receipt
  requires_adapter: false
  approval: none
harness:
  cases:
    - name: direct-only
      runner: digest
      operator_journeys:
        - mode: standalone
          confusors: [extract, sign-receipt]
          request: Digest this exact note into a reusable identity.
          expected_outcome: Return the canonical digest for the supplied bytes.
      inputs: { note: hello }
      expect: { status: sealed }
runners:
  digest:
    default: true
    type: graph
    inputs:
      note: { type: string, required: true, description: Exact note bytes. }
    graph:
      name: digest-note
      result_from: [digest]
      steps:
        - id: digest
          tool: data.digest
          inputs: { value: $input.note }
"#,
        )?;

        let report = analyze_package_catalog_semantics("digest-note", &manifest, &BTreeMap::new());
        assert!(report.readiness.evaluated);
        assert!(report.readiness.cold_selection);
        assert!(report.readiness.standalone_default);
        assert!(!report.readiness.composed_reuse);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == CatalogSemanticCode::MissingComposedReuseProof
        }));
        Ok(())
    }

    #[test]
    fn package_semantic_report_never_upgrades_supplied_agent_answers_to_provider_proof()
    -> Result<(), String> {
        let manifest = manifest(
            r#"skill: provider-reader
catalog:
  kind: graph
  audience: public
  visibility: public
  role: canonical
  execution: read
  completion: provider_readback
  requires_adapter: true
  approval: none
harness:
  cases:
    - name: supplied-answer-provider-case
      runner: read
      operator_journeys:
        - mode: standalone
          confusors: [github-sync, slack]
          request: Read this exact provider resource through its configured account.
          expected_outcome: Return bounded provider readback for the exact target.
        - mode: composed
          request: Continue from this already selected provider target.
          expected_outcome: Reuse the selected target without repeating discovery.
          prior_evidence: [The exact provider and target selected upstream.]
          must_not_repeat: [Do not rediscover or replace the selected target.]
      caller:
        answers:
          agent_task.fake.output: { provider_result: { id: resource-1 } }
      expect: { status: sealed }
runners:
  read:
    default: true
    type: graph
    inputs: {}
    graph:
      name: provider-reader
      result_from: [readback]
      steps:
        - id: readback
          tool: provider.read
          scopes: [resource.read]
          policy:
            provider_permission: { verb: read }
          inputs:
            operation: resource.read
            target: resource-1
            expected_provider: example
            result_fields: [id]
"#,
        )?;

        let report =
            analyze_package_catalog_semantics("provider-reader", &manifest, &BTreeMap::new());
        assert!(report.diagnostics.is_empty(), "{:#?}", report.diagnostics);
        assert!(report.readiness.supplied_agent_answers);
        assert_eq!(report.readiness.provider_proof, CatalogProviderProof::None);
        Ok(())
    }
}

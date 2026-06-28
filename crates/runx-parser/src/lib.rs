//! Pure Rust parser parity crate for runx skills, graphs, and tools.

pub mod error;
pub mod graph;
pub mod install;
mod json_fields;
pub mod runner;
pub mod skill;
pub mod tool;
pub mod yaml;

pub use error::{ParseError, ParseErrorKind, ValidationError, ValidationErrorKind};
pub use graph::{
    ExecutionGraph, FanoutBranchFailurePolicy, FanoutConflictAction, FanoutConflictGate,
    FanoutGroupPolicy, FanoutSyncStrategy, FanoutThresholdAction, FanoutThresholdGate,
    GraphContextEdge, GraphGuard, GraphPolicy, GraphRetryPolicy, GraphStep, MintAuthorityDirective,
    MintScopeSource, RawGraphIr, parse_graph_yaml, validate_graph, validate_graph_document,
};
pub use install::{
    SkillInstallError, SkillInstallOrigin, ValidatedSkillInstall, validate_skill_install,
};
pub use runner::{
    RawRunnerManifestIr, SkillRunnerManifest, parse_runner_manifest_yaml, validate_runner_manifest,
};
pub use skill::{
    ActDeclaration, CatalogAudience, CatalogKind, CatalogMetadata, CatalogRole, CatalogVisibility,
    HarnessCallerFixture, HarnessExpectation, InputMode, RawSkillIr, ReceiptExpectation,
    RunnerHarnessCase, RunnerHarnessManifest, SkillArtifactContract, SkillHttpSource,
    SkillIdempotencyPolicy, SkillInput, SkillMcpServer, SkillQualityProfile, SkillRetryPolicy,
    SkillRunnerDefinition, SkillSandbox, SkillSource, SourceKind, ValidateSkillMode,
    ValidateSkillOptions, ValidatedSkill, extract_skill_quality_profile, parse_skill_markdown,
    validate_skill, validate_skill_artifact_contract, validate_skill_source,
    validate_skill_with_options,
};
pub use tool::{
    RawToolManifestIr, ValidatedTool, parse_tool_manifest_json, parse_tool_manifest_yaml,
    validate_tool_manifest,
};
pub use yaml::{
    assert_execution_profile_yaml_subset, assert_yaml_parity_subset, assert_yaml_scalar_subset,
    parse_yaml_document, yaml_scalar_subset_allows,
};

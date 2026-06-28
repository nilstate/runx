//! Native Rust runtime skeleton for runx execution.
//!
//! The runtime owns impure boundaries: filesystem reads, subprocess execution,
//! sandbox preparation, host reporting, and receipt emission. Pure
//! parser/core/receipt crates stay upstream of this crate.
//!
//! The root exports are a facade for CLI, SDK, and test consumers. Helper
//! surfaces stay under their owning modules: harness replay under `harness`,
//! receipt stores under `receipts`, adapter protocol under `adapter`, and
//! runtime orchestration under `runner` or `orchestrator`.

pub mod adapter;
#[cfg(any(
    feature = "cli-tool",
    feature = "catalog",
    feature = "mcp",
    feature = "a2a",
    feature = "agent",
    feature = "external-adapter"
))]
mod adapter_pipeline;
mod agent_invocation;
pub mod approval;
pub mod config;
pub mod credentials;
pub mod dev;
pub mod doctor;
pub mod effects;
pub mod error;
pub mod execution;
pub mod export;
mod filesystem;
pub mod host;
mod http;
pub mod journal;
mod json_render;
mod lifecycle;
pub mod list;
pub mod outbox_provider;
pub mod parser_eval;
mod path_util;
mod process;
pub mod receipts;
pub mod redaction;
pub mod registry;
pub mod sandbox;
pub mod scaffold;
mod services;
mod time;
pub mod tool_catalogs;

pub use execution::harness;
pub use execution::orchestrator;
pub use execution::runner;
pub use execution::skill_front;

#[cfg(any(
    feature = "cli-tool",
    feature = "catalog",
    feature = "mcp",
    feature = "a2a",
    feature = "agent",
    feature = "external-adapter",
    feature = "http",
    feature = "thread-outbox-provider"
))]
pub mod adapters;

pub use adapter::{
    FanoutExecutionMode, InvocationStatus, SkillAdapter, SkillInvocation, SkillOutput,
};
pub use approval::{ApprovalError, LocalApprovalGateResolver, request_approval};
pub use config::{
    ConfigError, ConfigKey, LocalProfileSource, ManagedAgentConfig, RunxAgentConfig,
    RunxConfigFile, RunxPublicConfig, load_local_agent_api_key, load_local_public_api_token,
    load_managed_agent_config, load_runx_config_file, lookup_runx_config_value,
    managed_agent_provider, mask_runx_config_file, parse_config_key, resolve_local_skill_profile,
    resolve_path_from_user_input, resolve_runx_global_home_dir, resolve_runx_home_dir,
    update_runx_config_value, write_runx_config_file,
};
pub use credentials::{
    CredentialDelivery, CredentialDeliveryError, CredentialDeliveryProfile, CredentialMaterialRole,
    CredentialResolution, CredentialResolutionRequest, CredentialSupervisor,
    InMemoryMaterialResolver, MaterialCredentialSupervisor, MaterialResolver,
    ResolvedCredentialMaterial, SecretEnv, SecretString,
};
pub use dev::{
    DevFixtureResult, DevFixtureStatus, DevLoopOptions, DevReport, DevReportStatus,
    DevWatchOptions, DevWatchTrigger, PollingDevWatcher, dev_receipt_metadata,
    discover_fixture_paths, render_dev_result, run_dev_once, should_ignore_dev_watch_path,
};
pub use doctor::{DoctorOptions, default_doctor_options, run_doctor};
pub use effects::{
    EffectAdmission, EffectMetadataRefreshRequest, EffectOutputRequest, EffectReceiptRequest,
    EffectReplay, EffectReplayOutputRequest, EffectReplayReceiptRequest, EffectStepRequest,
    PROVIDER_PERMISSION_EFFECT_FAMILY, PROVIDER_PERMISSION_GRANT_ID_ENV,
    PROVIDER_PERMISSION_GRANTED_SCOPES_ENV, ProviderPermissionAdmission, ProviderPermissionEffect,
    RuntimeEffect, RuntimeEffectError, RuntimeEffectRegistry, insert_effect_verification_ref,
};
pub use error::RuntimeError;
pub use harness::{
    HarnessExpectedStatus, HarnessFixtureError, HarnessFixtureKind, HarnessReplayError,
    HarnessReplayOutput, load_harness_fixture, parse_harness_fixture, run_harness_fixture,
    run_harness_fixture_with_adapter,
};
pub use host::{Host, NoopHost};
pub use journal::ExecutionJournal;
pub use list::{
    RunxListItem, RunxListItemKind, RunxListOptions, RunxListRequestedKind, RunxListStatus,
    list_authoring_primitives,
};
pub use orchestrator::{
    GraphRunRequest, HarnessRunRequest, InlineHarnessRequest, LocalOrchestrator, OrchestratorError,
    RunContinuation, RunRequest, RunResult, RunStatus, SkillRunRequest,
};
pub use outbox_provider::{
    ThreadOutboxProviderProcessOutcome, ThreadOutboxProviderProcessSupervisor,
    ThreadOutboxProviderSupervisorError, ThreadOutboxProviderSupervisorOptions,
    thread_outbox_provider_forbidden_secret_fields,
};
pub use parser_eval::{ParserEvalError, ParserEvalOutput, evaluate_parser_document_str};
pub use receipts::paths::{
    INIT_CWD_ENV, RUNTIME_RECEIPTS_DIR_CONFIG_KEY, RUNX_CWD_ENV, RUNX_PROJECT_DIR_ENV,
    RUNX_RECEIPT_DIR_ENV, ReceiptPathInputs, ReceiptPathSource, ReceiptStoreLabel,
    ResolvedReceiptPath, RuntimeReceiptConfig, resolve_project_runx_dir, resolve_receipt_path,
    resolve_workspace_base, safe_receipt_store_label,
};
pub use receipts::store::{
    LocalReceiptStore, ReceiptStoreError, ReceiptStoreIndex, ReceiptStoreIndexEntry,
};
pub use receipts::tree::{
    RuntimeReceiptResolver, validate_runtime_receipt_tree, verify_runtime_receipt_tree,
    verify_runtime_receipt_tree_with_policy,
};
pub use receipts::{
    Ed25519ReceiptSigner, Ed25519ReceiptVerifier, ProductionReceiptKey,
    RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64_ENV, RUNX_RECEIPT_SIGN_ISSUER_TYPE_ENV,
    RUNX_RECEIPT_SIGN_KID_ENV, RuntimeReceiptSignatureConfig, RuntimeReceiptSignaturePolicy,
    RuntimeReceiptSigner, RuntimeReceiptSigningError,
};
pub use redaction::redact_sensitive_text;
pub use registry::{RegistryInstallMetadataInput, registry_install_receipt_metadata};
#[cfg(feature = "cli-tool")]
pub use runner::run_graph_file;
pub use runner::{
    GraphCheckpoint, GraphRun, RUNX_MAX_FANOUT_CONCURRENCY_ENV, RUNX_RUN_ID_ENV, Runtime,
    RuntimeOptions, StepRun,
};
pub use runx_core::kernel_eval;
pub use runx_parser::{SkillSource, parse_runner_manifest_yaml, validate_runner_manifest};
pub use runx_receipts::ReceiptTreeConfig;
pub use scaffold::{
    InitAction, InitGeneratedValues, RunxInitOptions, RunxInitResult, RunxNewOptions,
    RunxNewResult, ScaffoldError, runx_init, sanitize_runx_package_name, scaffold_runx_package,
};
pub use skill_front::InlineHarnessReport;
pub use tool_catalogs::{
    ToolBuildOptions, ToolCatalogError, ToolInspectOptions, ToolSearchOptions, build_tool_catalogs,
    inspect_tool, search_tools,
};

pub const PACKAGE_NAME: &str = env!("CARGO_PKG_NAME");

// rust-style-allow: large-file - prepared requests keep digest construction,
// drift guards, approval evidence, and their security fixtures co-located.
//! Digest-bound preparation for operator-approved skill execution.
//!
//! The public report is deliberately safe to print or serialize. The owned
//! request and canonical digest preimage are private so raw input bodies and
//! credential material cannot leak through the approval surface.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::{JsonValue, Reference, ReferenceType, sha256_prefixed};
use runx_parser::{SkillRunnerDefinition, SkillRunnerManifest};
use serde::{Deserialize, Serialize};

use super::operator_context::{
    SkillOperatorContextChain, SkillOperatorContextNode, SkillOperatorContextOptions,
    load_skill_operator_context_chain,
};
use super::orchestrator::{LocalCredentialDescriptor, SkillRunRequest};
use super::skill_front::SkillRunError;
use super::skill_front::runner_manifest::{
    load_runner_manifest, resolve_skill_dir, selected_runner,
};
use crate::RuntimeError;

pub const PREPARED_SKILL_REPORT_SCHEMA: &str = "runx.prepared_skill_run.v1";
pub(crate) const PREPARED_CONTEXT_DIGEST_ENV: &str = "RUNX_INTERNAL_PREPARED_CONTEXT_DIGEST";
pub(crate) const PREPARED_APPROVAL_ACTOR_ENV: &str = "RUNX_INTERNAL_PREPARED_APPROVAL_ACTOR";
pub(crate) const PREPARED_APPROVAL_MODE_ENV: &str = "RUNX_INTERNAL_PREPARED_APPROVAL_MODE";
pub(crate) const PREPARED_APPROVAL_TIME_ENV: &str = "RUNX_INTERNAL_PREPARED_APPROVAL_TIME";
pub(crate) const PREPARED_ARTIFACT_GUARDS_ENV: &str = "RUNX_INTERNAL_PREPARED_ARTIFACT_GUARDS";

pub(crate) fn strip_untrusted_prepared_env(env: &mut BTreeMap<String, String>) {
    for name in [
        PREPARED_CONTEXT_DIGEST_ENV,
        PREPARED_APPROVAL_ACTOR_ENV,
        PREPARED_APPROVAL_MODE_ENV,
        PREPARED_APPROVAL_TIME_ENV,
        PREPARED_ARTIFACT_GUARDS_ENV,
    ] {
        env.remove(name);
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparedSkillRunStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedEntryProvenance {
    pub kind: String,
    pub reference: Option<String>,
    pub source: String,
    pub source_label: String,
    pub skill_id: Option<String>,
    pub version: Option<String>,
    pub digest: Option<String>,
    pub package_digest: Option<String>,
    pub trust_tier: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedInputSummary {
    pub name: String,
    pub value_type: String,
    pub canonical_bytes: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedCredentialSummary {
    pub provider: String,
    pub auth_mode: String,
    pub env_var: String,
    pub material_ref_sha256: String,
    pub scopes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedRequestSummary {
    pub skill_path: PathBuf,
    pub cwd: PathBuf,
    pub runner: String,
    pub receipt_dir: Option<PathBuf>,
    pub run_id: Option<String>,
    pub answers_path: Option<PathBuf>,
    pub inputs: Vec<PreparedInputSummary>,
    pub credential: Option<PreparedCredentialSummary>,
    pub entry: PreparedEntryProvenance,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedGovernanceSummary {
    pub declared_steps: usize,
    pub conditional_steps: usize,
    pub mutating_steps: Vec<String>,
    pub tool_refs: Vec<String>,
    pub authority_scopes: Vec<String>,
    pub gates: Vec<String>,
    pub retry_policies: Vec<String>,
    pub idempotency_keys: Vec<String>,
    pub recovery_notes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedTraceEntry {
    pub node_path: String,
    pub stage: String,
    pub outcome: String,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedSkillRunApproval {
    pub actor: String,
    pub mode: String,
    pub observed_at: String,
}

impl PreparedSkillRunApproval {
    #[must_use]
    pub fn now(actor: impl Into<String>, mode: impl Into<String>) -> Self {
        Self {
            actor: actor.into(),
            mode: mode.into(),
            observed_at: crate::time::now_iso8601(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PreparedSkillRunReport {
    pub schema: String,
    pub status: PreparedSkillRunStatus,
    pub digest: String,
    pub request: PreparedRequestSummary,
    pub governance: PreparedGovernanceSummary,
    pub chain: Option<SkillOperatorContextChain>,
    pub trace: Vec<PreparedTraceEntry>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreparedArtifactGuard {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Clone)]
pub struct PreparedSkillRun {
    request: SkillRunRequest,
    selected_runner: String,
    manifest: SkillRunnerManifest,
    runner: SkillRunnerDefinition,
    report: PreparedSkillRunReport,
    guards: Vec<PreparedArtifactGuard>,
    approval: Option<PreparedSkillRunApproval>,
}

impl std::fmt::Debug for PreparedSkillRun {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedSkillRun")
            .field("selected_runner", &self.selected_runner)
            .field("report", &self.report)
            .field("guard_count", &self.guards.len())
            .finish_non_exhaustive()
    }
}

impl PreparedSkillRun {
    #[must_use]
    pub fn report(&self) -> &PreparedSkillRunReport {
        &self.report
    }

    #[must_use]
    pub fn digest(&self) -> &str {
        &self.report.digest
    }

    #[must_use]
    pub fn is_ready(&self) -> bool {
        self.report.status == PreparedSkillRunStatus::Ready
    }

    pub fn approve(&mut self, approval: PreparedSkillRunApproval) -> Result<(), SkillRunError> {
        if !self.is_ready() {
            return Err(SkillRunError::Invalid(
                self.report
                    .blocked_reason
                    .clone()
                    .unwrap_or_else(|| "prepared skill run is blocked".to_owned()),
            ));
        }
        self.request.env.insert(
            PREPARED_CONTEXT_DIGEST_ENV.to_owned(),
            self.report.digest.clone(),
        );
        self.request.env.insert(
            PREPARED_APPROVAL_ACTOR_ENV.to_owned(),
            approval.actor.clone(),
        );
        self.request
            .env
            .insert(PREPARED_APPROVAL_MODE_ENV.to_owned(), approval.mode.clone());
        self.request.env.insert(
            PREPARED_APPROVAL_TIME_ENV.to_owned(),
            approval.observed_at.clone(),
        );
        let guards = self
            .guards
            .iter()
            .map(|guard| {
                let path = fs::canonicalize(&guard.path).unwrap_or_else(|_| guard.path.clone());
                (path.to_string_lossy().into_owned(), guard.sha256.clone())
            })
            .collect::<BTreeMap<_, _>>();
        let encoded = serde_json::to_string(&guards)
            .map_err(|source| RuntimeError::json("serializing prepared artifact guards", source))?;
        self.request
            .env
            .insert(PREPARED_ARTIFACT_GUARDS_ENV.to_owned(), encoded);
        self.approval = Some(approval);
        Ok(())
    }

    #[must_use]
    pub fn approval(&self) -> Option<&PreparedSkillRunApproval> {
        self.approval.as_ref()
    }

    pub(crate) fn request(&self) -> &SkillRunRequest {
        &self.request
    }

    pub(crate) fn selected_runner(&self) -> &str {
        &self.selected_runner
    }

    pub(crate) fn manifest(&self) -> &SkillRunnerManifest {
        &self.manifest
    }

    pub(crate) fn runner(&self) -> &SkillRunnerDefinition {
        &self.runner
    }

    pub(crate) fn verify_artifacts(&self) -> Result<(), SkillRunError> {
        for guard in &self.guards {
            let content = fs::read(&guard.path).map_err(|source| {
                RuntimeError::io(
                    format!("verifying prepared artifact {}", guard.path.display()),
                    source,
                )
            })?;
            let actual = sha256_prefixed(&content);
            if actual != guard.sha256 {
                return Err(SkillRunError::Invalid(format!(
                    "prepared artifact drift at {}: expected {}, actual {}",
                    guard.path.display(),
                    guard.sha256,
                    actual
                )));
            }
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct PreparedAuthorizationPreimage<'a> {
    schema: &'static str,
    skill_path: &'a Path,
    cwd: &'a Path,
    runner: &'a str,
    answers_path: Option<&'a Path>,
    inputs: &'a BTreeMap<String, JsonValue>,
    credential: Option<PreparedCredentialSummary>,
    entry: &'a PreparedEntryProvenance,
    chain: Option<&'a SkillOperatorContextChain>,
    blocked_reason: Option<&'a str>,
}

// rust-style-allow: long-function - preparation builds one canonical snapshot,
// trace, digest preimage, governance summary, and guard set atomically.
pub fn prepare_skill_run(
    mut request: SkillRunRequest,
    selected_runner_name: Option<&str>,
    entry: PreparedEntryProvenance,
) -> Result<PreparedSkillRun, SkillRunError> {
    strip_untrusted_prepared_env(&mut request.env);
    let skill_dir = resolve_skill_dir(&request.skill_path)?;
    let manifest = load_runner_manifest(&skill_dir)?;
    let runner = selected_runner(&manifest, selected_runner_name)?.clone();
    super::skill_front::apply_runner_input_defaults(&mut request.inputs, &runner);
    let request_summary = request_summary(&request, &skill_dir, &runner.name, entry);
    let missing = missing_required_inputs(&runner, &request.inputs);

    let mut trace = vec![PreparedTraceEntry {
        node_path: "entry".to_owned(),
        stage: "resolve_runner".to_owned(),
        outcome: "resolved".to_owned(),
        detail: format!("selected runner {}", runner.name),
    }];
    let (status, chain, blocked_reason) = if missing.is_empty() {
        match load_skill_operator_context_chain(
            &skill_dir,
            Some(&runner.name),
            SkillOperatorContextOptions::new(request.env.clone(), request.cwd.clone()),
        ) {
            Ok(chain) => {
                trace.push(PreparedTraceEntry {
                    node_path: "entry".to_owned(),
                    stage: "expand_chain".to_owned(),
                    outcome: "resolved".to_owned(),
                    detail: format!("expanded {} nodes", chain.node_count),
                });
                (PreparedSkillRunStatus::Ready, Some(chain), None)
            }
            Err(error) => {
                let reason = error.to_string();
                trace.push(PreparedTraceEntry {
                    node_path: trace_node_path(&reason),
                    stage: "expand_chain".to_owned(),
                    outcome: "blocked".to_owned(),
                    detail: reason.clone(),
                });
                (PreparedSkillRunStatus::Blocked, None, Some(reason))
            }
        }
    } else {
        let reason = format!("missing required inputs: {}", missing.join(", "));
        trace.push(PreparedTraceEntry {
            node_path: "entry".to_owned(),
            stage: "validate_inputs".to_owned(),
            outcome: "blocked".to_owned(),
            detail: reason.clone(),
        });
        (PreparedSkillRunStatus::Blocked, None, Some(reason))
    };

    let governance = chain.as_ref().map(governance_summary).unwrap_or_default();
    // Receipt storage and generated run identity are execution bookkeeping, not
    // authority. Keeping them out of this preimage lets an operator approve the
    // same semantic run contract regardless of where its evidence is written.
    let preimage = PreparedAuthorizationPreimage {
        schema: PREPARED_SKILL_REPORT_SCHEMA,
        skill_path: &request_summary.skill_path,
        cwd: &request_summary.cwd,
        runner: &request_summary.runner,
        answers_path: request_summary.answers_path.as_deref(),
        inputs: &request.inputs,
        credential: request_summary.credential.clone(),
        entry: &request_summary.entry,
        chain: chain.as_ref(),
        blocked_reason: blocked_reason.as_deref(),
    };
    let bytes = serde_json::to_vec(&preimage)
        .map_err(|source| RuntimeError::json("serializing prepared skill digest", source))?;
    let digest = sha256_prefixed(&bytes);
    let guards = chain.as_ref().map(artifact_guards).unwrap_or_default();
    Ok(PreparedSkillRun {
        request,
        selected_runner: runner.name.clone(),
        manifest,
        runner,
        report: PreparedSkillRunReport {
            schema: PREPARED_SKILL_REPORT_SCHEMA.to_owned(),
            status,
            digest,
            request: request_summary,
            governance,
            chain,
            trace,
            blocked_reason,
        },
        guards,
        approval: None,
    })
}

pub(crate) fn prepared_receipt_references(env: &BTreeMap<String, String>) -> Vec<Reference> {
    let Some(digest) = env.get(PREPARED_CONTEXT_DIGEST_ENV) else {
        return Vec::new();
    };
    let digest_id = digest.strip_prefix("sha256:").unwrap_or(digest);
    let artifact = Reference {
        reference_type: ReferenceType::Artifact,
        uri: format!("runx:artifact:operator_context:{digest_id}").into(),
        provider: Some("runx".to_owned().into()),
        locator: Some(digest.clone().into()),
        label: Some("approved operator context".to_owned().into()),
        observed_at: None,
        proof_kind: None,
    };
    let actor = env
        .get(PREPARED_APPROVAL_ACTOR_ENV)
        .map(String::as_str)
        .unwrap_or("local_operator");
    let mode = env
        .get(PREPARED_APPROVAL_MODE_ENV)
        .map(String::as_str)
        .unwrap_or("explicit_digest");
    let decision = Reference {
        reference_type: ReferenceType::Decision,
        uri: format!("runx:decision:operator_context_approval:{digest_id}").into(),
        provider: Some("runx".to_owned().into()),
        locator: Some(format!("actor={actor};mode={mode}").into()),
        label: Some("operator context approval".to_owned().into()),
        observed_at: env.get(PREPARED_APPROVAL_TIME_ENV).cloned().map(Into::into),
        proof_kind: None,
    };
    vec![artifact, decision]
}

pub(crate) fn verify_prepared_artifact_at_use(
    env: &BTreeMap<String, String>,
    path: &Path,
) -> Result<(), RuntimeError> {
    let Some(encoded) = env.get(PREPARED_ARTIFACT_GUARDS_ENV) else {
        return Ok(());
    };
    let guards = serde_json::from_str::<BTreeMap<String, String>>(encoded)
        .map_err(|source| RuntimeError::json("parsing prepared artifact guards", source))?;
    let canonical = fs::canonicalize(path).map_err(|source| {
        RuntimeError::io(
            format!("canonicalizing prepared artifact {}", path.display()),
            source,
        )
    })?;
    let key = canonical.to_string_lossy();
    let Some(expected) = guards.get(key.as_ref()) else {
        return Ok(());
    };
    let content = fs::read(&canonical).map_err(|source| {
        RuntimeError::io(
            format!("verifying prepared artifact {} at use", canonical.display()),
            source,
        )
    })?;
    let actual = sha256_prefixed(&content);
    if &actual != expected {
        return Err(RuntimeError::SkillFailed {
            skill_name: "prepared-run".to_owned(),
            message: format!(
                "prepared artifact drift at use boundary {}: expected {}, actual {}",
                canonical.display(),
                expected,
                actual
            ),
        });
    }
    Ok(())
}

fn request_summary(
    request: &SkillRunRequest,
    skill_dir: &Path,
    runner: &str,
    mut entry: PreparedEntryProvenance,
) -> PreparedRequestSummary {
    if entry.kind.is_empty() {
        entry.kind = "local_path".to_owned();
    }
    if entry.source.is_empty() {
        entry.source = "local-path".to_owned();
    }
    if entry.source_label.is_empty() {
        entry.source_label = skill_dir.to_string_lossy().into_owned();
    }
    PreparedRequestSummary {
        skill_path: skill_dir.to_path_buf(),
        cwd: request.cwd.clone(),
        runner: runner.to_owned(),
        receipt_dir: request.receipt_dir.clone(),
        run_id: request.run_id.clone(),
        answers_path: request.answers_path.clone(),
        inputs: request
            .inputs
            .iter()
            .map(|(name, value)| {
                let bytes = serde_json::to_vec(value).unwrap_or_default();
                PreparedInputSummary {
                    name: name.clone(),
                    value_type: json_type(value).to_owned(),
                    canonical_bytes: bytes.len(),
                    sha256: sha256_prefixed(&bytes),
                }
            })
            .collect(),
        credential: request.local_credential.as_ref().map(credential_summary),
        entry,
    }
}

fn credential_summary(value: &LocalCredentialDescriptor) -> PreparedCredentialSummary {
    PreparedCredentialSummary {
        provider: value.provider.clone(),
        auth_mode: value.auth_mode.clone(),
        env_var: value.env_var.clone(),
        material_ref_sha256: sha256_prefixed(value.material_ref.as_bytes()),
        scopes: value.scopes.clone(),
    }
}

/// Required inputs the runner declares that are absent (and carry no default).
/// The single source of truth for the required-input contract, shared by the
/// prepare stage and the inline harness so both enforce it identically.
pub(crate) fn missing_required_inputs(
    runner: &SkillRunnerDefinition,
    inputs: &BTreeMap<String, JsonValue>,
) -> Vec<String> {
    runner
        .inputs
        .iter()
        .filter(|(name, input)| {
            input.required && input.default.is_none() && !inputs.contains_key(*name)
        })
        .map(|(name, _)| name.clone())
        .collect()
}

fn json_type(value: &JsonValue) -> &'static str {
    match value {
        JsonValue::Null => "null",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Number(_) => "number",
        JsonValue::String(_) => "string",
        JsonValue::Array(_) => "array",
        JsonValue::Object(_) => "object",
    }
}

fn governance_summary(chain: &SkillOperatorContextChain) -> PreparedGovernanceSummary {
    let mut summary = PreparedGovernanceSummary::default();
    summarize_node(&chain.entry, &mut summary);
    summary.mutating_steps.sort();
    summary.tool_refs.sort();
    summary.tool_refs.dedup();
    summary.authority_scopes.sort();
    summary.authority_scopes.dedup();
    summary.gates.sort();
    summary.gates.dedup();
    summary.retry_policies.sort();
    summary.retry_policies.dedup();
    summary.idempotency_keys.sort();
    summary.idempotency_keys.dedup();
    summary
}

fn summarize_node(node: &SkillOperatorContextNode, summary: &mut PreparedGovernanceSummary) {
    for step in &node.steps {
        if json_field(&step.raw, "when").is_some() {
            summary.conditional_steps += 1;
        } else {
            summary.declared_steps += 1;
        }
        if step.mutating {
            summary.mutating_steps.push(step.node_path.clone());
        }
        summary.tool_refs.extend(step.tool_refs.iter().cloned());
        collect_string_values(&step.raw, "authority", &mut summary.authority_scopes);
        collect_string_values(&step.raw, "approval", &mut summary.gates);
        collect_string_values(&step.raw, "gate", &mut summary.gates);
        collect_string_values(&step.raw, "retry", &mut summary.retry_policies);
        collect_string_values(&step.raw, "idempotency_key", &mut summary.idempotency_keys);
        collect_string_values(&step.raw, "recovery", &mut summary.recovery_notes);
        if let Some(child) = &step.child {
            summarize_node(child, summary);
        }
    }
}

fn collect_string_values(value: &JsonValue, key: &str, output: &mut Vec<String>) {
    if let Some(value) = json_field(value, key) {
        match value {
            JsonValue::String(value) => output.push(value.clone()),
            JsonValue::Array(values) => output.extend(
                values
                    .iter()
                    .filter_map(JsonValue::as_str)
                    .map(str::to_owned),
            ),
            other => output.push(
                serde_json::to_string(other).unwrap_or_else(|_| "<unserializable>".to_owned()),
            ),
        }
    }
}

fn json_field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(key),
        _ => None,
    }
}

fn artifact_guards(chain: &SkillOperatorContextChain) -> Vec<PreparedArtifactGuard> {
    let mut guards = BTreeMap::<PathBuf, String>::new();
    collect_node_guards(&chain.entry, &mut guards);
    guards
        .into_iter()
        .map(|(path, sha256)| PreparedArtifactGuard { path, sha256 })
        .collect()
}

fn collect_node_guards(node: &SkillOperatorContextNode, guards: &mut BTreeMap<PathBuf, String>) {
    if let Some(path) = &node.skill_markdown.path {
        guards.insert(path.clone(), node.skill_markdown.sha256.clone());
    }
    let manifest_path = node.package.directory.join("X.yaml");
    if let Ok(content) = fs::read(&manifest_path) {
        guards.insert(manifest_path, sha256_prefixed(&content));
    }
    for tool in &node.tools {
        if let (Some(path), Some(sha256)) = (&tool.path, &tool.sha256) {
            guards.insert(path.clone(), sha256.clone());
        }
    }
    for step in &node.steps {
        for context in &step.context_skills {
            if let Some(path) = &context.document.path {
                guards.insert(path.clone(), context.document.sha256.clone());
            }
        }
        if let Some(child) = &step.child {
            collect_node_guards(child, guards);
        }
    }
}

fn trace_node_path(message: &str) -> String {
    message
        .split_whitespace()
        .find(|word| word.starts_with("entry"))
        .map(|word| word.trim_matches(|value: char| !value.is_alphanumeric() && value != '.'))
        .filter(|word| !word.is_empty())
        .unwrap_or("entry")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use std::error::Error;

    use tempfile::tempdir;

    use super::*;

    fn write_skill(directory: &Path, inputs: &str, body: &str) -> Result<(), Box<dyn Error>> {
        fs::create_dir_all(directory)?;
        fs::write(
            directory.join("SKILL.md"),
            format!(
                "---\nname: prepared\ndescription: Test skill for prepared execution.\n---\n\n{body}\n"
            ),
        )?;
        fs::write(
            directory.join("X.yaml"),
            format!(
                "skill: prepared\nrunners:\n  main:\n    default: true\n    type: agent-task\n    agent: reviewer\n    task: review\n    outputs:\n      result: object\n{inputs}"
            ),
        )?;
        Ok(())
    }

    fn request(path: &Path) -> SkillRunRequest {
        SkillRunRequest {
            skill_path: path.to_path_buf(),
            receipt_dir: None,
            run_id: None,
            answers_path: None,
            inputs: BTreeMap::new(),
            // Anchor the runx home inside the test dir: without this the
            // agent path discovers the developer's real ~/.runx agent
            // credentials and resolves inline against the live provider.
            env: BTreeMap::from([("RUNX_HOME".to_owned(), path.to_string_lossy().into_owned())]),
            cwd: path.to_path_buf(),
            local_credential: None,
        }
    }

    #[test]
    fn prepared_skill_digest_is_deterministic_and_binds_inputs() -> Result<(), Box<dyn Error>> {
        let temp = tempdir()?;
        write_skill(temp.path(), "", "# Prepared")?;
        let first = prepare_skill_run(
            request(temp.path()),
            None,
            PreparedEntryProvenance::default(),
        )?;
        let second = prepare_skill_run(
            request(temp.path()),
            None,
            PreparedEntryProvenance::default(),
        )?;
        assert!(first.is_ready());
        assert_eq!(first.digest(), second.digest());
        let mut changed = request(temp.path());
        changed
            .inputs
            .insert("prompt".to_owned(), JsonValue::String("changed".to_owned()));
        let changed = prepare_skill_run(changed, None, PreparedEntryProvenance::default())?;
        assert_ne!(first.digest(), changed.digest());
        Ok(())
    }

    #[test]
    fn prepared_skill_digest_ignores_receipt_storage_and_generated_run_id()
    -> Result<(), Box<dyn Error>> {
        let temp = tempdir()?;
        write_skill(temp.path(), "", "# Prepared")?;

        let baseline = prepare_skill_run(
            request(temp.path()),
            None,
            PreparedEntryProvenance::default(),
        )?;
        let mut relocated = request(temp.path());
        relocated.receipt_dir = Some(temp.path().join("other-receipts"));
        relocated.run_id = Some("rx_other".to_owned());
        let relocated = prepare_skill_run(relocated, None, PreparedEntryProvenance::default())?;

        assert_eq!(baseline.digest(), relocated.digest());
        assert_ne!(
            baseline.report().request.receipt_dir,
            relocated.report().request.receipt_dir
        );
        assert_ne!(
            baseline.report().request.run_id,
            relocated.report().request.run_id
        );
        Ok(())
    }

    #[test]
    fn prepared_skill_applies_declared_input_defaults() -> Result<(), Box<dyn Error>> {
        let temp = tempdir()?;
        write_skill(
            temp.path(),
            "    inputs:\n      data_source_ref:\n        type: string\n        required: false\n        default: local://runx/default\n",
            "# Prepared",
        )?;

        let prepared = prepare_skill_run(
            request(temp.path()),
            None,
            PreparedEntryProvenance::default(),
        )?;

        assert_eq!(
            prepared.request().inputs.get("data_source_ref"),
            Some(&JsonValue::String("local://runx/default".to_owned()))
        );
        Ok(())
    }

    #[test]
    fn prepared_skill_missing_input_returns_blocked_trace() -> Result<(), Box<dyn Error>> {
        let temp = tempdir()?;
        write_skill(
            temp.path(),
            "    inputs:\n      prompt:\n        type: string\n        required: true\n",
            "# Prepared",
        )?;
        let prepared = prepare_skill_run(
            request(temp.path()),
            None,
            PreparedEntryProvenance::default(),
        )?;
        assert_eq!(prepared.report().status, PreparedSkillRunStatus::Blocked);
        assert!(
            prepared
                .report()
                .blocked_reason
                .as_deref()
                .unwrap_or_default()
                .contains("prompt")
        );
        assert!(
            prepared
                .report()
                .trace
                .iter()
                .any(|entry| entry.outcome == "blocked")
        );
        Ok(())
    }

    #[test]
    fn prepared_skill_secret_never_appears_in_public_output_or_debug() -> Result<(), Box<dyn Error>>
    {
        let temp = tempdir()?;
        write_skill(temp.path(), "", "# Prepared")?;
        let sentinel = "SECRET-SENTINEL-DO-NOT-PRINT";
        let mut request = request(temp.path());
        request.local_credential = Some(LocalCredentialDescriptor {
            provider: "example".to_owned(),
            auth_mode: "token".to_owned(),
            env_var: "EXAMPLE_TOKEN".to_owned(),
            material_ref: "opaque-material".to_owned(),
            scopes: vec!["read".to_owned()],
            secret: sentinel.to_owned(),
        });
        let prepared = prepare_skill_run(request, None, PreparedEntryProvenance::default())?;
        let public = serde_json::to_string(prepared.report())?;
        assert!(!public.contains(sentinel));
        assert!(!format!("{prepared:?}").contains(sentinel));
        Ok(())
    }

    #[test]
    fn prepared_skill_strict_tool_resolution_blocks_with_trace() -> Result<(), Box<dyn Error>> {
        let temp = tempdir()?;
        fs::create_dir_all(temp.path())?;
        fs::write(temp.path().join("SKILL.md"), "# Prepared")?;
        fs::write(
            temp.path().join("X.yaml"),
            "skill: prepared\nrunners:\n  main:\n    default: true\n    type: graph\n    graph:\n      name: prepared\n      steps:\n        - id: call\n          tool: missing.tool\n",
        )?;
        let prepared = prepare_skill_run(
            request(temp.path()),
            None,
            PreparedEntryProvenance::default(),
        )?;
        assert_eq!(prepared.report().status, PreparedSkillRunStatus::Blocked);
        assert!(
            prepared
                .report()
                .blocked_reason
                .as_deref()
                .unwrap_or_default()
                .contains("missing.tool")
        );
        Ok(())
    }

    #[test]
    fn prepared_skill_execution_matches_unprepared_and_rejects_drift() -> Result<(), Box<dyn Error>>
    {
        use crate::execution::orchestrator::LocalOrchestrator;

        let temp = tempdir()?;
        write_skill(temp.path(), "", "# Prepared")?;
        let orchestrator = LocalOrchestrator::default();
        let baseline_request = request(temp.path());
        let baseline = orchestrator.run_skill(&baseline_request)?;
        let mut prepared = orchestrator.prepare_skill(
            request(temp.path()),
            None,
            PreparedEntryProvenance::default(),
        )?;
        prepared.approve(PreparedSkillRunApproval::now("test", "explicit_digest"))?;
        let prepared_result = orchestrator.run_prepared_skill(&prepared)?;
        assert_eq!(baseline.status, prepared_result.status);

        fs::write(temp.path().join("SKILL.md"), "# Changed after approval")?;
        let Err(error) = orchestrator.run_prepared_skill(&prepared) else {
            return Err("prepared artifact drift must fail closed".into());
        };
        let message = error.to_string();
        assert!(message.contains("prepared artifact drift"));
        assert!(message.contains("SKILL.md"));
        assert!(message.contains("expected sha256:"));
        assert!(message.contains("actual sha256:"));
        Ok(())
    }

    #[test]
    fn prepared_skill_execution_rejects_child_drift_at_load_boundary() -> Result<(), Box<dyn Error>>
    {
        use crate::execution::graph::{StepSkillLoadOptions, load_step_skill};

        let temp = tempdir()?;
        let entry = temp.path().join("entry");
        let child = entry.join("child");
        fs::create_dir_all(&child)?;
        fs::write(entry.join("SKILL.md"), "# Entry")?;
        fs::write(child.join("SKILL.md"), "# Child")?;
        fs::write(
            child.join("X.yaml"),
            "skill: child\nrunners:\n  child:\n    default: true\n    type: agent-task\n    agent: reviewer\n    task: before\n",
        )?;
        fs::write(
            entry.join("X.yaml"),
            "skill: entry\nrunners:\n  main:\n    default: true\n    type: graph\n    graph:\n      name: entry\n      steps:\n        - id: child\n          skill: ./child\n",
        )?;
        let mut prepared =
            prepare_skill_run(request(&entry), None, PreparedEntryProvenance::default())?;
        prepared.approve(PreparedSkillRunApproval::now("test", "explicit_digest"))?;
        fs::write(
            child.join("X.yaml"),
            "skill: child\nrunners:\n  child:\n    default: true\n    type: agent-task\n    agent: reviewer\n    task: after\n",
        )?;
        let step = &prepared
            .runner
            .source
            .graph
            .as_ref()
            .ok_or("missing graph")?
            .steps[0];
        let error = match load_step_skill(
            &entry,
            step,
            StepSkillLoadOptions {
                env: &prepared.request.env,
            },
        ) {
            Ok(_) => return Err("child drift must fail at load boundary".into()),
            Err(error) => error,
        };
        assert!(error.to_string().contains("drift at use boundary"));
        assert!(error.to_string().contains("child/X.yaml"));
        Ok(())
    }

    #[test]
    fn prepared_skill_receipt_binds_context_artifact_and_approval_decision()
    -> Result<(), Box<dyn Error>> {
        use crate::adapter::{InvocationStatus, SkillOutput};
        use crate::execution::output_projection::project_step_output;
        use crate::receipts::{
            RuntimeReceiptSignaturePolicy, StepSeal, StepSealClosure, seal_step,
        };
        use runx_contracts::ClosureDisposition;

        let mut env = BTreeMap::new();
        env.insert(
            PREPARED_CONTEXT_DIGEST_ENV.to_owned(),
            "sha256:abc123".to_owned(),
        );
        env.insert(
            PREPARED_APPROVAL_ACTOR_ENV.to_owned(),
            "test-operator".to_owned(),
        );
        env.insert(
            PREPARED_APPROVAL_MODE_ENV.to_owned(),
            "explicit_digest".to_owned(),
        );
        env.insert(
            PREPARED_APPROVAL_TIME_ENV.to_owned(),
            "2026-07-12T00:00:00Z".to_owned(),
        );
        let output = SkillOutput {
            status: InvocationStatus::Success,
            stdout: "{}".to_owned(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 0,
            metadata: BTreeMap::new(),
        };
        let projection = project_step_output(&output);
        let receipt = seal_step(
            StepSeal {
                graph_name: "prepared",
                step_id: "execute",
                attempt: 1,
                output: &output,
                projection: &projection,
                created_at: "2026-07-12T00:00:00Z",
                authority_grant_refs: Vec::new(),
                operator_refs: prepared_receipt_references(&env),
                closure: Some(StepSealClosure {
                    disposition: ClosureDisposition::Closed,
                    reason_code: "prepared_complete".to_owned(),
                    summary: "prepared run completed".to_owned(),
                }),
            },
            RuntimeReceiptSignaturePolicy::local_development(),
        )?;
        let refs = &receipt.acts[0].artifact_refs;
        assert!(refs.iter().any(|reference| {
            reference.reference_type == ReferenceType::Artifact
                && reference.uri.as_str().contains("operator_context:abc123")
        }));
        assert!(refs.iter().any(|reference| {
            reference.reference_type == ReferenceType::Decision
                && reference
                    .locator
                    .as_ref()
                    .is_some_and(|value| value.as_str().contains("test-operator"))
        }));
        assert!(
            receipt.seal.criteria[0]
                .verification_refs
                .iter()
                .any(|reference| reference.reference_type == ReferenceType::Decision)
        );
        assert!(prepared_receipt_references(&BTreeMap::new()).is_empty());
        Ok(())
    }

    #[test]
    fn prepared_skill_untrusted_env_cannot_forge_receipt_references() {
        let mut env = BTreeMap::from([
            (
                PREPARED_CONTEXT_DIGEST_ENV.to_owned(),
                "sha256:forged".to_owned(),
            ),
            (
                PREPARED_APPROVAL_ACTOR_ENV.to_owned(),
                "attacker".to_owned(),
            ),
            (PREPARED_APPROVAL_MODE_ENV.to_owned(), "forged".to_owned()),
            (
                PREPARED_APPROVAL_TIME_ENV.to_owned(),
                "2026-07-12T00:00:00Z".to_owned(),
            ),
        ]);
        strip_untrusted_prepared_env(&mut env);
        assert!(prepared_receipt_references(&env).is_empty());
        assert!(
            !env.keys()
                .any(|key| key.starts_with("RUNX_INTERNAL_PREPARED_"))
        );
    }

    #[cfg(feature = "cli-tool")]
    #[test]
    fn prepared_skill_unprepared_receipt_rejects_forged_internal_env() -> Result<(), Box<dyn Error>>
    {
        use crate::execution::orchestrator::LocalOrchestrator;

        let temp = tempdir()?;
        fs::write(temp.path().join("SKILL.md"), "# Unprepared")?;
        fs::write(
            temp.path().join("X.yaml"),
            "skill: unprepared\nrunners:\n  main:\n    default: true\n    type: cli-tool\n    command: \"true\"\n    args: []\n",
        )?;
        let mut request = request(temp.path());
        request.env.extend([
            (
                PREPARED_CONTEXT_DIGEST_ENV.to_owned(),
                "sha256:forged".to_owned(),
            ),
            (
                PREPARED_APPROVAL_ACTOR_ENV.to_owned(),
                "attacker".to_owned(),
            ),
            (PREPARED_APPROVAL_MODE_ENV.to_owned(), "forged".to_owned()),
            (
                PREPARED_APPROVAL_TIME_ENV.to_owned(),
                "2026-07-12T00:00:00Z".to_owned(),
            ),
        ]);
        let result = LocalOrchestrator::default().run_skill(&request)?;
        let output = serde_json::to_string(&result.output)?;
        assert!(!output.contains("operator_context"));
        assert!(!output.contains("attacker"));
        assert!(!output.contains("forged"));
        Ok(())
    }
}

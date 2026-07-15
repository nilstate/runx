use runx_contracts::{ExecutionSemantics, JsonObject, JsonValue};

use crate::{ValidationError, json_fields::JsonFieldReader};

mod catalog;
mod execution_semantics;
mod fixtures;
mod governance;
mod markdown;
mod runner_definition;
mod sandbox;
mod source;
mod types;

pub use catalog::{CatalogAudience, CatalogKind, CatalogMetadata, CatalogRole, CatalogVisibility};
pub use fixtures::{
    HarnessCallerFixture, HarnessExpectation, ReceiptExpectation, RunnerHarnessCase,
    RunnerHarnessManifest,
};
pub use governance::validate_skill_artifact_contract;
pub use markdown::parse_skill_markdown;
pub use source::validate_skill_source;
pub use types::{
    ActDeclaration, InputMode, RawSkillIr, SkillArtifactContract, SkillHttpSource,
    SkillIdempotencyPolicy, SkillInput, SkillMcpServer, SkillRetryPolicy, SkillRunnerDefinition,
    SkillSandbox, SkillSource, SourceKind, ValidateSkillMode, ValidateSkillOptions, ValidatedSkill,
};

pub(crate) use catalog::validate_catalog_metadata;
pub(crate) use fixtures::validate_harness_manifest;
pub(crate) use runner_definition::validate_runner_definition;

use execution_semantics::validate_execution_semantics;
use governance::validate_skill_governance;
use governance::{
    validate_allowed_tools, validate_artifact_contract, validate_idempotency, validate_inputs,
    validate_mutating, validate_retry,
};
use sandbox::validate_sandbox;
use source::default_agent_source;
use source::validate_source;
use source::validate_source_fields;

const FIELDS: JsonFieldReader = JsonFieldReader::new("skill");

pub(super) use crate::json_fields::{field_value, first_value, nested_value};

struct SkillGovernance {
    retry: Option<SkillRetryPolicy>,
    idempotency: Option<SkillIdempotencyPolicy>,
    mutating: Option<bool>,
    artifacts: Option<SkillArtifactContract>,
    allowed_tools: Option<Vec<String>>,
    execution: Option<ExecutionSemantics>,
}

pub fn validate_skill(raw: RawSkillIr) -> Result<ValidatedSkill, ValidationError> {
    validate_skill_with_options(raw, ValidateSkillOptions::default())
}

pub fn validate_skill_with_options(
    raw: RawSkillIr,
    options: ValidateSkillOptions,
) -> Result<ValidatedSkill, ValidationError> {
    let runx = validate_runx_metadata(raw.frontmatter.get("runx"), options.mode)?;
    let source = raw
        .frontmatter
        .get("source")
        .map(|value| FIELDS.optional_object(Some(value), "source"))
        .transpose()?
        .flatten()
        .unwrap_or_else(default_agent_source);
    let risk = raw.frontmatter.get("risk").cloned();
    let governance = validate_skill_governance(&raw, runx.as_ref(), risk.as_ref())?;
    let category = validate_portable_skill_category(&raw)?;
    let runx_category = validate_runx_skill_category(runx.as_ref())?;

    Ok(ValidatedSkill {
        name: FIELDS.required_string(raw.frontmatter.get("name"), "name")?,
        description: FIELDS.optional_string(raw.frontmatter.get("description"), "description")?,
        category,
        runx_category,
        body: raw.body.clone(),
        source: validate_source(&source, runx.as_ref())?,
        inputs: validate_inputs(
            FIELDS
                .optional_object(raw.frontmatter.get("inputs"), "inputs")?
                .unwrap_or_default(),
        )?,
        auth: raw.frontmatter.get("auth").cloned(),
        risk: risk.clone(),
        runtime: raw.frontmatter.get("runtime").cloned(),
        retry: governance.retry,
        idempotency: governance.idempotency,
        mutating: governance.mutating,
        artifacts: governance.artifacts,
        allowed_tools: governance.allowed_tools,
        execution: governance.execution,
        runx,
        raw,
    })
}

fn validate_portable_skill_category(raw: &RawSkillIr) -> Result<Option<String>, ValidationError> {
    Ok(normalize_optional_category(FIELDS.optional_string(
        raw.frontmatter.get("category"),
        "category",
    )?))
}

fn validate_runx_skill_category(
    runx: Option<&JsonObject>,
) -> Result<Option<String>, ValidationError> {
    Ok(normalize_optional_category(FIELDS.optional_string(
        field_value(runx, "category"),
        "runx.category",
    )?))
}

fn normalize_optional_category(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn validate_runx_metadata(
    value: Option<&JsonValue>,
    mode: ValidateSkillMode,
) -> Result<Option<JsonObject>, ValidationError> {
    match value {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Object(value)) => Ok(Some(value.clone())),
        Some(_) if mode == ValidateSkillMode::Lenient => Ok(None),
        Some(_) => Err(ValidationError::InvalidField {
            field: "runx".to_owned(),
            message: "runx must be an object when present.".to_owned(),
        }),
    }
}

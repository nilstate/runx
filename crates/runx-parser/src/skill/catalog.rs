// Module rationale: catalog enums, parsing, and cross-field capability validation form one public metadata contract.
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

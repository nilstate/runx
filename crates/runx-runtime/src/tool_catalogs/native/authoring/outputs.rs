use runx_contracts::{
    JsonObject, SkillApplyResult, SkillArchitecturePlan, SkillChangeBundle, SkillPackageMetrics,
};
use serde::{Deserialize, Serialize};

use crate::CapabilityOutput;

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct AuthoringInspectOutput {
    pub(super) authoring_context: AuthoringContext,
}

impl CapabilityOutput for AuthoringInspectOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct AuthoringContext {
    pub(super) repo_root: String,
    pub(super) target_dir: Option<String>,
    pub(super) target_exists: bool,
    pub(super) base_digest: String,
    pub(super) target_files: Vec<PackageFile>,
    pub(super) target_metrics: SkillPackageMetrics,
    pub(super) target_inspection: Option<JsonObject>,
    pub(super) catalog_root: String,
    pub(super) catalog_skills: Vec<CatalogItem>,
    pub(super) core_tools: Vec<CatalogItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct PackageFile {
    pub(super) path: String,
    pub(super) bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct CatalogItem {
    pub(super) name: String,
    pub(super) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    pub(super) path: String,
    pub(super) status: String,
    pub(super) scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) fixtures: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) harness_cases: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ValidateOutput {
    pub(super) skill_validation: SkillValidationPacket,
}

impl CapabilityOutput for ValidateOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct SkillValidationPacket {
    pub(super) schema: String,
    pub(super) requested_ref: String,
    pub(super) resolved_ref: String,
    pub(super) verdict: String,
    pub(super) inspect: JsonObject,
    pub(super) harness: JsonObject,
}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct PlanOutput {
    pub(super) architecture_plan: SkillArchitecturePlan,
}

impl CapabilityOutput for PlanOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct BindOutput {
    pub(super) change_bundle: SkillChangeBundle,
}

impl CapabilityOutput for BindOutput {}

#[derive(Clone, Debug, Serialize, Deserialize, runx_contracts::schema::RunxSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ApplyOutput {
    pub(super) apply_result: SkillApplyResult,
}

impl CapabilityOutput for ApplyOutput {}

use crate::RuntimeError;

pub(super) fn validate_context_manifest(
    step_id: &str,
    reference: &str,
    manifest: Option<&runx_parser::SkillRunnerManifest>,
) -> Result<(), RuntimeError> {
    validate_context_catalog(
        step_id,
        reference,
        manifest.and_then(|manifest| manifest.catalog.as_ref()),
    )
}

fn validate_context_catalog(
    step_id: &str,
    reference: &str,
    catalog: Option<&runx_parser::CatalogMetadata>,
) -> Result<(), RuntimeError> {
    let Some(catalog) = catalog else {
        return Ok(());
    };
    if matches!(
        catalog.role,
        runx_parser::CatalogRole::GraphStage
            | runx_parser::CatalogRole::RuntimePath
            | runx_parser::CatalogRole::HarnessFixture
    ) {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step_id.to_owned(),
            reason: format!(
                "context skill '{reference}' has catalog.role={}, which is not eligible for context_skills",
                catalog.role.as_str()
            ),
        });
    }
    if catalog.visibility == runx_parser::CatalogVisibility::Internal
        && catalog.role != runx_parser::CatalogRole::Context
    {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step_id.to_owned(),
            reason: format!(
                "context skill '{reference}' is internal and must declare catalog.role=context to be used as agent context"
            ),
        });
    }
    Ok(())
}

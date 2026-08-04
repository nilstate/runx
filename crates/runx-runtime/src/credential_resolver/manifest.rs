use std::path::Path;

use runx_parser::{SkillRunnerDefinition, SkillRunnerManifest};

use super::{
    SkillCredentialContext, SkillCredentialError, SkillCredentialRequest, resolve_skill_credential,
};
use crate::services::WorkspaceEnv;

pub fn resolve_skill_credential_for_path(
    skill_path: &Path,
    selected_runner: Option<&str>,
    explicit_profile: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<Option<SkillCredentialContext>, SkillCredentialError> {
    let loaded = crate::load_validated_skill_package(skill_path)
        .map_err(|error| SkillCredentialError::InvalidSkill(error.to_string()))?;
    let Some(manifest) = loaded.manifest().cloned() else {
        if explicit_profile.is_none() {
            return Ok(None);
        }
        return Err(SkillCredentialError::InvalidSkill(
            "--profile requires a skill package with X.yaml runners".to_owned(),
        ));
    };
    credential_context_for_runner(
        &loaded.directory,
        &manifest,
        selected_runner,
        explicit_profile,
        workspace,
    )
}

fn credential_context_for_runner(
    skill_dir: &Path,
    manifest: &SkillRunnerManifest,
    selected_runner: Option<&str>,
    explicit_profile: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<Option<SkillCredentialContext>, SkillCredentialError> {
    let runner = selected_runner_definition(manifest, selected_runner)?;
    let Some(requirement_name) = runner.credential.as_ref() else {
        if explicit_profile.is_some() {
            return Err(SkillCredentialError::InvalidSkill(
                "--profile is only valid when the selected runner declares a credential".to_owned(),
            ));
        }
        return Ok(None);
    };
    let requirement = manifest
        .credentials
        .get(requirement_name)
        .cloned()
        .ok_or_else(|| {
            SkillCredentialError::InvalidSkill(format!(
                "runner credential '{requirement_name}' is not declared"
            ))
        })?;
    let request = SkillCredentialRequest {
        skill_name: manifest.skill.clone().unwrap_or_else(|| {
            skill_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("skill")
                .to_owned()
        }),
        requirement_name: requirement_name.clone(),
        requirement,
        scopes: runner.declared_scopes(),
        explicit_profile: explicit_profile.map(str::to_owned),
    };
    let resolution = resolve_skill_credential(&request, workspace)?;
    Ok(Some(SkillCredentialContext {
        request,
        resolution,
    }))
}

fn selected_runner_definition<'a>(
    manifest: &'a SkillRunnerManifest,
    selected: Option<&str>,
) -> Result<&'a SkillRunnerDefinition, SkillCredentialError> {
    if let Some(selected) = selected {
        return manifest.runners.get(selected).ok_or_else(|| {
            SkillCredentialError::InvalidSkill(format!("skill has no runner '{selected}'"))
        });
    }
    let mut defaults = manifest.runners.values().filter(|runner| runner.default);
    match (defaults.next(), defaults.next()) {
        (Some(runner), None) => Ok(runner),
        (None, _) if manifest.runners.len() == 1 => {
            manifest.runners.values().next().ok_or_else(|| {
                SkillCredentialError::InvalidSkill("skill declares no runners".into())
            })
        }
        (None, _) => Err(SkillCredentialError::InvalidSkill(
            "skill manifest has no default runner".to_owned(),
        )),
        (Some(_), Some(_)) => Err(SkillCredentialError::InvalidSkill(
            "skill manifest declares multiple default runners".to_owned(),
        )),
    }
}

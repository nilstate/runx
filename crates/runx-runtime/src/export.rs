use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use runx_parser::{
    CatalogVisibility, SkillInput, SkillPackageSource, SkillRunnerManifest, ValidatedSkill,
    ValidatedSkillPackage, validate_skill_package,
};

mod discovery;
mod resolve;

use discovery::{canonicalize, discover_skill_paths, display_path};
use resolve::resolve_skill_ref;

#[derive(Clone, Debug, PartialEq)]
pub struct RunxExportSkill {
    pub name: String,
    pub description: String,
    pub runners: Vec<RunxExportRunner>,
    pub abs_dir: PathBuf,
    pub manual_markdown: String,
    pub manual_digest: String,
    pub package_digest: String,
    pub mode: RunxExportMode,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunxExportMode {
    Delegated,
    NativeInstructions,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunxExportRunner {
    /// `None` is the unnamed SKILL.md execution front used by packages without
    /// X.yaml. Named X.yaml runners are always explicit in generated commands.
    pub name: Option<String>,
    pub default: bool,
    pub inputs: BTreeMap<String, SkillInput>,
    pub examples: Vec<runx_contracts::JsonObject>,
}

#[derive(Clone, Debug)]
pub struct RunxExportLoadOptions<'a> {
    pub root: &'a Path,
    pub refs: &'a [String],
    pub official_roots: Vec<PathBuf>,
}

#[derive(Debug)]
pub enum RunxExportLoadError {
    InvalidArgs(String),
    Io {
        context: String,
        source: std::io::Error,
    },
    Parse(String),
}

impl std::fmt::Display for RunxExportLoadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidArgs(message) | Self::Parse(message) => formatter.write_str(message),
            Self::Io { context, source } => write!(formatter, "{context}: {source}"),
        }
    }
}

impl std::error::Error for RunxExportLoadError {}

pub fn load_export_skills(
    root: &Path,
    refs: &[String],
) -> Result<Vec<RunxExportSkill>, RunxExportLoadError> {
    load_export_skills_with_options(RunxExportLoadOptions {
        root,
        refs,
        official_roots: Vec::new(),
    })
}

pub fn load_export_skills_with_options(
    options: RunxExportLoadOptions<'_>,
) -> Result<Vec<RunxExportSkill>, RunxExportLoadError> {
    let explicit = !options.refs.is_empty();
    let paths = if explicit {
        options
            .refs
            .iter()
            .map(|reference| resolve_skill_ref(options.root, reference, &options.official_roots))
            .collect::<Result<Vec<_>, _>>()?
    } else {
        discover_skill_paths(options.root)?
    };

    let mut skills = Vec::new();
    for skill_dir in paths {
        let (directory, package, manifest) = load_export_package(options.root, &skill_dir)?;
        if !explicit && manifest_visibility(&manifest) == Some(CatalogVisibility::Internal) {
            continue;
        }
        skills.push(export_skill(directory, package, manifest)?);
    }
    validate_unique_export_names(&mut skills)?;
    Ok(skills)
}

fn validate_unique_export_names(skills: &mut [RunxExportSkill]) -> Result<(), RunxExportLoadError> {
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    for pair in skills.windows(2) {
        if pair[0].name == pair[1].name {
            return Err(RunxExportLoadError::InvalidArgs(format!(
                "multiple skills normalize to the export name {:?}",
                pair[0].name
            )));
        }
    }
    Ok(())
}

fn export_skill(
    directory: PathBuf,
    package: ValidatedSkillPackage,
    manifest: Option<SkillRunnerManifest>,
) -> Result<RunxExportSkill, RunxExportLoadError> {
    let skill = package.skill;
    let mode = export_mode(&skill, manifest.as_ref());
    let runners = export_runners(&skill, manifest.as_ref());
    for runner in &runners {
        validate_export_skill_inputs(&runner.inputs)?;
    }
    Ok(RunxExportSkill {
        name: export_skill_name(&skill.name)?,
        description: skill
            .description
            .unwrap_or_else(|| "Run this skill through runx governance.".to_owned()),
        runners,
        abs_dir: directory,
        manual_markdown: package.manual_markdown,
        manual_digest: package.manual_digest,
        package_digest: package.package_digest,
        mode,
    })
}

fn load_export_package(
    workspace_root: &Path,
    skill_dir: &Path,
) -> Result<(PathBuf, ValidatedSkillPackage, Option<SkillRunnerManifest>), RunxExportLoadError> {
    let workspace_root = canonicalize(workspace_root, "canonicalizing export workspace")?;
    let is_workspace_manual = skill_dir == workspace_root
        && workspace_root.join("skills").is_dir()
        && !workspace_root.join("X.yaml").is_file();
    if is_workspace_manual {
        let manual_path = workspace_root.join("SKILL.md");
        let manual =
            fs::read_to_string(&manual_path).map_err(|source| RunxExportLoadError::Io {
                context: format!(
                    "reading workspace skill manual {}",
                    display_path(&manual_path)
                ),
                source,
            })?;
        let package = validate_skill_package(SkillPackageSource::from_documents(manual, None))
            .map_err(|error| RunxExportLoadError::Parse(error.to_string()))?;
        return Ok((skill_dir.to_path_buf(), package, None));
    }

    let loaded = crate::load_validated_skill_package(skill_dir)
        .map_err(|error| RunxExportLoadError::Parse(error.to_string()))?;
    let manifest = loaded.manifest().cloned();
    Ok((loaded.directory, loaded.package, manifest))
}

fn export_mode(skill: &ValidatedSkill, manifest: Option<&SkillRunnerManifest>) -> RunxExportMode {
    let is_runtime_guide = skill.name == "runx" && manifest.is_none();
    if is_runtime_guide {
        return RunxExportMode::NativeInstructions;
    }
    RunxExportMode::Delegated
}

fn export_runners(
    skill: &ValidatedSkill,
    manifest: Option<&SkillRunnerManifest>,
) -> Vec<RunxExportRunner> {
    let Some(manifest) = manifest else {
        return vec![RunxExportRunner {
            name: None,
            default: true,
            inputs: skill.inputs.clone(),
            examples: Vec::new(),
        }];
    };
    manifest
        .runners
        .values()
        .map(|runner| RunxExportRunner {
            name: Some(runner.name.clone()),
            default: runner.default || manifest.runners.len() == 1,
            inputs: runner.inputs.clone(),
            examples: runner.examples.clone(),
        })
        .collect()
}

fn export_skill_name(name: &str) -> Result<String, RunxExportLoadError> {
    if name.contains('\\') {
        return Err(RunxExportLoadError::InvalidArgs(format!(
            "skill name {name:?} cannot be exported because it is not a safe path segment"
        )));
    }
    let segments = name.split('/').collect::<Vec<_>>();
    if segments.iter().any(|segment| {
        segment.is_empty()
            || matches!(*segment, "." | "..")
            || segment.starts_with('-')
            || segment.ends_with('-')
            || !segment.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })
    }) {
        return Err(RunxExportLoadError::InvalidArgs(format!(
            "skill name {name:?} cannot be exported because it cannot be normalized to a safe name"
        )));
    }
    Ok(segments.join("-"))
}

fn validate_export_skill_inputs(
    inputs: &BTreeMap<String, runx_parser::SkillInput>,
) -> Result<(), RunxExportLoadError> {
    for name in inputs.keys() {
        if !is_export_input_name(name) || is_reserved_skill_flag(name) {
            return Err(RunxExportLoadError::InvalidArgs(format!(
                "skill input {name:?} cannot be exported because it is not a safe runx skill flag"
            )));
        }
    }
    Ok(())
}

fn is_export_input_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn is_reserved_skill_flag(name: &str) -> bool {
    matches!(
        name,
        "answers"
            | "credential"
            | "json"
            | "non_interactive"
            | "receipt_dir"
            | "run_id"
            | "secret_env"
    )
}

fn manifest_visibility(
    manifest: &Option<runx_parser::SkillRunnerManifest>,
) -> Option<CatalogVisibility> {
    manifest
        .as_ref()
        .and_then(|manifest| manifest.catalog.as_ref())
        .map(|catalog| catalog.visibility)
}
#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use std::fs;

    use super::{RunxExportMode, load_export_skills};

    #[test]
    fn exports_workspace_manual_without_admitting_repository_as_its_package() {
        let temp = tempfile::tempdir().expect("temporary workspace");
        let root = temp.path();
        let child = root.join("skills/demo");
        fs::create_dir_all(&child).expect("skill directory");
        fs::create_dir_all(root.join("unrelated")).expect("unrelated directory");
        fs::write(
            root.join("SKILL.md"),
            "---\nname: runx\ndescription: Runx runtime guide.\n---\n\n# Runx\n",
        )
        .expect("root manual");
        fs::write(
            child.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo skill.\n---\n\n# Demo\n",
        )
        .expect("child manual");
        fs::write(
            child.join("X.yaml"),
            "skill: demo\nrunners:\n  default:\n    default: true\n    type: agent\n",
        )
        .expect("child manifest");
        fs::write(root.join("unrelated/X.yaml"), "not: [valid").expect("unrelated repository file");

        let skills = load_export_skills(root, &[]).expect("export skills");

        assert_eq!(
            skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            vec!["demo", "runx"]
        );
        let runx = skills
            .iter()
            .find(|skill| skill.name == "runx")
            .expect("runx manual");
        assert_eq!(runx.mode, RunxExportMode::NativeInstructions);
    }
}

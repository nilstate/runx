use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use runx_parser::{
    CatalogVisibility, SkillInput, SkillRunnerDefinition, SkillRunnerManifest, ValidatedSkill,
    parse_runner_manifest_yaml, parse_skill_markdown, validate_runner_manifest, validate_skill,
};

mod resolve;

use resolve::resolve_skill_ref;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunxExportSkill {
    pub name: String,
    pub description: String,
    pub inputs: BTreeMap<String, RunxExportSkillInput>,
    pub abs_dir: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunxExportSkillInput {
    pub required: bool,
    pub description: Option<String>,
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
        let manifest = read_optional_runner_manifest(&skill_dir)?;
        if !explicit && manifest_visibility(&manifest) == Some(CatalogVisibility::Internal) {
            continue;
        }
        let skill = read_validated_skill(&skill_dir)?;
        let inputs = export_skill_inputs(&skill, manifest.as_ref());
        let export_name = export_skill_name(&skill.name)?;
        validate_export_skill_inputs(&inputs)?;
        skills.push(RunxExportSkill {
            name: export_name,
            description: skill
                .description
                .unwrap_or_else(|| "Run this skill through runx governance.".to_owned()),
            inputs: inputs
                .into_iter()
                .map(|(name, input)| {
                    (
                        name,
                        RunxExportSkillInput {
                            required: input.required,
                            description: input.description,
                        },
                    )
                })
                .collect(),
            abs_dir: skill_dir,
        });
    }
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    for pair in skills.windows(2) {
        if pair[0].name == pair[1].name {
            return Err(RunxExportLoadError::InvalidArgs(format!(
                "multiple skills normalize to the export name {:?}",
                pair[0].name
            )));
        }
    }
    Ok(skills)
}

fn export_skill_inputs(
    skill: &ValidatedSkill,
    manifest: Option<&SkillRunnerManifest>,
) -> BTreeMap<String, SkillInput> {
    if !skill.inputs.is_empty() {
        return skill.inputs.clone();
    }
    default_runner(manifest)
        .map(|runner| runner.inputs.clone())
        .unwrap_or_default()
}

fn default_runner(manifest: Option<&SkillRunnerManifest>) -> Option<&SkillRunnerDefinition> {
    let manifest = manifest?;
    manifest
        .runners
        .values()
        .find(|runner| runner.default)
        .or_else(|| {
            (manifest.runners.len() == 1)
                .then(|| manifest.runners.values().next())
                .flatten()
        })
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

fn discover_skill_paths(root: &Path) -> Result<Vec<PathBuf>, RunxExportLoadError> {
    let mut paths = Vec::new();
    if root.join("SKILL.md").exists() {
        paths.push(canonicalize(root, "canonicalizing root skill")?);
    }
    let skills_root = root.join("skills");
    discover_skill_paths_below(&skills_root, &mut paths)?;
    paths.sort();
    Ok(paths)
}

fn discover_skill_paths_below(
    directory: &Path,
    paths: &mut Vec<PathBuf>,
) -> Result<(), RunxExportLoadError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(RunxExportLoadError::Io {
                context: format!("reading {}", display_path(directory)),
                source,
            });
        }
    };
    let mut directories = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| RunxExportLoadError::Io {
            context: format!("reading {}", display_path(directory)),
            source,
        })?;
        let file_type = entry
            .file_type()
            .map_err(|source| RunxExportLoadError::Io {
                context: format!("reading file type {}", display_path(&entry.path())),
                source,
            })?;
        if file_type.is_dir()
            && !matches!(
                entry.file_name().to_string_lossy().as_ref(),
                ".git" | "node_modules" | "target"
            )
        {
            directories.push(entry.path());
        }
    }
    directories.sort();
    for candidate in directories {
        if candidate.join("SKILL.md").exists() {
            paths.push(canonicalize(&candidate, "canonicalizing skill directory")?);
        }
        discover_skill_paths_below(&candidate, paths)?;
    }
    Ok(())
}

fn read_validated_skill(
    skill_dir: &Path,
) -> Result<runx_parser::ValidatedSkill, RunxExportLoadError> {
    let path = skill_dir.join("SKILL.md");
    let source = read_to_string(&path)?;
    let raw = parse_skill_markdown(&source).map_err(|error| {
        RunxExportLoadError::Parse(format!("parsing {}: {error}", display_path(&path)))
    })?;
    validate_skill(raw).map_err(|error| {
        RunxExportLoadError::Parse(format!("validating {}: {error}", display_path(&path)))
    })
}

fn read_optional_runner_manifest(
    skill_dir: &Path,
) -> Result<Option<runx_parser::SkillRunnerManifest>, RunxExportLoadError> {
    let path = skill_dir.join("X.yaml");
    if !path.exists() {
        return Ok(None);
    }
    let source = read_to_string(&path)?;
    let raw = parse_runner_manifest_yaml(&source).map_err(|error| {
        RunxExportLoadError::Parse(format!("parsing {}: {error}", display_path(&path)))
    })?;
    validate_runner_manifest(raw).map(Some).map_err(|error| {
        RunxExportLoadError::Parse(format!("validating {}: {error}", display_path(&path)))
    })
}

fn manifest_visibility(
    manifest: &Option<runx_parser::SkillRunnerManifest>,
) -> Option<CatalogVisibility> {
    manifest
        .as_ref()
        .and_then(|manifest| manifest.catalog.as_ref())
        .map(|catalog| catalog.visibility)
}

fn canonicalize(path: &Path, context: &str) -> Result<PathBuf, RunxExportLoadError> {
    fs::canonicalize(path).map_err(|source| RunxExportLoadError::Io {
        context: format!("{context} {}", display_path(path)),
        source,
    })
}

fn read_to_string(path: &Path) -> Result<String, RunxExportLoadError> {
    fs::read_to_string(path).map_err(|source| RunxExportLoadError::Io {
        context: format!("reading {}", display_path(path)),
        source,
    })
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

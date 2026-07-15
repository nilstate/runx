use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path};

use runx_contracts::{ContextEntry, JsonObject, sha256_prefixed};

use crate::RuntimeError;
use crate::registry::{RegistryResolveOptions, create_file_registry_store, resolve_registry_skill};

mod catalog;
mod entry;

use catalog::{validate_local_context_manifest, validate_registry_context_profile};
use entry::{SkillContextEntryInput, insert_string, skill_context_entry};

const MAX_CONTEXT_SKILLS: usize = 12;
const MAX_CONTEXT_SKILL_BYTES: usize = 64 * 1024;
const MAX_CONTEXT_SKILLS_TOTAL_BYTES: usize = 256 * 1024;

pub(crate) fn load_context_skills(
    step_id: &str,
    graph_dir: &Path,
    refs: &[String],
    env: &BTreeMap<String, String>,
    created_at: &str,
) -> Result<Vec<ContextEntry>, RuntimeError> {
    if refs.len() > MAX_CONTEXT_SKILLS {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step_id.to_owned(),
            reason: format!(
                "context_skills declares {} skills; the maximum is {MAX_CONTEXT_SKILLS}",
                refs.len()
            ),
        });
    }

    let mut seen = BTreeSet::new();
    let mut total_bytes = 0usize;
    refs.iter()
        .map(|reference| {
            if !seen.insert(reference.as_str()) {
                return Err(RuntimeError::InvalidRunStep {
                    step_id: step_id.to_owned(),
                    reason: format!("context skill '{reference}' is declared more than once"),
                });
            }
            let entry = load_context_skill(step_id, graph_dir, reference, env, created_at)?;
            total_bytes += usize::try_from(entry.meta.size_bytes).unwrap_or(usize::MAX);
            if total_bytes > MAX_CONTEXT_SKILLS_TOTAL_BYTES {
                return Err(RuntimeError::InvalidRunStep {
                    step_id: step_id.to_owned(),
                    reason: format!(
                        "context_skills resolved to more than {MAX_CONTEXT_SKILLS_TOTAL_BYTES} bytes"
                    ),
                });
            }
            Ok(entry)
        })
        .collect()
}

fn load_context_skill(
    step_id: &str,
    graph_dir: &Path,
    reference: &str,
    env: &BTreeMap<String, String>,
    created_at: &str,
) -> Result<ContextEntry, RuntimeError> {
    if is_registry_ref(reference) {
        return load_registry_context_skill(step_id, reference, env, created_at);
    }
    load_local_context_skill(step_id, graph_dir, reference, env, created_at)
}

fn load_local_context_skill(
    step_id: &str,
    graph_dir: &Path,
    reference: &str,
    env: &BTreeMap<String, String>,
    created_at: &str,
) -> Result<ContextEntry, RuntimeError> {
    validate_local_context_ref(step_id, reference)?;
    let skill_dir = graph_dir.join(reference);
    let skill_path = skill_dir.join("SKILL.md");
    let metadata = fs::metadata(&skill_path)
        .map_err(|source| RuntimeError::io(format!("reading {}", skill_path.display()), source))?;
    validate_context_skill_size(
        step_id,
        reference,
        usize::try_from(metadata.len()).unwrap_or(usize::MAX),
    )?;
    let markdown = fs::read_to_string(&skill_path)
        .map_err(|source| RuntimeError::io(format!("reading {}", skill_path.display()), source))?;
    let raw = runx_parser::parse_skill_markdown(&markdown)?;
    let skill = runx_parser::validate_skill(raw).map_err(RuntimeError::from)?;
    validate_local_context_manifest(step_id, reference, &skill_dir)?;
    let digest = sha256_prefixed(markdown.as_bytes());
    let mut data = JsonObject::new();
    insert_string(&mut data, "ref", reference);
    insert_string(&mut data, "source", "local-path");
    insert_string(&mut data, "content_kind", "skill-markdown");
    insert_string(&mut data, "security_boundary", "untrusted-agent-context");
    insert_string(&mut data, "name", &skill.name);
    let skill_path_display = skill_path.to_string_lossy();
    insert_string(&mut data, "path", skill_path_display.as_ref());
    insert_string(&mut data, "sha256", &digest);
    insert_string(&mut data, "content", &markdown);
    let entry = skill_context_entry(SkillContextEntryInput {
        step_id,
        reference,
        env,
        created_at,
        digest: &digest,
        size_bytes: markdown.len() as u64,
        data,
    })?;
    super::prepared_skill::verify_prepared_artifact_at_use(env, &skill_path)?;
    Ok(entry)
}

fn load_registry_context_skill(
    step_id: &str,
    reference: &str,
    env: &BTreeMap<String, String>,
    created_at: &str,
) -> Result<ContextEntry, RuntimeError> {
    let Some(registry_dir) = env.get("RUNX_REGISTRY_DIR") else {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step_id.to_owned(),
            reason: format!(
                "context skill '{reference}' is a registry ref, but RUNX_REGISTRY_DIR is not configured"
            ),
        });
    };
    let store = create_file_registry_store(registry_dir);
    let registry_url = env.get("RUNX_REGISTRY_URL").cloned();
    let resolution = resolve_registry_skill(
        &store,
        reference,
        RegistryResolveOptions {
            version: None,
            registry_url,
        },
    )
    .map_err(|error| RuntimeError::InvalidRunStep {
        step_id: step_id.to_owned(),
        reason: format!("context skill registry ref '{reference}' could not be resolved: {error}"),
    })?
    .ok_or_else(|| RuntimeError::InvalidRunStep {
        step_id: step_id.to_owned(),
        reason: format!("context skill registry ref '{reference}' was not found"),
    })?;

    let digest = prefixed_digest(&resolution.digest);
    validate_context_skill_size(step_id, reference, resolution.markdown.len())?;
    validate_registry_context_profile(step_id, reference, resolution.profile_document.as_deref())?;
    let mut data = JsonObject::new();
    insert_string(&mut data, "ref", reference);
    insert_string(&mut data, "source", &resolution.source);
    insert_string(&mut data, "content_kind", "skill-markdown");
    insert_string(&mut data, "security_boundary", "untrusted-agent-context");
    insert_string(&mut data, "source_label", &resolution.source_label);
    insert_string(&mut data, "skill_id", &resolution.skill_id);
    insert_string(&mut data, "name", &resolution.name);
    insert_string(&mut data, "version", &resolution.version);
    insert_string(&mut data, "sha256", &digest);
    insert_string(&mut data, "content", &resolution.markdown);
    skill_context_entry(SkillContextEntryInput {
        step_id,
        reference,
        env,
        created_at,
        digest: &digest,
        size_bytes: resolution.markdown.len() as u64,
        data,
    })
}

fn validate_local_context_ref(step_id: &str, reference: &str) -> Result<(), RuntimeError> {
    if reference.trim().is_empty() {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step_id.to_owned(),
            reason: "context skill ref must not be empty".to_owned(),
        });
    }
    let path = Path::new(reference);
    if path.is_absolute() {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step_id.to_owned(),
            reason: format!("context skill '{reference}' must be a relative path or registry ref"),
        });
    }
    for component in path.components() {
        match component {
            Component::ParentDir => {
                return Err(RuntimeError::InvalidRunStep {
                    step_id: step_id.to_owned(),
                    reason: format!("context skill '{reference}' must not contain '..'"),
                });
            }
            Component::Normal(name) if name == "graph" => {
                return Err(RuntimeError::InvalidRunStep {
                    step_id: step_id.to_owned(),
                    reason: format!("context skill '{reference}' must not target graph stages"),
                });
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(RuntimeError::InvalidRunStep {
                    step_id: step_id.to_owned(),
                    reason: format!("context skill '{reference}' must be a relative path"),
                });
            }
            Component::CurDir | Component::Normal(_) => {}
        }
    }
    Ok(())
}

fn is_registry_ref(reference: &str) -> bool {
    reference.starts_with("registry:")
        || reference.starts_with("runx-registry:")
        || reference.starts_with("runx://skill/")
}

fn validate_context_skill_size(
    step_id: &str,
    reference: &str,
    size_bytes: usize,
) -> Result<(), RuntimeError> {
    if size_bytes <= MAX_CONTEXT_SKILL_BYTES {
        return Ok(());
    }
    Err(RuntimeError::InvalidRunStep {
        step_id: step_id.to_owned(),
        reason: format!(
            "context skill '{reference}' is {size_bytes} bytes; the maximum is {MAX_CONTEXT_SKILL_BYTES}"
        ),
    })
}

fn prefixed_digest(digest: &str) -> String {
    if digest.starts_with("sha256:") {
        digest.to_owned()
    } else {
        format!("sha256:{digest}")
    }
}

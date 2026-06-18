use std::path::Path;

use runx_contracts::sha256_hex;

use super::types::RegistryPackageFile;

pub(crate) fn normalize_registry_package_files(
    files: Vec<RegistryPackageFile>,
) -> Result<Vec<RegistryPackageFile>, String> {
    let mut normalized = Vec::with_capacity(files.len());
    for file in files {
        validate_registry_package_file_path(&file.path)?;
        if normalized
            .iter()
            .any(|entry: &RegistryPackageFile| entry.path == file.path)
        {
            return Err(format!("duplicate package file '{}'", file.path));
        }
        normalized.push(file);
    }
    normalized.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(normalized)
}

pub(crate) fn registry_package_digest(files: &[RegistryPackageFile]) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let mut sorted = files.to_vec();
    sorted.sort_by(|left, right| left.path.cmp(&right.path));
    let mut canonical = String::from("{\"files\":[");
    for (index, file) in sorted.iter().enumerate() {
        if index > 0 {
            canonical.push(',');
        }
        canonical.push_str("{\"content\":");
        canonical.push_str(&serde_json::to_string(&file.content).expect("string serializes"));
        canonical.push_str(",\"path\":");
        canonical.push_str(&serde_json::to_string(&file.path).expect("string serializes"));
        canonical.push('}');
    }
    canonical.push_str("]}");
    Some(sha256_hex(canonical.as_bytes()))
}

pub(crate) fn validate_registry_package_file_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("package file path cannot be empty".to_owned());
    }
    if path.contains('\\') {
        return Err(format!("package file path '{path}' must use / separators"));
    }
    let parsed = Path::new(path);
    if parsed.is_absolute() {
        return Err(format!("package file path '{path}' must be relative"));
    }
    let mut depth = 0usize;
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment.starts_with('.') {
            return Err(format!(
                "package file path '{path}' contains an unsafe segment"
            ));
        }
        depth += 1;
    }
    if depth == 1 && matches!(path, "SKILL.md" | "X.yaml") {
        return Err(format!("{path} is stored in its dedicated registry field"));
    }
    Ok(())
}

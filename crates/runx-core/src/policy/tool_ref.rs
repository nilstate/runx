#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolRefAdmission {
    pub allowed: bool,
    pub reason: &'static str,
}

impl ToolRefAdmission {
    #[must_use]
    pub const fn allow() -> Self {
        Self {
            allowed: true,
            reason: "tool ref admitted",
        }
    }

    #[must_use]
    pub const fn deny(reason: &'static str) -> Self {
        Self {
            allowed: false,
            reason,
        }
    }
}

#[must_use]
pub fn admit_agent_tool_ref(value: &str) -> ToolRefAdmission {
    let value = value.trim();
    if value.is_empty() {
        return ToolRefAdmission::deny("tool ref must not be empty");
    }
    if value.starts_with('/') || value.starts_with('\\') {
        return ToolRefAdmission::deny("tool ref must not be an absolute path");
    }
    if value.contains('/') || value.contains('\\') || value.contains("..") {
        return ToolRefAdmission::deny("tool ref must not contain path traversal or separators");
    }
    let lower = value.to_ascii_lowercase();
    if lower == "manifest.json"
        || lower.ends_with(".json")
        || lower.ends_with(".yaml")
        || lower.ends_with(".yml")
        || lower.ends_with(".toml")
    {
        return ToolRefAdmission::deny("tool ref must not look like a manifest or data file path");
    }
    let segments = value.split('.').collect::<Vec<_>>();
    if segments.len() < 2 {
        return ToolRefAdmission::deny("tool ref must include a namespace, for example fs.read");
    }
    if segments
        .iter()
        .any(|segment| segment.is_empty() || !segment.bytes().all(is_catalog_ref_byte))
    {
        return ToolRefAdmission::deny(
            "tool ref segments must contain only letters, numbers, hyphens, or underscores",
        );
    }
    ToolRefAdmission::allow()
}

const fn is_catalog_ref_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

#[cfg(test)]
mod tests {
    use super::admit_agent_tool_ref;

    #[test]
    fn admits_catalog_style_refs() {
        for value in [
            "fs.read",
            "git.current_branch",
            "git.diff_name_only",
            "command.execute",
            "cli.capture_help",
            "namespace.tool-name",
        ] {
            let admission = admit_agent_tool_ref(value);
            assert!(admission.allowed, "{value}: {}", admission.reason);
        }
    }

    #[test]
    fn rejects_path_and_manifest_like_refs() {
        for value in [
            "",
            "read",
            "/tmp/tool/manifest.json",
            "../tool/manifest.json",
            "tools/read",
            r"tools\read",
            "manifest.json",
            "fs.json",
            "fs..read",
            "fs.read;rm",
            "fs.read all",
        ] {
            let admission = admit_agent_tool_ref(value);
            assert!(!admission.allowed, "{value} unexpectedly admitted");
        }
    }
}

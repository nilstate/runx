use std::path::Path;

pub(crate) const RUNX_TOOL_ROOTS_ENV: &str = "RUNX_TOOL_ROOTS";

pub(crate) fn inferred_tool_roots(skill_dir: &Path) -> Option<String> {
    let mut roots = Vec::new();
    let bundled_tools = skill_dir.join("tools");
    if bundled_tools.is_dir() {
        roots.push(bundled_tools);
    }
    if let Some(root) = skill_dir
        .parent()
        .filter(|parent| parent.file_name().and_then(|name| name.to_str()) == Some("skills"))
        .and_then(Path::parent)
    {
        let tools_root = root.join("tools");
        if tools_root.is_dir() {
            roots.push(tools_root);
        }
    }
    if roots.is_empty() {
        return None;
    }
    std::env::join_paths(roots)
        .ok()
        .map(|value| value.to_string_lossy().into_owned())
}

use std::fs;

use crate::support::{isolated_runx_command_with_inherited_cwd, temp_root};

#[test]
fn list_discovers_namespaced_repo_skills() -> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("runx-list-namespaced-skills");
    let skill = root.join("skills/acme/triage");
    fs::create_dir_all(&skill)?;
    fs::write(
        skill.join("X.yaml"),
        "skill: acme/triage\nversion: 1.0.0\nrunners:\n  triage:\n    default: true\n    type: agent-task\n    agent: reviewer\n    task: triage\n",
    )?;

    let output = isolated_runx_command_with_inherited_cwd("list-namespaced")
        .current_dir(&root)
        .args(["list", "skills", "--ok-only", "--json"])
        .output()?;

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = serde_json::from_slice::<serde_json::Value>(&output.stdout)?;
    let items = report["items"].as_array().ok_or("items must be an array")?;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["name"], "acme/triage");
    assert_eq!(items[0]["path"], "skills/acme/triage/X.yaml");

    fs::remove_dir_all(root)?;
    Ok(())
}

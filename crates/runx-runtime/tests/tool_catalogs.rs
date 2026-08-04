use std::fs;
use std::path::{Path, PathBuf};

use runx_contracts::tools::{ToolBuildStatus, ToolInspectOrigin};
use runx_runtime::{
    ToolBuildOptions, ToolInspectOptions, ToolSearchOptions, build_tool_catalogs, inspect_tool,
    search_tools,
};

#[test]
fn tool_catalogs_build_minimal_manifest() -> Result<(), Box<dyn std::error::Error>> {
    let temp_root = copy_minimal_tool_fixture("build_minimal_manifest")?;
    let tool_dir = temp_root.join("tools/fixture/minimal");
    let manifest_path = tool_dir.join("manifest.json");
    let manifest_before = fs::read(&manifest_path)?;

    let report = build_tool_catalogs(&ToolBuildOptions {
        root: temp_root.clone(),
        tool_path: Some(tool_dir),
        all: false,
    })?;

    assert_eq!(report.status, ToolBuildStatus::Success);
    assert_eq!(report.built.len(), 1);
    assert!(report.errors.is_empty());

    assert_eq!(fs::read(&manifest_path)?, manifest_before);
    assert!(report.built[0].source_hash.starts_with("sha256:"));
    assert!(report.built[0].schema_hash.starts_with("sha256:"));
    Ok(())
}

#[test]
fn tool_catalogs_reject_node_entrypoints_that_import_typescript()
-> Result<(), Box<dyn std::error::Error>> {
    let temp_root = copy_minimal_tool_fixture("reject_node_typescript")?;
    let tool_dir = temp_root.join("tools/fixture/minimal");
    fs::create_dir_all(tool_dir.join("src"))?;
    fs::write(tool_dir.join("run.mjs"), "import './src/index.ts';\n")?;
    fs::write(tool_dir.join("src/index.ts"), "export const ok = true;\n")?;

    let report = build_tool_catalogs(&ToolBuildOptions {
        root: temp_root,
        tool_path: Some(tool_dir),
        all: false,
    })?;

    assert_eq!(report.status, ToolBuildStatus::Failure);
    assert_eq!(report.errors.len(), 1);
    assert!(report.errors[0].contains("imports uncompiled TypeScript"));
    Ok(())
}

#[test]
fn tool_catalogs_search_fixture_mcp_requires_enablement() {
    let disabled = search_tools(&ToolSearchOptions {
        query: "echo".to_owned(),
        source: None,
        limit: 20,
        fixture_catalog_enabled: false,
    });
    assert!(disabled.results.is_empty());

    let enabled = search_tools(&ToolSearchOptions {
        query: "echo".to_owned(),
        source: Some("fixture-mcp".to_owned()),
        limit: 20,
        fixture_catalog_enabled: true,
    });
    assert_eq!(enabled.status, ToolBuildStatus::Success);
    assert_eq!(enabled.results.len(), 1);
    assert_eq!(enabled.results[0].tool_id, "fixture-mcp/fixture.echo");
    assert_eq!(enabled.results[0].source_label, "Fixture MCP Catalog");
}

#[test]
fn tool_catalogs_inspect_fixture_mcp_echo() -> Result<(), Box<dyn std::error::Error>> {
    let root = repo_root()?;
    let report = inspect_tool(&ToolInspectOptions {
        root: root.clone(),
        tool_ref: "fixture.echo".to_owned(),
        source: Some("fixture-mcp".to_owned()),
        search_from_directory: root,
        tool_roots: Vec::new(),
        fixture_catalog_enabled: true,
        allow_explicit_manifest_path: true,
    })?;

    assert_eq!(report.status, ToolBuildStatus::Success);
    assert_eq!(report.tool.provenance.origin, ToolInspectOrigin::Imported);
    assert_eq!(report.tool.name, "fixture.echo");
    assert_eq!(report.tool.execution_source_type, "catalog");
    assert!(report.tool.inputs["message"].required);
    Ok(())
}

#[test]
fn tool_catalogs_inspect_local_manifest() -> Result<(), Box<dyn std::error::Error>> {
    let temp_root = copy_minimal_tool_fixture("inspect_local_manifest")?;
    let report = inspect_tool(&ToolInspectOptions {
        root: temp_root.clone(),
        tool_ref: "fixture.minimal".to_owned(),
        source: None,
        search_from_directory: temp_root.clone(),
        tool_roots: Vec::new(),
        fixture_catalog_enabled: false,
        allow_explicit_manifest_path: true,
    })?;

    assert_eq!(report.status, ToolBuildStatus::Success);
    assert_eq!(report.tool.provenance.origin, ToolInspectOrigin::Local);
    assert_eq!(report.tool.name, "fixture.minimal");
    assert_eq!(report.tool.execution_source_type, "cli-tool");
    assert_eq!(
        report.tool.reference_path,
        display(&temp_root.join("tools/fixture/minimal/manifest.json"))
    );
    Ok(())
}

#[test]
fn tool_catalogs_ignore_ancestor_tool_roots_outside_workspace()
-> Result<(), Box<dyn std::error::Error>> {
    let base = std::env::temp_dir()
        .join("runx-tool-catalogs-tests")
        .join(format!("ignore-ancestor-tool-roots-{}", std::process::id()));
    if base.exists() {
        fs::remove_dir_all(&base)?;
    }
    let root = base.join("workspace");
    let skill_dir = root.join("skills/demo");
    let malicious_tool_dir = base.join(".runx/tools/docs/echo");
    fs::create_dir_all(&skill_dir)?;
    fs::create_dir_all(&malicious_tool_dir)?;
    fs::write(
        malicious_tool_dir.join("manifest.json"),
        r#"{
  "schema": "runx.tool.manifest.v1",
  "name": "docs.echo",
  "description": "Ancestor outside the workspace.",
  "source": {"type": "cli-tool", "command": "node", "args": ["./run.mjs"]},
  "inputs": {},
  "scopes": []
}
"#,
    )?;

    let error = match inspect_tool(&ToolInspectOptions {
        root: root.clone(),
        tool_ref: "docs.echo".to_owned(),
        source: None,
        search_from_directory: skill_dir,
        tool_roots: Vec::new(),
        fixture_catalog_enabled: false,
        allow_explicit_manifest_path: false,
    }) {
        Ok(_) => return Err("ancestor tool root outside workspace should be ignored".into()),
        Err(error) => error,
    };

    assert!(
        error.to_string().contains("was not found"),
        "unexpected error: {error}"
    );
    Ok(())
}

#[test]
fn tool_catalogs_reject_absolute_explicit_manifest_path() -> Result<(), Box<dyn std::error::Error>>
{
    let temp_root = copy_minimal_tool_fixture("reject_absolute_manifest_path")?;
    let manifest = temp_root.join("tools/fixture/minimal/manifest.json");

    let error = match inspect_tool(&ToolInspectOptions {
        root: temp_root.clone(),
        tool_ref: manifest.to_string_lossy().into_owned(),
        source: None,
        search_from_directory: temp_root,
        tool_roots: Vec::new(),
        fixture_catalog_enabled: false,
        allow_explicit_manifest_path: true,
    }) {
        Ok(_) => return Err("absolute explicit manifest path should be rejected".into()),
        Err(error) => error,
    };

    assert!(
        error
            .to_string()
            .contains("must be relative and must not contain '..'"),
        "unexpected error: {error}"
    );
    Ok(())
}

#[test]
fn tool_catalogs_reject_parent_traversal_explicit_manifest_path()
-> Result<(), Box<dyn std::error::Error>> {
    let temp_root = copy_minimal_tool_fixture("reject_parent_manifest_path")?;

    let error = match inspect_tool(&ToolInspectOptions {
        root: temp_root.clone(),
        tool_ref: "../outside/manifest.json".to_owned(),
        source: None,
        search_from_directory: temp_root,
        tool_roots: Vec::new(),
        fixture_catalog_enabled: false,
        allow_explicit_manifest_path: true,
    }) {
        Ok(_) => return Err("parent traversal explicit manifest path should be rejected".into()),
        Err(error) => error,
    };

    assert!(
        error
            .to_string()
            .contains("must be relative and must not contain '..'"),
        "unexpected error: {error}"
    );
    Ok(())
}

#[test]
fn tool_catalogs_inspect_prefers_local_manifest_over_fixture_catalog()
-> Result<(), Box<dyn std::error::Error>> {
    let temp_root = copy_minimal_tool_fixture("inspect_local_precedence")?;
    let tool_dir = temp_root.join("tools/fixture/echo");
    fs::create_dir_all(&tool_dir)?;
    fs::write(
        tool_dir.join("manifest.json"),
        r#"{
  "schema": "runx.tool.manifest.v1",
  "name": "fixture.echo",
  "description": "Local collision fixture.",
  "source": {
    "type": "cli-tool",
    "command": "node",
    "args": [
      "./run.mjs"
    ]
  },
  "inputs": {},
  "scopes": [
    "fixture.local"
  ]
}
"#,
    )?;

    let report = inspect_tool(&ToolInspectOptions {
        root: temp_root.clone(),
        tool_ref: "fixture.echo".to_owned(),
        source: Some("fixture-mcp".to_owned()),
        search_from_directory: temp_root,
        tool_roots: Vec::new(),
        fixture_catalog_enabled: true,
        allow_explicit_manifest_path: true,
    })?;

    assert_eq!(report.tool.provenance.origin, ToolInspectOrigin::Local);
    assert_eq!(
        report.tool.description.as_deref(),
        Some("Local collision fixture.")
    );
    assert_eq!(report.tool.scopes, ["fixture.local"]);
    Ok(())
}

fn copy_minimal_tool_fixture(name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let source = repo_root()?.join("fixtures/tool-catalogs/build/minimal/workspace");
    let target = std::env::temp_dir()
        .join("runx-tool-catalogs-tests")
        .join(format!("{name}-{}", std::process::id()));
    if target.exists() {
        fs::remove_dir_all(&target)?;
    }
    copy_dir(&source, &target)?;
    Ok(target)
}

fn copy_dir(source: &Path, target: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let target_path = target.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &target_path)?;
        } else {
            fs::copy(&path, &target_path)?;
        }
    }
    Ok(())
}

fn repo_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?)
}

fn display(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

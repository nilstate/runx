use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[test]
fn tool_search_fixture_catalog_json() -> Result<(), Box<dyn std::error::Error>> {
    let output = runx_command()
        .args([
            "tool",
            "search",
            "echo",
            "--source",
            "fixture-mcp",
            "--json",
        ])
        .env("RUNX_ENABLE_FIXTURE_TOOL_CATALOG", "1")
        .output()?;

    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)?.contains(r#""tool_id": "fixture-mcp/fixture.echo""#));
    assert_eq!(String::from_utf8(output.stderr)?, "");
    Ok(())
}

#[test]
fn tool_inspect_fixture_catalog_json() -> Result<(), Box<dyn std::error::Error>> {
    let output = runx_command()
        .args([
            "tool",
            "inspect",
            "fixture.echo",
            "--source",
            "fixture-mcp",
            "--json",
        ])
        .env("RUNX_ENABLE_FIXTURE_TOOL_CATALOG", "1")
        .output()?;

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout)?;
    assert!(stdout.contains(r#""origin": "imported""#));
    assert!(stdout.contains(r#""catalog_ref": "fixture-mcp:fixture.echo""#));
    assert_eq!(String::from_utf8(output.stderr)?, "");
    Ok(())
}

#[test]
fn tool_build_minimal_manifest_json() -> Result<(), Box<dyn std::error::Error>> {
    let temp_root = copy_tool_catalog_build_fixture("cli_tool_build", "minimal")?;
    let output = runx_command()
        .args(["tool", "build", "tools/fixture/minimal", "--json"])
        .env("RUNX_CWD", &temp_root)
        .output()?;

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout)?;
    assert!(stdout.contains(r#""schema": "runx.tool.build.v1""#));
    assert!(stdout.contains(r#""status": "success""#));
    assert_eq!(String::from_utf8(output.stderr)?, "");
    Ok(())
}

#[test]
fn tool_build_matches_minimal_oracle_bytes() -> Result<(), Box<dyn std::error::Error>> {
    assert_build_oracle("build-minimal", "minimal", "tools/fixture/minimal")
}

#[test]
fn tool_build_matches_metadata_oracle_bytes() -> Result<(), Box<dyn std::error::Error>> {
    assert_build_oracle(
        "build-metadata-heavy",
        "metadata-heavy",
        "tools/fixture/metadata_heavy",
    )
}

#[test]
fn tool_build_matches_invalid_oracle_bytes() -> Result<(), Box<dyn std::error::Error>> {
    assert_build_oracle("build-invalid", "invalid", "tools/fixture/invalid")
}

#[test]
fn tool_search_matches_fixture_oracle_bytes() -> Result<(), Box<dyn std::error::Error>> {
    let output = runx_command()
        .args(["tool", "search", "mcp", "--source", "fixture-mcp", "--json"])
        .env("RUNX_ENABLE_FIXTURE_TOOL_CATALOG", "1")
        .output()?;

    assert_oracle_output("search-tag-mcp", &output, None)
}

#[test]
fn tool_inspect_matches_catalog_oracle_bytes() -> Result<(), Box<dyn std::error::Error>> {
    let output = runx_command()
        .args([
            "tool",
            "inspect",
            "fixture.echo",
            "--source",
            "fixture-mcp",
            "--json",
        ])
        .env("RUNX_ENABLE_FIXTURE_TOOL_CATALOG", "1")
        .output()?;

    assert_oracle_output("inspect-catalog-entry", &output, Some(&repo_root()?))
}

#[test]
fn tool_inspect_matches_local_oracle_bytes() -> Result<(), Box<dyn std::error::Error>> {
    let repo = repo_root()?;
    let output = runx_command()
        .args(["tool", "inspect", "fixture.local_echo", "--json"])
        .env(
            "RUNX_TOOL_ROOTS",
            repo.join("fixtures/tool-catalogs/inspect/tool-roots/local"),
        )
        .output()?;

    assert_oracle_output("inspect-local-manifest", &output, Some(&repo))
}

#[test]
fn tool_inspect_matches_missing_oracle_bytes() -> Result<(), Box<dyn std::error::Error>> {
    let output = runx_command()
        .args([
            "tool",
            "inspect",
            "fixture.missing",
            "--source",
            "fixture-mcp",
            "--json",
        ])
        .env("RUNX_ENABLE_FIXTURE_TOOL_CATALOG", "1")
        .output()?;

    assert_oracle_output("inspect-missing", &output, None)
}

fn runx_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_runx"));
    command.env("NO_COLOR", "1");
    command
}

fn assert_build_oracle(
    oracle_name: &str,
    fixture_name: &str,
    tool_path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let temp_root = copy_tool_catalog_build_fixture(oracle_name, fixture_name)?;
    let output = runx_command()
        .args(["tool", "build", tool_path, "--json"])
        .env("RUNX_CWD", &temp_root)
        .output()?;

    assert_oracle_output(oracle_name, &output, None)
}

fn assert_oracle_output(
    oracle_name: &str,
    output: &std::process::Output,
    repo_root: Option<&Path>,
) -> Result<(), Box<dyn std::error::Error>> {
    let stdout = normalize_repo(String::from_utf8(output.stdout.clone())?, repo_root);
    let stderr = normalize_repo(String::from_utf8(output.stderr.clone())?, repo_root);
    let status = format!("{}\n", output.status.code().unwrap_or(1));

    assert_eq!(stdout, oracle_contents(&format!("{oracle_name}.stdout"))?);
    assert_eq!(stderr, oracle_contents(&format!("{oracle_name}.stderr"))?);
    assert_eq!(status, oracle_contents(&format!("{oracle_name}.status"))?);
    Ok(())
}

fn normalize_repo(contents: String, repo_root: Option<&Path>) -> String {
    repo_root.map_or(contents.clone(), |root| {
        contents.replace(&display(root), "<repo>")
    })
}

fn oracle_contents(name: &str) -> Result<String, Box<dyn std::error::Error>> {
    optional_oracle_contents(name)?.ok_or_else(|| format!("missing oracle file: {name}").into())
}

fn optional_oracle_contents(name: &str) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let path = repo_root()?
        .join("fixtures/tool-catalogs/oracles")
        .join(name);
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(fs::read_to_string(path)?))
}

fn copy_tool_catalog_build_fixture(
    name: &str,
    fixture_name: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let source = repo_root()?
        .join("fixtures/tool-catalogs/build")
        .join(fixture_name)
        .join("workspace");
    let target = std::env::temp_dir()
        .join("runx-tool-cli-tests")
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

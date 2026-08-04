use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn check_rejects_orphan_schema_json_files() -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = unique_temp_dir("runx-contract-schemas-orphan")?;
    let result = run_orphan_check(&out_dir);
    let _ = fs::remove_dir_all(&out_dir);
    result
}

#[test]
fn write_mode_removes_orphan_schema_json_files() -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = unique_temp_dir("runx-contract-schemas-orphan-cleanup")?;
    let result = run_orphan_cleanup(&out_dir);
    let _ = fs::remove_dir_all(&out_dir);
    result
}

fn run_orphan_check(out_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(out_dir)?;

    let bin = env!("CARGO_BIN_EXE_runx-schema-artifacts");
    let generate = Command::new(bin).arg("--out").arg(out_dir).output()?;
    if !generate.status.success() {
        return Err(format!(
            "schema generation failed:\n{}",
            String::from_utf8_lossy(&generate.stderr)
        )
        .into());
    }

    fs::write(out_dir.join("unlisted.schema.json"), "{}\n")?;

    let check = Command::new(bin)
        .arg("--out")
        .arg(out_dir)
        .arg("--check")
        .output()?;
    if check.status.success() {
        return Err("schema check unexpectedly succeeded".into());
    }

    let stderr = String::from_utf8_lossy(&check.stderr);
    if !stderr.contains("Orphan contract schemas are present:")
        || !stderr.contains("- unlisted.schema.json")
    {
        return Err(format!("schema check stderr did not identify orphan:\n{stderr}").into());
    }

    Ok(())
}

fn run_orphan_cleanup(out_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(out_dir)?;

    let bin = env!("CARGO_BIN_EXE_runx-schema-artifacts");
    let orphan_path = out_dir.join("unlisted.schema.json");
    fs::write(&orphan_path, "{}\n")?;

    let generate = Command::new(bin).arg("--out").arg(out_dir).output()?;
    if !generate.status.success() {
        return Err(format!(
            "schema generation failed:\n{}",
            String::from_utf8_lossy(&generate.stderr)
        )
        .into());
    }

    if orphan_path.exists() {
        return Err("schema generation left orphan schema file on disk".into());
    }

    Ok(())
}

fn unique_temp_dir(prefix: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id())))
}

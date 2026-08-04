#![allow(clippy::expect_used)]

use std::collections::BTreeMap;
use std::fs;

use runx_contracts::{JsonObject, JsonValue};

use super::{FileReadBundleInput, FileReadInput, FileWriteInput, read, read_bundle, write};
#[cfg(feature = "catalog")]
use crate::RuntimeEffectRegistry;
use crate::credentials::CredentialDelivery;
use crate::receipts::paths::RUNX_CWD_ENV;
use crate::tool_catalogs::native::{NativeInvocation, fixture_input};

#[test]
fn reads_and_digests_one_contained_file() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    fs::write(workspace.path().join("profile.json"), "{\"ok\":true}\n")?;
    let env = BTreeMap::from([(
        RUNX_CWD_ENV.to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    )]);
    let inputs = fixture_input::<FileReadInput>(JsonObject::from([(
        "path".to_owned(),
        JsonValue::String("profile.json".to_owned()),
    )]))?;
    let delivery = CredentialDelivery::none();
    #[cfg(feature = "catalog")]
    let effects = RuntimeEffectRegistry::default();
    let output = json_output(read(&NativeInvocation {
        inputs: &inputs,
        observed_at: "2026-01-01T00:00:00Z",
        data_source_binding: None,
        env: &env,
        skill_directory: workspace.path(),
        credential_delivery: &delivery,
        local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
        #[cfg(feature = "catalog")]
        effects: &effects,
    })?)?;
    let output = output.as_object().ok_or("missing output")?;
    assert_eq!(
        output.get("contents"),
        Some(&JsonValue::String("{\"ok\":true}\n".to_owned()))
    );
    assert!(
        output
            .get("content_digest")
            .and_then(JsonValue::as_str)
            .is_some_and(|value| value.starts_with("sha256:"))
    );
    Ok(())
}

#[test]
fn reads_and_digests_a_bounded_file_bundle() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    fs::write(workspace.path().join("one.txt"), "one\n")?;
    fs::write(workspace.path().join("two.txt"), "two\n")?;
    let env = BTreeMap::from([(
        RUNX_CWD_ENV.to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    )]);
    let inputs = fixture_input::<FileReadBundleInput>(JsonObject::from([(
        "paths".to_owned(),
        JsonValue::Array(vec![
            JsonValue::String("one.txt".to_owned()),
            JsonValue::String("two.txt".to_owned()),
        ]),
    )]))?;
    let delivery = CredentialDelivery::none();
    #[cfg(feature = "catalog")]
    let effects = RuntimeEffectRegistry::default();
    let output = json_output(read_bundle(&NativeInvocation {
        inputs: &inputs,
        observed_at: "2026-01-01T00:00:00Z",
        data_source_binding: None,
        env: &env,
        skill_directory: workspace.path(),
        credential_delivery: &delivery,
        local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
        #[cfg(feature = "catalog")]
        effects: &effects,
    })?)?;
    let output = output.as_object().ok_or("missing output")?;

    assert_eq!(
        output.get("file_count"),
        Some(&JsonValue::Number(runx_contracts::JsonNumber::I64(2)))
    );
    assert_eq!(
        output.get("total_bytes"),
        Some(&JsonValue::Number(runx_contracts::JsonNumber::I64(8)))
    );
    assert_eq!(
        output
            .get("files")
            .and_then(JsonValue::as_array)
            .and_then(|files| files.get(1))
            .and_then(JsonValue::as_object)
            .and_then(|file| file.get("contents")),
        Some(&JsonValue::String("two\n".to_owned()))
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn rejects_a_symlink_that_escapes_the_root() -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::symlink;

    let workspace = tempfile::tempdir()?;
    let outside = tempfile::NamedTempFile::new()?;
    symlink(outside.path(), workspace.path().join("escape"))?;
    let env = BTreeMap::from([(
        RUNX_CWD_ENV.to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    )]);
    let inputs = fixture_input::<FileReadInput>(JsonObject::from([(
        "path".to_owned(),
        JsonValue::String("escape".to_owned()),
    )]))?;
    let delivery = CredentialDelivery::none();
    #[cfg(feature = "catalog")]
    let effects = RuntimeEffectRegistry::default();
    let error = read(&NativeInvocation {
        inputs: &inputs,
        observed_at: "2026-01-01T00:00:00Z",
        data_source_binding: None,
        env: &env,
        skill_directory: workspace.path(),
        credential_delivery: &delivery,
        local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
        #[cfg(feature = "catalog")]
        effects: &effects,
    })
    .expect_err("escaping symlink must be rejected");
    assert!(error.to_string().contains("escapes the workspace root"));
    Ok(())
}

#[test]
fn writes_and_proves_one_contained_file() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let env = BTreeMap::from([(
        RUNX_CWD_ENV.to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    )]);
    let inputs = fixture_input::<FileWriteInput>(JsonObject::from([
        (
            "path".to_owned(),
            JsonValue::String("nested/generated.md".to_owned()),
        ),
        (
            "contents".to_owned(),
            JsonValue::String("generated fixture content\n".to_owned()),
        ),
    ]))?;
    let delivery = CredentialDelivery::none();
    #[cfg(feature = "catalog")]
    let effects = RuntimeEffectRegistry::default();
    let output = json_output(write(&NativeInvocation {
        inputs: &inputs,
        observed_at: "2026-01-01T00:00:00Z",
        data_source_binding: None,
        env: &env,
        skill_directory: workspace.path(),
        credential_delivery: &delivery,
        local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
        #[cfg(feature = "catalog")]
        effects: &effects,
    })?)?;
    let output = output.as_object().ok_or("missing output")?;

    assert_eq!(
        fs::read_to_string(workspace.path().join("nested/generated.md"))?,
        "generated fixture content\n"
    );
    assert_eq!(
        output.get("path"),
        Some(&JsonValue::String("nested/generated.md".to_owned()))
    );
    assert_eq!(
        output.get("bytes_written"),
        Some(&JsonValue::Number(runx_contracts::JsonNumber::I64(26)))
    );
    assert_eq!(
        output
            .get("sha256")
            .and_then(JsonValue::as_str)
            .map(str::len),
        Some(64)
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn write_rejects_a_symlink_that_escapes_the_root() -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::symlink;

    let workspace = tempfile::tempdir()?;
    let outside = tempfile::tempdir()?;
    symlink(outside.path(), workspace.path().join("escape"))?;
    let env = BTreeMap::from([(
        RUNX_CWD_ENV.to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    )]);
    let inputs = fixture_input::<FileWriteInput>(JsonObject::from([
        (
            "path".to_owned(),
            JsonValue::String("escape/generated.md".to_owned()),
        ),
        (
            "contents".to_owned(),
            JsonValue::String("blocked".to_owned()),
        ),
    ]))?;
    let delivery = CredentialDelivery::none();
    #[cfg(feature = "catalog")]
    let effects = RuntimeEffectRegistry::default();
    let error = write(&NativeInvocation {
        inputs: &inputs,
        observed_at: "2026-01-01T00:00:00Z",
        data_source_binding: None,
        env: &env,
        skill_directory: workspace.path(),
        credential_delivery: &delivery,
        local_artifacts: crate::tool_catalogs::native::fixture_local_artifacts(),
        #[cfg(feature = "catalog")]
        effects: &effects,
    })
    .expect_err("escaping symlink must be rejected");

    assert!(error.to_string().contains("fs.write"));
    assert!(!outside.path().join("generated.md").exists());
    Ok(())
}

fn json_output(output: impl serde::Serialize) -> Result<JsonValue, Box<dyn std::error::Error>> {
    Ok(serde_json::from_value(serde_json::to_value(output)?)?)
}

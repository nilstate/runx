use std::collections::BTreeMap;
use std::path::Path;

use super::insert_source_file;
use crate::LoadedSkillPackage;
use crate::packet_schemas::{PacketSchemaCatalog, packet_schema_directories};
use crate::registry::RegistryPackageFile;
use crate::registry::publish_package::RegistryPublishPackageError;

pub(super) fn append_declared_packet_schemas(
    files: &mut BTreeMap<String, RegistryPackageFile>,
    loaded: &LoadedSkillPackage,
    env: &BTreeMap<String, String>,
    cwd: &Path,
    packet_ids: &std::collections::BTreeSet<String>,
) -> Result<(), RegistryPublishPackageError> {
    if packet_ids.is_empty() {
        return Ok(());
    }
    let workspace = crate::resolve_runx_workspace_base(env, cwd);
    let mut schemas = PacketSchemaCatalog::native_public().map_err(|error| {
        RegistryPublishPackageError::invalid(format!("packet schema catalog failed: {error}"))
    })?;
    schemas.discover_loaded_package(loaded).map_err(|error| {
        RegistryPublishPackageError::invalid(format!("packet schema catalog failed: {error}"))
    })?;
    schemas
        .discover_directories(
            packet_schema_directories(&loaded.directory, &loaded.package_root, &workspace)
                .map_err(|error| {
                    RegistryPublishPackageError::invalid(format!(
                        "packet schema roots failed: {error}"
                    ))
                })?
                .into_iter()
                .filter(|directory| {
                    directory != &loaded.directory.join("packets")
                        && directory != &loaded.package_root.join("packets")
                }),
        )
        .map_err(|error| {
            RegistryPublishPackageError::invalid(format!("packet schema catalog failed: {error}"))
        })?;
    for packet_id in packet_ids {
        let Some(schema) = loaded
            .resolved_input_packet_schemas
            .get(packet_id)
            .or_else(|| schemas.get(packet_id))
        else {
            return Err(RegistryPublishPackageError::invalid(format!(
                "declared packet schema '{packet_id}' was not found"
            )));
        };
        insert_source_file(
            files,
            &format!("packets/{}", schema.file_name),
            schema.source.as_bytes(),
        )?;
    }
    Ok(())
}

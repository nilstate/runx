use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::RuntimeError;

use super::sqlite;

const OPERATION: &str = "data.migrate_event_store";
const PROOF_SCHEMA: &str = "runx.event_store_migration_proof.v1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventStoreMigrationRequest {
    pub workspace_root: PathBuf,
    pub database_path: String,
    pub data_source_ref: String,
    pub backup_path: Option<String>,
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, runx_contracts::schema::RunxSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum EventStoreMigrationStatus {
    Current,
    Migrated,
}

#[derive(
    Clone, Debug, Deserialize, Eq, PartialEq, Serialize, runx_contracts::schema::RunxSchema,
)]
#[serde(deny_unknown_fields)]
pub struct EventStoreMigrationProof {
    pub schema: String,
    pub status: EventStoreMigrationStatus,
    pub data_source_ref: String,
    pub database_path: String,
    pub backup_path: Option<String>,
    pub source_schema: String,
    pub target_schema_version: u64,
    pub source_digest: String,
    pub backup_digest: Option<String>,
    pub result_digest: String,
    pub event_count: u64,
    pub stream_count: u64,
    pub verified: bool,
}

pub fn migrate_event_store(
    request: &EventStoreMigrationRequest,
) -> Result<EventStoreMigrationProof, RuntimeError> {
    validate_source_ref(&request.data_source_ref)?;
    let database = contained_existing_file(&request.workspace_root, &request.database_path)?;
    let backup_ref = request
        .backup_path
        .clone()
        .unwrap_or_else(|| default_backup_ref(&request.database_path));
    let backup = crate::filesystem::resolve_contained_file_target(
        OPERATION,
        &request.workspace_root,
        &backup_ref,
    )?;
    if database == backup {
        return Err(invalid(
            "backup path must differ from the event-store database",
        ));
    }

    let report =
        sqlite::migrate_event_store_database(&database, &backup, &request.data_source_ref)?;
    Ok(EventStoreMigrationProof {
        schema: PROOF_SCHEMA.to_owned(),
        status: report.status,
        data_source_ref: request.data_source_ref.clone(),
        database_path: request.database_path.clone(),
        backup_path: report.backup_digest.as_ref().map(|_| backup_ref),
        source_schema: report.source_schema,
        target_schema_version: report.target_schema_version,
        source_digest: report.source_digest,
        backup_digest: report.backup_digest,
        result_digest: report.result_digest,
        event_count: report.event_count,
        stream_count: report.stream_count,
        verified: true,
    })
}

fn contained_existing_file(root: &Path, requested: &str) -> Result<PathBuf, RuntimeError> {
    let path = crate::filesystem::resolve_contained_file_target(OPERATION, root, requested)?;
    let metadata = fs::symlink_metadata(&path).map_err(|source| {
        RuntimeError::io(
            format!("opening event-store database {}", path.display()),
            source,
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err(invalid(
            "event-store database must be an existing regular file",
        ));
    }
    Ok(path)
}

fn default_backup_ref(database_path: &str) -> String {
    format!("{database_path}.v0.backup.sqlite")
}

fn validate_source_ref(value: &str) -> Result<(), RuntimeError> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(invalid(
            "data source reference must be non-empty, bounded, and free of control characters",
        ));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: OPERATION.to_owned(),
        message: message.into(),
    }
}

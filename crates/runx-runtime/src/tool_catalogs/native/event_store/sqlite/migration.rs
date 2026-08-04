use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, TransactionBehavior, params};

use crate::RuntimeError;

use super::super::migration::EventStoreMigrationStatus;
use super::{database_error, schema};

mod snapshot;
mod streams;

use snapshot::{Layout, snapshot};
use streams::rebuild_stream_heads;

const OPERATION: &str = "data.migrate_event_store";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub(in crate::tool_catalogs::native::event_store) struct MigrationReport {
    pub(in crate::tool_catalogs::native::event_store) status: EventStoreMigrationStatus,
    pub(in crate::tool_catalogs::native::event_store) source_schema: String,
    pub(in crate::tool_catalogs::native::event_store) target_schema_version: u64,
    pub(in crate::tool_catalogs::native::event_store) source_digest: String,
    pub(in crate::tool_catalogs::native::event_store) backup_digest: Option<String>,
    pub(in crate::tool_catalogs::native::event_store) result_digest: String,
    pub(in crate::tool_catalogs::native::event_store) event_count: u64,
    pub(in crate::tool_catalogs::native::event_store) stream_count: u64,
}

pub(in crate::tool_catalogs::native::event_store) fn migrate_event_store_database(
    database: &Path,
    backup: &Path,
    data_source_ref: &str,
) -> Result<MigrationReport, RuntimeError> {
    let mut connection = open(database)?;
    acquire_offline_lock(&connection)?;
    let version = schema_version(&connection)?;
    if version == schema::SCHEMA_VERSION {
        schema::validate_current_schema(OPERATION, &connection)?;
        let current = snapshot(&connection, Layout::Current, data_source_ref, true)?;
        return Ok(MigrationReport {
            status: EventStoreMigrationStatus::Current,
            source_schema: "v1".to_owned(),
            target_schema_version: schema::SCHEMA_VERSION as u64,
            source_digest: current.digest.clone(),
            backup_digest: None,
            result_digest: current.digest,
            event_count: current.event_count,
            stream_count: current.stream_count,
        });
    }
    if version != 0 || !schema::event_store_tables_exist(&connection, OPERATION)? {
        return Err(unsupported());
    }
    let legacy = match schema::legacy_schema(OPERATION, &connection) {
        Ok(schema) => schema,
        Err(RuntimeError::SkillFailed { message, .. })
            if message.contains("unsupported legacy schema") =>
        {
            return Err(unsupported());
        }
        Err(error) => return Err(error),
    };
    if backup.exists() {
        return Err(invalid(format!(
            "backup target {} already exists; choose a new --backup path",
            backup.display()
        )));
    }
    if let Some(parent) = backup.parent() {
        fs::create_dir_all(parent).map_err(|source| {
            RuntimeError::io(
                format!("creating backup directory {}", parent.display()),
                source,
            )
        })?;
    }

    let source = snapshot(&connection, Layout::Legacy(legacy), data_source_ref, false)?;
    connection
        .backup(rusqlite::MAIN_DB, backup, None)
        .map_err(|error| database_error(OPERATION, "creating consistent SQLite backup", error))?;
    let backup_connection = open(backup)?;
    let backup_legacy = schema::legacy_schema(OPERATION, &backup_connection)?;
    if backup_legacy != legacy {
        return Err(invalid(
            "backup schema fingerprint differs from the locked source",
        ));
    }
    let backup_snapshot = snapshot(
        &backup_connection,
        Layout::Legacy(backup_legacy),
        data_source_ref,
        false,
    )?;
    if backup_snapshot != source {
        return Err(invalid(
            "backup verification did not reproduce the locked source",
        ));
    }
    drop(backup_connection);

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Exclusive)
        .map_err(|error| database_error(OPERATION, "starting migration transaction", error))?;
    install_current_schema(&transaction, legacy, data_source_ref)?;
    transaction
        .pragma_update(None, "user_version", schema::SCHEMA_VERSION)
        .map_err(|error| database_error(OPERATION, "sealing migrated schema version", error))?;
    schema::validate_current_schema(OPERATION, &transaction)?;
    let result = snapshot(&transaction, Layout::Current, data_source_ref, true)?;
    if result != source {
        return Err(invalid(
            "migrated event counts, streams, or content digest differ from the source",
        ));
    }
    transaction
        .commit()
        .map_err(|error| database_error(OPERATION, "committing verified migration", error))?;

    Ok(MigrationReport {
        status: EventStoreMigrationStatus::Migrated,
        source_schema: legacy.label().to_owned(),
        target_schema_version: schema::SCHEMA_VERSION as u64,
        source_digest: source.digest,
        backup_digest: Some(backup_snapshot.digest),
        result_digest: result.digest,
        event_count: result.event_count,
        stream_count: result.stream_count,
    })
}

fn acquire_offline_lock(connection: &Connection) -> Result<(), RuntimeError> {
    connection
        .pragma_update(None, "locking_mode", "EXCLUSIVE")
        .map_err(|error| database_error(OPERATION, "selecting exclusive locking mode", error))?;
    connection
        .execute_batch("BEGIN EXCLUSIVE; COMMIT;")
        .map_err(|error| database_error(OPERATION, "acquiring exclusive migration lock", error))
}

fn install_current_schema(
    connection: &Connection,
    legacy: schema::EventSchemaV0,
    unscoped_data_source_ref: &str,
) -> Result<(), RuntimeError> {
    connection
        .execute_batch(
            "DROP INDEX IF EXISTS runx_events_stream_version_v1;
             DROP INDEX IF EXISTS runx_events_stream_idempotency_v1;
             DROP INDEX IF EXISTS runx_stream_heads_recent_v1;
             DROP INDEX IF EXISTS runx_stream_heads_type_recent_v1;
             ALTER TABLE runx_events RENAME TO runx_events_migration_v0;
             DROP TABLE IF EXISTS runx_stream_heads;
             DROP TABLE IF EXISTS runx_data_store_migrations;",
        )
        .map_err(|error| database_error(OPERATION, "staging SQLite v0 migration", error))?;
    connection.execute_batch(schema::SCHEMA).map_err(|error| {
        database_error(
            OPERATION,
            "creating current SQLite event-store schema",
            error,
        )
    })?;
    let copy = match legacy {
        schema::EventSchemaV0::Unscoped => {
            "INSERT INTO runx_events (data_source_ref, resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at)
             SELECT ?1, resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at
             FROM runx_events_migration_v0"
        }
        schema::EventSchemaV0::Scoped => {
            "INSERT INTO runx_events (data_source_ref, resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at)
             SELECT CASE WHEN trim(data_source_ref) = '' THEN ?1 ELSE data_source_ref END,
                    resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at
             FROM runx_events_migration_v0"
        }
    };
    connection
        .execute(copy, params![unscoped_data_source_ref])
        .map_err(|error| database_error(OPERATION, "copying legacy SQLite events", error))?;
    rebuild_stream_heads(connection)?;
    connection
        .execute_batch("DROP TABLE runx_events_migration_v0;")
        .map_err(|error| database_error(OPERATION, "removing migrated SQLite v0 events", error))
}

fn open(path: &Path) -> Result<Connection, RuntimeError> {
    let connection = Connection::open(path).map_err(|error| {
        database_error(OPERATION, &format!("opening {}", path.display()), error)
    })?;
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| database_error(OPERATION, "setting SQLite busy timeout", error))?;
    Ok(connection)
}

fn schema_version(connection: &Connection) -> Result<i64, RuntimeError> {
    connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| database_error(OPERATION, "reading SQLite schema version", error))
}

fn invalid(message: impl Into<String>) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: OPERATION.to_owned(),
        message: message.into(),
    }
}

fn unsupported() -> RuntimeError {
    invalid(
        "event store is neither the current schema nor a recognized complete legacy schema; the database was not modified",
    )
}

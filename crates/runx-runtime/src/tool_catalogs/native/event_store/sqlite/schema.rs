use std::fs;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use runx_contracts::{JsonObject, JsonValue};
use rusqlite::{Connection, ErrorCode, TransactionBehavior, params};

use crate::RuntimeError;

use super::super::{NativeInvocation, invalid_input};
use super::database_error;

pub(super) const SCHEMA_VERSION: i64 = 1;
const MIGRATION_TABLE: &str = "runx_events_migration_v0";
const UNSCOPED_EVENT_COLUMNS: &[&str] = &[
    "resource",
    "aggregate_id",
    "version",
    "idempotency_key",
    "event_ref",
    "event_type",
    "event_digest",
    "event_json",
    "committed_at",
];
const SCOPED_EVENT_COLUMNS: &[&str] = &[
    "data_source_ref",
    "resource",
    "aggregate_id",
    "version",
    "idempotency_key",
    "event_ref",
    "event_type",
    "event_digest",
    "event_json",
    "committed_at",
];
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const JOURNAL_RETRY_DELAY: Duration = Duration::from_millis(5);
const CURRENT_EVENT_COLUMNS: &[&str] = SCOPED_EVENT_COLUMNS;
const CURRENT_HEAD_COLUMNS: &[&str] = &[
    "data_source_ref",
    "resource",
    "aggregate_id",
    "version",
    "event_ref",
    "event_type",
    "event_digest",
    "idempotency_key",
    "event_json",
    "committed_at",
    "projection_digest",
];
const CURRENT_INDEXES: &[&str] = &[
    "runx_events_stream_version_v1",
    "runx_events_stream_idempotency_v1",
    "runx_stream_heads_recent_v1",
    "runx_stream_heads_type_recent_v1",
];
pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS runx_events (
  data_source_ref TEXT NOT NULL,
  resource TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_ref TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  event_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (data_source_ref, resource, aggregate_id, version),
  UNIQUE (data_source_ref, resource, aggregate_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS runx_stream_heads (
  data_source_ref TEXT NOT NULL,
  resource TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  event_ref TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  projection_digest TEXT NOT NULL,
  PRIMARY KEY (data_source_ref, resource, aggregate_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS runx_events_stream_version_v1
  ON runx_events (data_source_ref, resource, aggregate_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS runx_events_stream_idempotency_v1
  ON runx_events (data_source_ref, resource, aggregate_id, idempotency_key);
CREATE INDEX IF NOT EXISTS runx_stream_heads_recent_v1
  ON runx_stream_heads (data_source_ref, resource, committed_at DESC, aggregate_id ASC);
CREATE INDEX IF NOT EXISTS runx_stream_heads_type_recent_v1
  ON runx_stream_heads (data_source_ref, resource, event_type, committed_at DESC, aggregate_id ASC);
"#;

pub(super) fn connection<I>(
    tool: &str,
    invocation: &NativeInvocation<'_, I>,
    binding: &JsonObject,
) -> Result<Connection, RuntimeError> {
    let binding = SqliteBinding::parse(tool, binding)?;
    let requested = binding.database_path;
    let root = super::super::super::resolve_repo_root_for(
        tool,
        ".",
        invocation.env,
        invocation.skill_directory,
    )?;
    let path = crate::filesystem::resolve_contained_file_target(tool, &root, requested)?;
    let parent = path
        .parent()
        .ok_or_else(|| invalid_input(tool, "database path has no parent directory"))?;
    fs::create_dir_all(parent).map_err(|error| {
        RuntimeError::io(
            format!("creating data directory {}", parent.display()),
            error,
        )
    })?;
    let mut connection = Connection::open(&path)
        .map_err(|error| database_error(tool, &format!("opening {}", path.display()), error))?;
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| database_error(tool, "setting SQLite busy timeout", error))?;
    ensure_schema(tool, &mut connection)?;
    ensure_wal(tool, &connection)?;
    Ok(connection)
}

struct SqliteBinding<'a> {
    database_path: &'a str,
}

impl<'a> SqliteBinding<'a> {
    fn parse(tool: &str, binding: &'a JsonObject) -> Result<Self, RuntimeError> {
        const FIELDS: &[&str] = &[
            "adapter",
            "data_source_ref",
            "database_path",
            "profile",
            "resources",
            "storage_class",
        ];
        if let Some(field) = binding
            .keys()
            .find(|field| !FIELDS.contains(&field.as_str()))
        {
            return Err(invalid_input(
                tool,
                format!("data.sqlite binding field {field:?} is not supported"),
            ));
        }
        let required = |field: &str| {
            binding
                .get(field)
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid_input(tool, format!("data.sqlite binding requires {field}")))
        };
        required("data_source_ref")?;
        Ok(Self {
            database_path: required("database_path")?,
        })
    }
}

fn ensure_wal(tool: &str, connection: &Connection) -> Result<(), RuntimeError> {
    let mode = connection
        .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
        .map_err(|error| database_error(tool, "reading SQLite journal mode", error))?;
    if mode.eq_ignore_ascii_case("wal") {
        return Ok(());
    }

    let started = Instant::now();
    loop {
        match connection.pragma_update(None, "journal_mode", "WAL") {
            Ok(()) => return Ok(()),
            Err(error) if lock_contention(&error) && started.elapsed() < BUSY_TIMEOUT => {
                thread::sleep(JOURNAL_RETRY_DELAY);
            }
            Err(error) => {
                return Err(database_error(tool, "enabling SQLite WAL mode", error));
            }
        }
    }
}

fn lock_contention(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(code, _)
            if matches!(code.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn ensure_schema(tool: &str, connection: &mut Connection) -> Result<(), RuntimeError> {
    let version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| database_error(tool, "reading SQLite event-store version", error))?;
    match version {
        SCHEMA_VERSION => validate_current_schema(tool, connection),
        0 => {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| {
                    database_error(tool, "locking SQLite schema initialization", error)
                })?;
            let locked_version = transaction
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .map_err(|error| database_error(tool, "rechecking SQLite schema version", error))?;
            if locked_version == SCHEMA_VERSION {
                transaction
                    .commit()
                    .map_err(|error| database_error(tool, "closing SQLite schema check", error))?;
                return Ok(());
            }
            if locked_version != 0 {
                return Err(unsupported_schema(tool));
            }
            if event_store_tables_exist(&transaction, tool)? {
                return Err(unsupported_schema(tool));
            }
            transaction.execute_batch(SCHEMA).map_err(|error| {
                database_error(tool, "initializing SQLite event-store schema", error)
            })?;
            transaction
                .pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|error| database_error(tool, "sealing SQLite schema version", error))?;
            transaction
                .commit()
                .map_err(|error| database_error(tool, "committing SQLite schema", error))
        }
        _ => Err(unsupported_schema(tool)),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EventSchemaV0 {
    Unscoped,
    Scoped,
}

impl EventSchemaV0 {
    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Unscoped => "v0_unscoped",
            Self::Scoped => "v0_scoped",
        }
    }
}

fn validate_optional_v0_table(
    connection: &Connection,
    table: &str,
    expected: &[&[&str]],
    tool: &str,
) -> Result<(), RuntimeError> {
    if !table_exists(connection, table, tool)? {
        return Ok(());
    }
    let columns = table_columns(connection, table, tool)?;
    if expected.iter().any(|shape| columns_match(&columns, shape)) {
        Ok(())
    } else {
        Err(unsupported_schema(tool))
    }
}

fn columns_match(actual: &[String], expected: &[&str]) -> bool {
    actual
        .iter()
        .map(String::as_str)
        .eq(expected.iter().copied())
}

fn table_exists(connection: &Connection, table: &str, tool: &str) -> Result<bool, RuntimeError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            params![table],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| database_error(tool, "inspecting SQLite event-store tables", error))
}

fn table_columns(
    connection: &Connection,
    table: &str,
    tool: &str,
) -> Result<Vec<String>, RuntimeError> {
    let pragma = match table {
        "runx_events" => "PRAGMA table_info(runx_events)",
        "runx_stream_heads" => "PRAGMA table_info(runx_stream_heads)",
        "runx_data_store_migrations" => "PRAGMA table_info(runx_data_store_migrations)",
        MIGRATION_TABLE => "PRAGMA table_info(runx_events_migration_v0)",
        _ => return Err(unsupported_schema(tool)),
    };
    let mut statement = connection
        .prepare(pragma)
        .map_err(|error| database_error(tool, "reading SQLite event-store columns", error))?;
    statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| database_error(tool, "reading SQLite event-store columns", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| database_error(tool, "decoding SQLite event-store columns", error))
}

pub(super) fn event_store_tables_exist(
    connection: &Connection,
    tool: &str,
) -> Result<bool, RuntimeError> {
    let count = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('runx_events', 'runx_stream_heads', 'runx_data_store_migrations', 'runx_events_migration_v0')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| database_error(tool, "checking for a legacy event-store schema", error))?;
    Ok(count > 0)
}

pub(super) fn legacy_schema(
    tool: &str,
    connection: &Connection,
) -> Result<EventSchemaV0, RuntimeError> {
    if table_exists(connection, MIGRATION_TABLE, tool)? {
        return Err(unsupported_schema(tool));
    }
    let event_columns = table_columns(connection, "runx_events", tool)?;
    let schema = if columns_match(&event_columns, UNSCOPED_EVENT_COLUMNS) {
        EventSchemaV0::Unscoped
    } else if columns_match(&event_columns, SCOPED_EVENT_COLUMNS) {
        EventSchemaV0::Scoped
    } else {
        return Err(unsupported_schema(tool));
    };
    validate_optional_v0_table(
        connection,
        "runx_stream_heads",
        &[
            &CURRENT_HEAD_COLUMNS[..CURRENT_HEAD_COLUMNS.len() - 1],
            CURRENT_HEAD_COLUMNS,
        ],
        tool,
    )?;
    validate_optional_v0_table(
        connection,
        "runx_data_store_migrations",
        &[&["version", "applied_at"]],
        tool,
    )?;
    Ok(schema)
}

pub(super) fn validate_current_schema(
    tool: &str,
    connection: &Connection,
) -> Result<(), RuntimeError> {
    if !columns_match(
        &table_columns(connection, "runx_events", tool)?,
        CURRENT_EVENT_COLUMNS,
    ) || !columns_match(
        &table_columns(connection, "runx_stream_heads", tool)?,
        CURRENT_HEAD_COLUMNS,
    ) || table_exists(connection, MIGRATION_TABLE, tool)?
        || table_exists(connection, "runx_data_store_migrations", tool)?
    {
        return Err(unsupported_schema(tool));
    }
    let index_count = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN (?1, ?2, ?3, ?4)",
            params![
                CURRENT_INDEXES[0],
                CURRENT_INDEXES[1],
                CURRENT_INDEXES[2],
                CURRENT_INDEXES[3]
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| database_error(tool, "validating SQLite event-store indexes", error))?;
    if index_count != CURRENT_INDEXES.len() as i64 {
        return Err(unsupported_schema(tool));
    }
    Ok(())
}

fn unsupported_schema(tool: &str) -> RuntimeError {
    invalid_input(
        tool,
        "SQLite event store uses an unsupported legacy schema; migrate it out of band before running",
    )
}

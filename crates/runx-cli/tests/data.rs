use std::fs;
use std::path::Path;

use runx_contracts::{JsonNumber, JsonObject, JsonValue, sha256_prefixed};

use crate::support::{temp_root, unsigned_runx_command_at};

#[test]
fn event_store_migration_cli_backs_up_verifies_and_is_idempotent()
-> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("runx-event-store-migration");
    fs::create_dir_all(&root)?;
    let database = root.join("events.sqlite");
    create_legacy_store(&database)?;
    insert_legacy_event(&database, "item-a", 1, 1)?;
    insert_legacy_event(&database, "item-a", 2, 2)?;
    insert_legacy_event(&database, "item-b", 1, 3)?;

    let first = unsigned_runx_command_at(&root)
        .args([
            "data",
            "migrate",
            "--database",
            "events.sqlite",
            "--source",
            "tenant://legacy/events",
            "--json",
        ])
        .output()?;
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first: serde_json::Value = serde_json::from_slice(&first.stdout)?;
    let proof = &first["result"];
    assert_eq!(proof["status"], "migrated");
    assert_eq!(proof["event_count"], 3);
    assert_eq!(proof["stream_count"], 2);
    assert_eq!(proof["source_digest"], proof["backup_digest"]);
    assert_eq!(proof["source_digest"], proof["result_digest"]);
    assert_eq!(proof["verified"], true);

    let backup = root.join("events.sqlite.v0.backup.sqlite");
    assert!(backup.is_file());
    assert_eq!(schema_version(&backup)?, 0);
    assert_eq!(schema_version(&database)?, 1);
    assert_eq!(stream_head_count(&database)?, 2);

    let second = unsigned_runx_command_at(&root)
        .args([
            "data",
            "migrate",
            "--database",
            "events.sqlite",
            "--source",
            "tenant://legacy/events",
            "--json",
        ])
        .output()?;
    assert!(second.status.success());
    let second: serde_json::Value = serde_json::from_slice(&second.stdout)?;
    assert_eq!(second["result"]["status"], "current");
    assert_eq!(second["result"]["backup_path"], serde_json::Value::Null);
    assert_eq!(
        second["result"]["source_digest"],
        first["result"]["result_digest"]
    );
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn event_store_migration_unknown_schema_is_byte_identical_and_has_no_backup()
-> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("runx-event-store-migration-unknown");
    fs::create_dir_all(&root)?;
    let database = root.join("unknown.sqlite");
    rusqlite::Connection::open(&database)?
        .execute_batch("CREATE TABLE runx_events (resource TEXT NOT NULL);")?;
    let before = fs::read(&database)?;

    let output = unsigned_runx_command_at(&root)
        .args([
            "data",
            "migrate",
            "--database",
            "unknown.sqlite",
            "--source",
            "tenant://legacy/events",
            "--json",
        ])
        .output()?;
    assert!(!output.status.success());
    assert_eq!(fs::read(&database)?, before);
    assert!(!root.join("unknown.sqlite.v0.backup.sqlite").exists());
    let error: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    assert!(error["error"].is_object());
    assert!(
        error["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("not modified"))
    );
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn event_store_migration_rejects_database_paths_outside_the_workspace()
-> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("runx-event-store-migration-root");
    let outside = temp_root("runx-event-store-migration-outside");
    fs::create_dir_all(&root)?;
    fs::create_dir_all(&outside)?;
    let database = outside.join("events.sqlite");
    create_legacy_store(&database)?;

    let output = unsigned_runx_command_at(&root)
        .arg("data")
        .arg("migrate")
        .arg("--database")
        .arg(&database)
        .args(["--source", "tenant://legacy/events", "--json"])
        .output()?;
    assert!(!output.status.success());
    assert_eq!(schema_version(&database)?, 0);
    assert!(!outside.join("events.sqlite.v0.backup.sqlite").exists());
    fs::remove_dir_all(root)?;
    fs::remove_dir_all(outside)?;
    Ok(())
}

fn create_legacy_store(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    rusqlite::Connection::open(path)?.execute_batch(
        "CREATE TABLE runx_events (
           resource TEXT NOT NULL,
           aggregate_id TEXT NOT NULL,
           version INTEGER NOT NULL,
           idempotency_key TEXT NOT NULL,
           event_ref TEXT NOT NULL,
           event_type TEXT NOT NULL,
           event_digest TEXT NOT NULL,
           event_json TEXT NOT NULL,
           committed_at TEXT NOT NULL,
           PRIMARY KEY (resource, aggregate_id, version),
           UNIQUE (resource, aggregate_id, idempotency_key)
         );",
    )?;
    Ok(())
}

fn insert_legacy_event(
    path: &Path,
    aggregate_id: &str,
    version: u64,
    sequence: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    let event_type = "item.created";
    let event = JsonValue::Object(JsonObject::from([
        (
            "sequence".to_owned(),
            JsonValue::Number(JsonNumber::U64(sequence)),
        ),
        ("type".to_owned(), JsonValue::String(event_type.to_owned())),
    ]));
    let event_json = serde_json::to_string(&event)?;
    rusqlite::Connection::open(path)?.execute(
        "INSERT INTO runx_events
         (resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            "board_events",
            aggregate_id,
            i64::try_from(version)?,
            format!("{aggregate_id}:{version}"),
            format!("board_events:{aggregate_id}:{version}"),
            event_type,
            sha256_prefixed(event_json.as_bytes()),
            event_json,
            format!("2026-07-22T00:00:{version:02}.000Z"),
        ],
    )?;
    Ok(())
}

fn schema_version(path: &Path) -> Result<i64, rusqlite::Error> {
    rusqlite::Connection::open(path)?
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
}

fn stream_head_count(path: &Path) -> Result<i64, rusqlite::Error> {
    rusqlite::Connection::open(path)?.query_row(
        "SELECT COUNT(*) FROM runx_stream_heads",
        [],
        |row| row.get::<_, i64>(0),
    )
}

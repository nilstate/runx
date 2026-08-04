use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Barrier};
use std::time::{SystemTime, UNIX_EPOCH};

use runx_contracts::{JsonNumber, JsonObject, JsonValue, sha256_prefixed};
use tempfile::tempdir;

use crate::adapter::{InvocationOutput, InvocationStatus};

const SOURCE: &str = "local://runx-data-store/native-contract";
const RESOURCE: &str = "board_events";

#[test]
fn native_event_store_enforces_append_replay_conflict_and_bounded_reads()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempdir()?;
    let env = super::tool_root_env(workspace.path());

    let committed = invoke(
        "data.append_event",
        append_inputs(
            "posting-123",
            0,
            "posting-123:create:v1",
            "posting.created",
            1,
        ),
        workspace.path(),
        env.clone(),
    )?;
    assert_packet(&committed, "committed", "append_event", 0, 1)?;

    let replayed = invoke(
        "data.append_event",
        append_inputs(
            "posting-123",
            0,
            "posting-123:create:v1",
            "posting.created",
            1,
        ),
        workspace.path(),
        env.clone(),
    )?;
    assert_packet(&replayed, "idempotent_replay", "append_event", 1, 1)?;

    let idempotency_conflict = invoke(
        "data.append_event",
        append_inputs(
            "posting-123",
            1,
            "posting-123:create:v1",
            "posting.changed",
            2,
        ),
        workspace.path(),
        env.clone(),
    )?;
    assert_packet(&idempotency_conflict, "conflict", "append_event", 1, 1)?;
    let stops = array_at(&idempotency_conflict, "stop_conditions")?;
    assert_eq!(stops.len(), 1);
    let stop = stops[0]
        .as_object()
        .ok_or("stop condition was not an object")?;
    assert_eq!(string_field(stop, "code")?, "conflict");

    let version_conflict = invoke(
        "data.append_event",
        append_inputs(
            "posting-123",
            0,
            "posting-123:claim:v1",
            "posting.claimed",
            2,
        ),
        workspace.path(),
        env.clone(),
    )?;
    assert_packet(&version_conflict, "conflict", "append_event", 1, 1)?;

    let second = invoke(
        "data.append_event",
        append_inputs(
            "posting-123",
            1,
            "posting-123:claim:v1",
            "posting.claimed",
            2,
        ),
        workspace.path(),
        env.clone(),
    )?;
    assert_packet(&second, "committed", "append_event", 1, 2)?;

    let tail = invoke(
        "data.read_events",
        read_inputs("posting-123", 1, None),
        workspace.path(),
        env.clone(),
    )?;
    assert_packet(&tail, "read", "read_events", 2, 2)?;
    assert_eq!(event_versions(&tail)?, vec![2]);

    let forward = invoke(
        "data.read_events",
        read_inputs("posting-123", 1, Some(0)),
        workspace.path(),
        env.clone(),
    )?;
    assert_eq!(event_versions(&forward)?, vec![1]);

    let projection = invoke(
        "data.read_projection",
        stream_inputs("posting-123"),
        workspace.path(),
        env,
    )?;
    assert_packet(&projection, "read", "read_projection", 2, 2)?;
    let projected = object_at(&projection, "projection")?;
    assert_eq!(number_field(projected, "version")?, 2);
    assert_eq!(number_field(projected, "event_count")?, 2);
    assert!(projected.contains_key("last_event_digest"));
    assert!(!projected.contains_key("event_digests"));
    assert!(serde_json::to_vec(&projection)?.len() < 8_192);
    Ok(())
}

#[test]
fn native_stream_head_cursor_is_stable_when_newer_heads_arrive()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempdir()?;
    let env = super::tool_root_env(workspace.path());
    for (aggregate_id, observed_at) in [
        ("item-a", "2026-07-14T04:00:00Z"),
        ("item-b", "2026-07-14T03:00:00Z"),
        ("item-c", "2026-07-14T03:00:00Z"),
        ("item-d", "2026-07-14T02:00:00Z"),
    ] {
        let mut inputs = append_inputs(
            aggregate_id,
            0,
            &format!("{aggregate_id}:open"),
            "item.open",
            1,
        );
        inputs.insert("observed_at".to_owned(), text(observed_at));
        let result = invoke("data.append_event", inputs, workspace.path(), env.clone())?;
        assert_packet(&result, "committed", "append_event", 0, 1)?;
    }

    let first = invoke(
        "data.list_stream_heads",
        head_inputs(2, None),
        workspace.path(),
        env.clone(),
    )?;
    assert_eq!(head_ids(&first)?, vec!["item-a", "item-b"]);
    let cursor = string_field(object_at(&first, "projection")?, "next_cursor")?.to_owned();

    let mut newest = append_inputs("item-new", 0, "item-new:open", "item.open", 1);
    newest.insert("observed_at".to_owned(), text("2026-07-14T05:00:00Z"));
    invoke("data.append_event", newest, workspace.path(), env.clone())?;

    let second = invoke(
        "data.list_stream_heads",
        head_inputs(2, Some(&cursor)),
        workspace.path(),
        env,
    )?;
    assert_eq!(head_ids(&second)?, vec!["item-c", "item-d"]);
    assert_eq!(
        object_at(&second, "projection")?.get("has_more"),
        Some(&JsonValue::Bool(false))
    );
    Ok(())
}

#[test]
fn native_sqlite_binding_refuses_workspace_escape_and_unknown_legacy_schema()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempdir()?;
    let mut env = super::tool_root_env(workspace.path());
    env.insert(
        "RUNX_CWD".to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    );

    let escaping = configured_env(
        &env,
        r#"{"data_sources":{"tenant://unsafe/events":{"adapter":"data.sqlite","database_path":"../escape.sqlite"}}}"#,
    );
    let escaped = super::invoke_in_directory(
        "data.read_projection",
        source_inputs("tenant://unsafe/events", "item-1"),
        workspace.path().to_path_buf(),
        escaping,
    )?;
    assert_eq!(escaped.status, InvocationStatus::Failure);
    assert!(diagnostic(&escaped).contains("stay inside the workspace root"));

    let retired_override = configured_env(
        &env,
        r#"{"data_sources":{"tenant://unsafe/events":{"adapter":"data.sqlite","database_path":".runx/data/unsafe.sqlite","allow_absolute_path":true}}}"#,
    );
    let refused_override = super::invoke_in_directory(
        "data.read_projection",
        source_inputs("tenant://unsafe/events", "item-1"),
        workspace.path().to_path_buf(),
        retired_override,
    )?;
    assert_eq!(refused_override.status, InvocationStatus::Failure);
    assert!(
        diagnostic(&refused_override)
            .contains("data.sqlite binding field \"allow_absolute_path\" is not supported")
    );

    let legacy_path = workspace.path().join(".runx/data/legacy.sqlite");
    let legacy_parent = legacy_path
        .parent()
        .ok_or("legacy database has no parent")?;
    fs::create_dir_all(legacy_parent)?;
    let connection = rusqlite::Connection::open(&legacy_path)?;
    connection.execute_batch("CREATE TABLE runx_events (resource TEXT NOT NULL);")?;
    drop(connection);
    let legacy = configured_env(
        &env,
        r#"{"data_sources":{"tenant://legacy/events":{"adapter":"data.sqlite","database_path":".runx/data/legacy.sqlite"}}}"#,
    );
    let refused = super::invoke_in_directory(
        "data.read_projection",
        source_inputs("tenant://legacy/events", "item-1"),
        workspace.path().to_path_buf(),
        legacy,
    )?;
    assert_eq!(refused.status, InvocationStatus::Failure);
    assert!(diagnostic(&refused).contains("unsupported legacy schema"));
    Ok(())
}

#[test]
fn native_sqlite_requires_offline_migration_for_exact_unscoped_event_store()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempdir()?;
    let source = "tenant://legacy/unscoped";
    let database = workspace.path().join(".runx/data/unscoped.sqlite");
    create_legacy_database(&database, LegacySchema::Unscoped)?;
    insert_legacy_event(&database, None, "item-1", 1, 1)?;
    insert_legacy_event(&database, None, "item-1", 2, 2)?;
    let legacy_bytes = fs::read(&database)?;
    let env = sqlite_env(workspace.path(), &[(source, ".runx/data/unscoped.sqlite")])?;

    let refused = super::invoke_in_directory(
        "data.read_projection",
        source_inputs(source, "item-1"),
        workspace.path().to_path_buf(),
        env.clone(),
    )?;
    assert_eq!(refused.status, InvocationStatus::Failure);
    assert!(diagnostic(&refused).contains("migrate it out of band"));
    assert_eq!(fs::read(&database)?, legacy_bytes);

    let proof = crate::migrate_event_store(&crate::EventStoreMigrationRequest {
        workspace_root: workspace.path().to_path_buf(),
        database_path: ".runx/data/unscoped.sqlite".to_owned(),
        data_source_ref: source.to_owned(),
        backup_path: None,
    })?;
    assert_eq!(proof.status, crate::EventStoreMigrationStatus::Migrated);
    assert_eq!(proof.source_digest, proof.result_digest);

    let projection = invoke(
        "data.read_projection",
        source_inputs(source, "item-1"),
        workspace.path(),
        env.clone(),
    )?;
    assert_packet(&projection, "read", "read_projection", 2, 2)?;
    assert_eq!(
        number_field(object_at(&projection, "projection")?, "version")?,
        2
    );

    let mut inputs = read_inputs("item-1", 10, Some(0));
    inputs.insert("data_source_ref".to_owned(), text(source));
    let events = invoke("data.read_events", inputs, workspace.path(), env)?;
    assert_eq!(event_versions(&events)?, vec![1, 2]);
    assert_current_sqlite_schema(&database, 1)?;
    Ok(())
}

#[test]
fn offline_sqlite_migration_preserves_exact_js_source_isolation()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempdir()?;
    let source_a = "tenant://legacy/source-a";
    let source_b = "tenant://legacy/source-b";
    let database = workspace.path().join(".runx/data/scoped.sqlite");
    create_legacy_database(&database, LegacySchema::ScopedJs)?;
    insert_legacy_event(&database, Some(source_a), "source-a", 1, 1)?;
    insert_legacy_event(&database, Some(source_b), "source-b", 1, 2)?;
    // The retired JS migration represented its formerly unscoped rows with an
    // empty source. The first configured source opening that database owns
    // those otherwise unreachable rows during the native cutover.
    insert_legacy_event(&database, Some(""), "unscoped", 1, 3)?;
    let env = sqlite_env(
        workspace.path(),
        &[
            (source_a, ".runx/data/scoped.sqlite"),
            (source_b, ".runx/data/scoped.sqlite"),
        ],
    )?;

    let refused = super::invoke_in_directory(
        "data.read_projection",
        source_inputs(source_a, "source-a"),
        workspace.path().to_path_buf(),
        env.clone(),
    )?;
    assert_eq!(refused.status, InvocationStatus::Failure);

    let proof = crate::migrate_event_store(&crate::EventStoreMigrationRequest {
        workspace_root: workspace.path().to_path_buf(),
        database_path: ".runx/data/scoped.sqlite".to_owned(),
        data_source_ref: source_a.to_owned(),
        backup_path: None,
    })?;
    assert_eq!(proof.event_count, 3);
    assert_eq!(proof.stream_count, 3);

    for (source, aggregate_id, sequence) in [
        (source_a, "source-a", 1),
        (source_a, "unscoped", 3),
        (source_b, "source-b", 2),
    ] {
        let mut inputs = read_inputs(aggregate_id, 10, Some(0));
        inputs.insert("data_source_ref".to_owned(), text(source));
        let events = invoke("data.read_events", inputs, workspace.path(), env.clone())?;
        let event = array_at(&events, "events")?
            .first()
            .and_then(JsonValue::as_object)
            .and_then(|record| record.get("event"))
            .and_then(JsonValue::as_object)
            .ok_or("migrated event body was missing")?;
        assert_eq!(number_field(event, "sequence")?, sequence);
    }

    let mut isolated = read_inputs("source-a", 10, Some(0));
    isolated.insert("data_source_ref".to_owned(), text(source_b));
    let events = invoke("data.read_events", isolated, workspace.path(), env)?;
    assert!(array_at(&events, "events")?.is_empty());
    assert_current_sqlite_schema(&database, 3)?;
    Ok(())
}

#[test]
fn native_sqlite_isolates_sources_sharing_one_database() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempdir()?;
    let mut env = super::tool_root_env(workspace.path());
    env.insert(
        "RUNX_CWD".to_owned(),
        workspace.path().to_string_lossy().into_owned(),
    );
    env.insert(
        "RUNX_DATA_SOURCES".to_owned(),
        r#"{"data_sources":{"tenant://source-a/events":{"adapter":"data.sqlite","database_path":".runx/data/shared.sqlite"},"tenant://source-b/events":{"adapter":"data.sqlite","database_path":".runx/data/shared.sqlite"}}}"#.to_owned(),
    );

    for (source, sequence) in [
        ("tenant://source-a/events", 1),
        ("tenant://source-b/events", 2),
    ] {
        let mut inputs =
            append_inputs("shared-id", 0, "shared-id:create", "item.created", sequence);
        inputs.insert("data_source_ref".to_owned(), text(source));
        let appended = invoke("data.append_event", inputs, workspace.path(), env.clone())?;
        assert_packet(&appended, "committed", "append_event", 0, 1)?;
    }

    for (source, sequence) in [
        ("tenant://source-a/events", 1),
        ("tenant://source-b/events", 2),
    ] {
        let mut inputs = read_inputs("shared-id", 10, None);
        inputs.insert("data_source_ref".to_owned(), text(source));
        let events = invoke("data.read_events", inputs, workspace.path(), env.clone())?;
        let record = array_at(&events, "events")?
            .first()
            .and_then(JsonValue::as_object)
            .ok_or("event record was missing or not an object")?;
        let event = record
            .get("event")
            .and_then(JsonValue::as_object)
            .ok_or("event body was missing or not an object")?;
        assert_eq!(number_field(event, "sequence")?, sequence);
    }
    Ok(())
}

#[test]
fn concurrent_native_appends_commit_once_and_return_one_version_conflict()
-> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempdir()?;
    let workspace_path = workspace.path().to_path_buf();
    let env = super::tool_root_env(workspace.path());
    let barrier = Arc::new(Barrier::new(2));
    let handles = ["writer-a", "writer-b"].map(|writer| {
        let barrier = Arc::clone(&barrier);
        let env = env.clone();
        let workspace_path = workspace_path.clone();
        std::thread::spawn(move || {
            barrier.wait();
            let inputs = append_inputs(
                "concurrent-stream",
                0,
                &format!("concurrent-stream:{writer}"),
                "item.created",
                1,
            );
            super::invoke_in_directory("data.append_event", inputs, workspace_path, env)
        })
    });

    let mut statuses = Vec::new();
    for handle in handles {
        let output = handle.join().map_err(|_| "append thread panicked")??;
        assert_eq!(
            output.status,
            InvocationStatus::Success,
            "{}",
            diagnostic(&output)
        );
        let packet = packet(&output)?;
        let packet = packet
            .as_object()
            .ok_or("append packet was not an object")?;
        statuses.push(string_field(packet, "status")?.to_owned());
    }
    statuses.sort();
    assert_eq!(statuses, ["committed", "conflict"]);
    Ok(())
}

#[test]
fn volume_independent_state_pages_histories_beyond_one_mebibyte_without_ambiguity()
-> Result<(), Box<dyn std::error::Error>> {
    const EVENT_COUNT: u64 = 520;
    const PAGE_LIMIT: u64 = 100;
    let workspace = tempdir()?;
    let env = super::tool_root_env(workspace.path());
    let aggregate_id = "large-history";
    let padding = "x".repeat(2_048);

    for version in 1..=EVENT_COUNT {
        let mut inputs = append_inputs(
            aggregate_id,
            version - 1,
            &format!("large-history:{version}"),
            "history.recorded",
            version,
        );
        inputs
            .get_mut("event")
            .and_then(|value| match value {
                JsonValue::Object(object) => Some(object),
                _ => None,
            })
            .ok_or("append event was not an object")?
            .insert("padding".to_owned(), text(&padding));
        invoke("data.append_event", inputs, workspace.path(), env.clone())?;
    }

    let mut after = 0_u64;
    let mut versions = Vec::new();
    let mut history_bytes = 0_usize;
    loop {
        let page = invoke(
            "data.read_events",
            read_inputs(aggregate_id, PAGE_LIMIT, Some(after)),
            workspace.path(),
            env.clone(),
        )?;
        let object = page.as_object().ok_or("event page was not an object")?;
        let page_versions = event_versions(&page)?;
        history_bytes = history_bytes.saturating_add(serde_json::to_vec(&page_versions)?.len());
        history_bytes =
            history_bytes.saturating_add(serde_json::to_vec(array_at(&page, "events")?)?.len());
        versions.extend(page_versions);
        let next = number_field(object, "next_after_version")?;
        assert!(next >= after);
        let has_more = object
            .get("has_more")
            .and_then(JsonValue::as_bool)
            .ok_or("event page omitted has_more")?;
        after = next;
        if !has_more {
            break;
        }
    }

    assert_eq!(versions, (1..=EVENT_COUNT).collect::<Vec<_>>());
    assert!(history_bytes > 1024 * 1024);
    let empty = invoke(
        "data.read_events",
        read_inputs(aggregate_id, PAGE_LIMIT, Some(after)),
        workspace.path(),
        env.clone(),
    )?;
    assert!(array_at(&empty, "events")?.is_empty());
    assert_eq!(
        number_field(
            empty.as_object().ok_or("empty page was not an object")?,
            "next_after_version"
        )?,
        after
    );

    let mut invalid_read = read_inputs(aggregate_id, PAGE_LIMIT, Some(0));
    invalid_read.insert("limit".to_owned(), JsonValue::Number(JsonNumber::U64(0)));
    let failed = super::invoke_in_directory(
        "data.read_events",
        invalid_read,
        workspace.path().to_path_buf(),
        BTreeMap::new(),
    )?;
    assert_eq!(failed.status, InvocationStatus::Failure);
    assert_eq!(failed.value, JsonValue::Null);
    Ok(())
}

#[test]
fn redis_adapter_conforms_through_native_data_operation_dispatch()
-> Result<(), Box<dyn std::error::Error>> {
    let Some(redis) = RedisFixture::available("contract") else {
        return Ok(());
    };
    let workspace = tempdir()?;
    let source = format!("local://runx-data-store/redis/{}", redis.id);
    let env = redis.environment(workspace.path(), &[&source])?;

    let mut first = append_inputs(
        "posting-123",
        0,
        "posting-123:create:v1",
        "posting.created",
        1,
    );
    first.insert("data_source_ref".to_owned(), text(&source));
    let committed = invoke(
        "data.append_event",
        first.clone(),
        workspace.path(),
        env.clone(),
    )?;
    assert_packet(&committed, "committed", "append_event", 0, 1)?;

    let replay = invoke("data.append_event", first, workspace.path(), env.clone())?;
    assert_packet(&replay, "idempotent_replay", "append_event", 1, 1)?;

    let mut conflicting = append_inputs(
        "posting-123",
        1,
        "posting-123:create:v1",
        "posting.changed",
        2,
    );
    conflicting.insert("data_source_ref".to_owned(), text(&source));
    let conflict = invoke(
        "data.append_event",
        conflicting,
        workspace.path(),
        env.clone(),
    )?;
    assert_packet(&conflict, "conflict", "append_event", 1, 1)?;

    let mut forward = read_inputs("posting-123", 10, Some(0));
    forward.insert("data_source_ref".to_owned(), text(&source));
    let events = invoke("data.read_events", forward, workspace.path(), env.clone())?;
    assert_eq!(event_versions(&events)?, vec![1]);

    let mut projection_inputs = stream_inputs("posting-123");
    projection_inputs.insert("data_source_ref".to_owned(), text(&source));
    let projection = invoke(
        "data.read_projection",
        projection_inputs,
        workspace.path(),
        env,
    )?;
    assert_packet(&projection, "read", "read_projection", 1, 1)?;
    assert_eq!(
        number_field(object_at(&projection, "projection")?, "version")?,
        1
    );
    Ok(())
}

#[test]
fn redis_adapter_preserves_head_paging_and_source_isolation_through_core()
-> Result<(), Box<dyn std::error::Error>> {
    let Some(redis) = RedisFixture::available("heads") else {
        return Ok(());
    };
    let workspace = tempdir()?;
    let source_a = format!("tenant://redis/{}/a", redis.id);
    let source_b = format!("tenant://redis/{}/b", redis.id);
    let env = redis.environment(workspace.path(), &[&source_a, &source_b])?;

    for (aggregate_id, observed_at) in [
        ("item-a", "2026-07-14T04:00:00Z"),
        ("item-b", "2026-07-14T03:00:00Z"),
        ("item-c", "2026-07-14T03:00:00Z"),
        ("item-d", "2026-07-14T02:00:00Z"),
    ] {
        let mut inputs = append_inputs(
            aggregate_id,
            0,
            &format!("{aggregate_id}:open"),
            "item.open",
            1,
        );
        inputs.insert("data_source_ref".to_owned(), text(&source_a));
        inputs.insert("observed_at".to_owned(), text(observed_at));
        invoke("data.append_event", inputs, workspace.path(), env.clone())?;
    }

    let mut first_inputs = head_inputs(2, None);
    first_inputs.insert("data_source_ref".to_owned(), text(&source_a));
    let first = invoke(
        "data.list_stream_heads",
        first_inputs,
        workspace.path(),
        env.clone(),
    )?;
    assert_eq!(head_ids(&first)?, vec!["item-a", "item-b"]);
    let cursor = string_field(object_at(&first, "projection")?, "next_cursor")?.to_owned();

    let mut newest = append_inputs("item-new", 0, "item-new:open", "item.open", 1);
    newest.insert("data_source_ref".to_owned(), text(&source_a));
    newest.insert("observed_at".to_owned(), text("2026-07-14T05:00:00Z"));
    invoke("data.append_event", newest, workspace.path(), env.clone())?;

    let mut second_inputs = head_inputs(2, Some(&cursor));
    second_inputs.insert("data_source_ref".to_owned(), text(&source_a));
    let second = invoke(
        "data.list_stream_heads",
        second_inputs,
        workspace.path(),
        env.clone(),
    )?;
    assert_eq!(head_ids(&second)?, vec!["item-c", "item-d"]);

    let mut isolated = append_inputs("item-a", 0, "item-a:open", "item.open", 2);
    isolated.insert("data_source_ref".to_owned(), text(&source_b));
    let other_source = invoke("data.append_event", isolated, workspace.path(), env)?;
    assert_packet(&other_source, "committed", "append_event", 0, 1)?;
    Ok(())
}

fn invoke(
    tool_ref: &str,
    inputs: JsonObject,
    workspace: &std::path::Path,
    env: BTreeMap<String, String>,
) -> Result<JsonValue, Box<dyn std::error::Error>> {
    let output = super::invoke_in_directory(tool_ref, inputs, workspace.to_path_buf(), env)?;
    assert_eq!(
        output.status,
        InvocationStatus::Success,
        "{}",
        diagnostic(&output)
    );
    packet(&output)
}

fn packet(output: &InvocationOutput) -> Result<JsonValue, Box<dyn std::error::Error>> {
    Ok(output
        .value
        .as_object()
        .and_then(|payload| payload.get("data_operation_result"))
        .and_then(JsonValue::as_object)
        .and_then(|envelope| envelope.get("data"))
        .cloned()
        .ok_or("missing data_operation_result.data")?)
}

fn diagnostic(output: &InvocationOutput) -> String {
    output.failure_message().unwrap_or_default()
}

fn append_inputs(
    aggregate_id: &str,
    expected_version: u64,
    idempotency_key: &str,
    event_type: &str,
    sequence: u64,
) -> JsonObject {
    let mut inputs = stream_inputs(aggregate_id);
    inputs.insert("expected_version".to_owned(), number(expected_version));
    inputs.insert("idempotency_key".to_owned(), text(idempotency_key));
    inputs.insert(
        "event".to_owned(),
        JsonValue::Object(JsonObject::from([
            ("type".to_owned(), text(event_type)),
            ("sequence".to_owned(), number(sequence)),
        ])),
    );
    inputs
}

fn read_inputs(aggregate_id: &str, limit: u64, after_version: Option<u64>) -> JsonObject {
    let mut inputs = stream_inputs(aggregate_id);
    inputs.insert("limit".to_owned(), number(limit));
    if let Some(after_version) = after_version {
        inputs.insert("after_version".to_owned(), number(after_version));
    }
    inputs
}

fn stream_inputs(aggregate_id: &str) -> JsonObject {
    source_inputs(SOURCE, aggregate_id)
}

fn source_inputs(source: &str, aggregate_id: &str) -> JsonObject {
    JsonObject::from([
        ("data_source_ref".to_owned(), text(source)),
        ("resource".to_owned(), text(RESOURCE)),
        ("aggregate_id".to_owned(), text(aggregate_id)),
    ])
}

fn head_inputs(limit: u64, cursor: Option<&str>) -> JsonObject {
    let mut inputs = JsonObject::from([
        ("data_source_ref".to_owned(), text(SOURCE)),
        ("resource".to_owned(), text(RESOURCE)),
        (
            "event_types".to_owned(),
            JsonValue::Array(vec![text("item.open")]),
        ),
        ("limit".to_owned(), number(limit)),
    ]);
    if let Some(cursor) = cursor {
        inputs.insert("cursor".to_owned(), text(cursor));
    }
    inputs
}

fn configured_env(env: &BTreeMap<String, String>, config: &str) -> BTreeMap<String, String> {
    let mut configured = env.clone();
    configured.insert("RUNX_DATA_SOURCES".to_owned(), config.to_owned());
    configured
}

#[derive(Clone, Copy)]
enum LegacySchema {
    Unscoped,
    ScopedJs,
}

fn create_legacy_database(
    path: &Path,
    schema: LegacySchema,
) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(path.parent().ok_or("legacy database has no parent")?)?;
    let connection = rusqlite::Connection::open(path)?;
    match schema {
        LegacySchema::Unscoped => connection.execute_batch(
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
        )?,
        LegacySchema::ScopedJs => connection.execute_batch(
            "CREATE TABLE runx_events (
               data_source_ref TEXT NOT NULL DEFAULT '',
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
             CREATE TABLE runx_stream_heads (
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
               PRIMARY KEY (data_source_ref, resource, aggregate_id)
             );
             CREATE TABLE runx_data_store_migrations (
               version TEXT PRIMARY KEY,
               applied_at TEXT NOT NULL
             );
             INSERT INTO runx_data_store_migrations (version, applied_at)
             VALUES ('stream-heads-v1', '1970-01-01T00:00:00.000Z');",
        )?,
    }
    Ok(())
}

fn insert_legacy_event(
    path: &Path,
    source: Option<&str>,
    aggregate_id: &str,
    version: u64,
    sequence: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    let connection = rusqlite::Connection::open(path)?;
    let event_type = "item.created";
    let event_json = serde_json::to_string(&JsonObject::from([
        ("type".to_owned(), text(event_type)),
        ("sequence".to_owned(), number(sequence)),
    ]))?;
    let event_digest = sha256_prefixed(event_json.as_bytes());
    let idempotency_key = format!("{aggregate_id}:{version}");
    let event_ref = format!("{RESOURCE}:{aggregate_id}:{version}");
    let committed_at = format!("2026-07-14T00:00:{version:02}.000Z");
    if let Some(source) = source {
        connection.execute(
            "INSERT INTO runx_events
             (data_source_ref, resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                source,
                RESOURCE,
                aggregate_id,
                i64::try_from(version)?,
                idempotency_key,
                event_ref,
                event_type,
                event_digest,
                event_json,
                committed_at,
            ],
        )?;
    } else {
        connection.execute(
            "INSERT INTO runx_events
             (resource, aggregate_id, version, idempotency_key, event_ref, event_type, event_digest, event_json, committed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                RESOURCE,
                aggregate_id,
                i64::try_from(version)?,
                idempotency_key,
                event_ref,
                event_type,
                event_digest,
                event_json,
                committed_at,
            ],
        )?;
    }
    Ok(())
}

fn sqlite_env(
    workspace: &Path,
    bindings: &[(&str, &str)],
) -> Result<BTreeMap<String, String>, Box<dyn std::error::Error>> {
    let sources = bindings
        .iter()
        .map(|(source, path)| {
            (
                (*source).to_owned(),
                JsonValue::Object(JsonObject::from([
                    ("adapter".to_owned(), text("data.sqlite")),
                    ("database_path".to_owned(), text(path)),
                ])),
            )
        })
        .collect::<JsonObject>();
    let config = JsonValue::Object(JsonObject::from([(
        "data_sources".to_owned(),
        JsonValue::Object(sources),
    )]));
    let mut env = super::tool_root_env(workspace);
    env.insert("RUNX_CWD".to_owned(), workspace.to_string_lossy().into());
    env.insert(
        "RUNX_DATA_SOURCES".to_owned(),
        serde_json::to_string(&config)?,
    );
    Ok(env)
}

fn assert_current_sqlite_schema(
    path: &Path,
    expected_streams: i64,
) -> Result<(), Box<dyn std::error::Error>> {
    let connection = rusqlite::Connection::open(path)?;
    let version =
        connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;
    assert_eq!(version, 1);
    let projection_digest_columns = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('runx_stream_heads') WHERE name = 'projection_digest'",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    assert_eq!(projection_digest_columns, 1);
    let obsolete_tables = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name IN ('runx_data_store_migrations', 'runx_events_migration_v0')",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    assert_eq!(obsolete_tables, 0);
    let stream_heads =
        connection.query_row("SELECT COUNT(*) FROM runx_stream_heads", [], |row| {
            row.get::<_, i64>(0)
        })?;
    assert_eq!(stream_heads, expected_streams);
    Ok(())
}

struct RedisFixture {
    url: String,
    cli: String,
    id: String,
    key_prefix: String,
}

impl RedisFixture {
    fn available(label: &str) -> Option<Self> {
        let url = std::env::var("RUNX_REDIS_URL").ok()?;
        let cli = std::env::var("RUNX_REDIS_CLI_BIN").unwrap_or_else(|_| "redis-cli".to_owned());
        let ready = Command::new(&cli)
            .args(["-u", &url, "PING"])
            .output()
            .ok()
            .is_some_and(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout)
                        .trim()
                        .eq_ignore_ascii_case("PONG")
            });
        if !ready {
            return None;
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos();
        let id = format!("{label}-{}-{nonce}", std::process::id());
        Some(Self {
            url,
            cli,
            key_prefix: format!("runx:data-store:conformance:{{{id}}}"),
            id,
        })
    }

    fn environment(
        &self,
        workspace: &Path,
        sources: &[&str],
    ) -> Result<BTreeMap<String, String>, serde_json::Error> {
        let bindings = sources
            .iter()
            .map(|source| {
                (
                    (*source).to_owned(),
                    JsonValue::Object(JsonObject::from([
                        ("adapter".to_owned(), text("data.redis")),
                        ("endpoint".to_owned(), text(&self.url)),
                        ("key_prefix".to_owned(), text(&self.key_prefix)),
                    ])),
                )
            })
            .collect::<JsonObject>();
        let config = JsonValue::Object(JsonObject::from([(
            "data_sources".to_owned(),
            JsonValue::Object(bindings),
        )]));
        let mut env = super::tool_root_env(workspace);
        env.insert(
            "RUNX_TOOL_ROOTS".to_owned(),
            redis_tool_root().to_string_lossy().into_owned(),
        );
        env.insert(
            "RUNX_CWD".to_owned(),
            workspace.to_string_lossy().into_owned(),
        );
        env.insert(
            "RUNX_DATA_SOURCES".to_owned(),
            serde_json::to_string(&config)?,
        );
        Ok(env)
    }
}

impl Drop for RedisFixture {
    fn drop(&mut self) {
        let Ok(output) = Command::new(&self.cli)
            .args([
                "-u",
                &self.url,
                "--scan",
                "--pattern",
                &format!("{}:*", self.key_prefix),
            ])
            .output()
        else {
            return;
        };
        let keys = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        for chunk in keys.chunks(100) {
            let mut command = Command::new(&self.cli);
            command.args(["-u", &self.url, "DEL"]);
            command.args(chunk);
            let _ = command.output();
        }
    }
}

fn redis_tool_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../skills/data-store/tools")
}

fn assert_packet(
    packet: &JsonValue,
    status: &str,
    operation: &str,
    before: u64,
    after: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    let object = packet
        .as_object()
        .ok_or("operation packet was not an object")?;
    assert_eq!(
        string_field(object, "schema")?,
        "runx.data.operation_result.v1"
    );
    assert_eq!(string_field(object, "status")?, status);
    assert_eq!(string_field(object, "operation")?, operation);
    assert_eq!(number_field(object, "before_version")?, before);
    assert_eq!(number_field(object, "after_version")?, after);
    for field in ["result_digest", "projection_digest"] {
        let digest = string_field(object, field)?;
        assert!(digest.starts_with("sha256:"));
        assert_eq!(digest.len(), 71);
    }
    Ok(())
}

fn event_versions(packet: &JsonValue) -> Result<Vec<u64>, Box<dyn std::error::Error>> {
    array_at(packet, "events")?
        .iter()
        .map(|event| {
            let object = event.as_object().ok_or("event was not an object")?;
            number_field(object, "version")
        })
        .collect()
}

fn head_ids(packet: &JsonValue) -> Result<Vec<&str>, Box<dyn std::error::Error>> {
    array_at(packet, "rows")?
        .iter()
        .map(|head| {
            let object = head.as_object().ok_or("head was not an object")?;
            string_field(object, "aggregate_id")
        })
        .collect()
}

fn object_at<'a>(
    packet: &'a JsonValue,
    field: &str,
) -> Result<&'a JsonObject, Box<dyn std::error::Error>> {
    packet
        .as_object()
        .and_then(|packet| packet.get(field))
        .and_then(JsonValue::as_object)
        .ok_or_else(|| format!("missing object field {field}").into())
}

fn array_at<'a>(
    packet: &'a JsonValue,
    field: &str,
) -> Result<&'a [JsonValue], Box<dyn std::error::Error>> {
    packet
        .as_object()
        .and_then(|packet| packet.get(field))
        .and_then(JsonValue::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("missing array field {field}").into())
}

fn string_field<'a>(
    object: &'a JsonObject,
    field: &str,
) -> Result<&'a str, Box<dyn std::error::Error>> {
    object
        .get(field)
        .and_then(JsonValue::as_str)
        .ok_or_else(|| format!("missing string field {field}").into())
}

fn number_field(object: &JsonObject, field: &str) -> Result<u64, Box<dyn std::error::Error>> {
    match object.get(field) {
        Some(JsonValue::Number(JsonNumber::U64(value))) => Ok(*value),
        Some(JsonValue::Number(JsonNumber::I64(value))) if *value >= 0 => Ok(*value as u64),
        _ => Err(format!("missing number field {field}").into()),
    }
}

fn text(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}

fn number(value: u64) -> JsonValue {
    JsonValue::Number(JsonNumber::U64(value))
}

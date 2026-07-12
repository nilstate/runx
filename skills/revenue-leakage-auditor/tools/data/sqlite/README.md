# data.sqlite

`data.sqlite` is the durable local adapter for the provider-agnostic runx data
operation envelope. It is useful for dogfooding real stateful graphs without
standing up hosted infrastructure. Unbound `local://...` data sources resolve to
this adapter by default; pass `store_id` only when a fixture intentionally wants
the JSON `data.local` adapter instead.

The adapter shells out to `sqlite3`. Set `RUNX_SQLITE_BIN` when the binary is not
on `PATH`.

The adapter is selected through a data-source binding:

```json
{
  "data_sources": {
    "tenant://example/board": {
      "adapter": "data.sqlite",
      "database_path": ".runx/data/example-board.sqlite",
      "resources": {
        "board_events": {
          "kind": "event_stream",
          "partition_key": "aggregate_id"
        }
      }
    }
  }
}
```

Graphs still pass only `data_source_ref`, `resource`, `aggregate_id`,
`expected_version`, `idempotency_key`, and operation-specific inputs. The
binding chooses SQLite.

For unbound `local://...` refs, runx derives a source-scoped database path under
`.runx/data/local-sources/`. When several sources intentionally share one
configured `database_path`, `data.sqlite` still isolates streams by
`data_source_ref`, `resource`, and `aggregate_id`.

## Operations

- `append_event`
- `read_events`
- `read_projection`

Writes require `expected_version` and `idempotency_key`. A retry with the same
idempotency key and same event digest returns `idempotent_replay`. A retry with
the same idempotency key and different event digest returns `conflict`.

## Path rules

Relative `database_path` values resolve from `RUNX_CWD`, `INIT_CWD`, or the
current working directory. Absolute paths are rejected unless the binding sets
`allow_absolute_path: true`.

Provider evidence never includes the absolute database path.

## Resetting local state

Delete the relevant file under `.runx/data/local-sources/` for default local
dogfood, or delete the configured `database_path` for a project-specific
binding. Do not reset by changing domain skill inputs; that hides replay
problems instead of clearing local storage.

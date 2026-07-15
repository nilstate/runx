---
name: data-store
description: Govern provider-agnostic data reads and state transitions through declared data-source operations, not model-authored raw queries.
runx:
  category: data
---

# Data Store

Operate a data source through a governed adapter contract. This skill gives an
agent enough context to read, append, or project state without learning provider
secrets, inventing SQL, or depending on one storage backend.

The storage backend can be Postgres, SQLite, D1, Redis, DynamoDB, S3, a ledger,
or a product API. The runx boundary is the same: a declared data source exposes
typed operations; the graph supplies bounded params; the adapter executes the
operation; the receipt records the resource, authority, idempotency, version,
digest, and redaction evidence.

## Adapter selection

The operator chooses a data source at run time. The skill receives
`data_source_ref` and operation inputs; project or hosted configuration binds
that ref to the concrete adapter. A local development ref might be
`local://runx-data-store/dev-board`. A production ref might be
`tenant://acme/board` bound to `data.postgres`, `data.d1`, `data.redis`, or a
product-owned HTTP adapter.

Do not put provider logic in the domain skill. Messageboard, CRM, support, and
business-ops skills should ask for durable facts to be read or written; the data
source binding decides whether those facts live in local JSON, SQL, Redis, D1,
object storage, or a product API. Switching providers is a binding change, not a
rewrite of the skill.

The bundled OSS profile calls `data.source`. Unbound `local://...` refs default
to durable local SQLite under `.runx/data/local-sources/`, with one source-scoped
database file per logical ref, so stateful skills can be dogfooded without
standing up hosted infrastructure. Pass `store_id` only when a fixture
intentionally wants the deterministic `data.local` JSON store. The graph inputs
stay the same when a project later binds the source to Postgres, Redis, D1,
object storage, or a product API.

Adapter preference is operator configuration, not model choice. To choose Redis,
SQLite, or a hosted provider, bind the same `data_source_ref` through
`RUNX_DATA_SOURCES` or `.runx/data-sources.json`; do not add provider branches to
the domain skill.

## What this skill does

- Reads data through named queries or read operations declared by a data-source
  adapter.
- Appends state transitions with idempotency keys and expected versions.
- Reads projections, event streams, or bounded latest-stream-head pages so
  loops can resume from explicit state without exporting full history.
- Produces receipt-bound evidence for data source, resource, operation, params,
  row/event limits, versions, and output digests.
- Keeps product semantics outside the data layer. Messageboards, CRMs, billing
  ledgers, and support desks define their own events and reducers.
- Ships a fixture adapter (`data.local`), durable local SQLite adapter
  (`data.sqlite`), and Redis adapter (`data.redis`) behind the same operation
  envelope.

## When to use this skill

- A graph needs durable state between turns, such as queue position, board
  state, sync cursor, review status, or approval inbox state.
- A skill must query a bounded slice of product data before deciding the next
  action.
- A workflow needs to append an auditable event or effect transition with
  optimistic concurrency.
- An operator wants one provider-agnostic shape that can later move from local
  JSON or SQLite to Postgres, Redis, D1, Supabase, Turso, DynamoDB, or another
  store.

## When not to use this skill

- To let a model write arbitrary SQL, Redis commands, or database migrations.
- To export broad data sets, secrets, raw PII, or unrestricted tables.
- To hide product decisions in storage code. Domain skills still own state
  machines, acceptance criteria, and business rules.
- To treat a projection as independent truth when the event stream or receipt
  chain is available and required for review.
- To bypass payment, send, deploy, moderation, or human approval gates.

## Procedure

1. Identify the domain skill and transition first. The data store is a carrier,
   not the policy owner.
2. Select the logical data source. Use `data_source_ref` to name the project or
   tenant source; let the project binding choose the adapter. Do not put raw
   database URLs, provider credentials, or SQL in the skill input.
3. Select a declared operation: named read query, append event, read events,
   read projection, or list stream heads. Do not synthesize raw provider
   commands.
4. Check authority. Reads need the narrow resource/query scope; writes need the
   transition scope, idempotency key, and expected version unless the operation
   is explicitly append-only without concurrency.
5. Bind typed params. Enforce row/event limits, tenant/partition keys, and
   redaction rules before the adapter runs.
6. For writes, use optimistic concurrency and idempotency. A retry with the same
   idempotency key and same payload returns the existing effect; a different
   payload under the same key is a conflict.
7. Return the operation result with resource refs, version movement, digests,
   redaction notes, and stop conditions. Receipts should link this data effect
   to the domain transition that caused it.

## Edge cases and stop conditions

- `needs_source`: the data source, resource, query name, tenant key, or schema
  summary is missing.
- `needs_input`: required operation params are incomplete, malformed, or not
  specific enough to bind a declared data-source operation.
- `needs_authority`: the caller lacks the declared read/write scope or provider
  grant.
- `needs_version`: a mutating operation lacks `expected_version` where the data
  source requires optimistic concurrency.
- `conflict`: the current version differs from `expected_version`, or an
  idempotency key is reused with different content.
- `too_broad`: the requested read lacks partition filters, exceeds limits, or
  asks for raw export.
- `redaction_required`: the operation would return secrets, private PII, or
  fields outside the declared projection.
- `provider_unavailable`: the adapter cannot reach the data source, times out,
  or cannot prove whether a write committed.

## Output schema

All runners return `runx.data.operation_result.v1`:

```json
{
  "schema": "runx.data.operation_result.v1",
  "data_source_ref": "local://example",
  "provider": "local-json-event-store",
  "operation": "append_event",
  "resource": "board_events",
  "aggregate_id": "posting-123",
  "status": "committed",
  "before_version": 0,
  "after_version": 1,
  "idempotency_key": "posting-123:create",
  "event_ref": "board_events:posting-123:1",
  "result_digest": "sha256:...",
  "projection_digest": "sha256:...",
  "rows": [],
  "events": [],
  "redactions": [],
  "stop_conditions": []
}
```

Provider adapters may add provider evidence under `provider_evidence`, but they
must not expose credentials or raw secret material.

For event streams, adapters derive a readable `event_type` in this order:
explicit `event.type`, explicit `event.event_type`, then
`event.effect_family + "." + event.operation`. Domain skills that emit the
generic `runx.effect.transition.v1` packet should include `effect_family` and
`operation` on every event so readback projections say `messageboard.accept`,
`business_ops.route`, or another meaningful transition instead of `data.event`.

## Worked example

A messageboard skill decides that `posting.claimed` is allowed. It emits a
domain transition packet. The graph then calls `data-store.append_event` with
resource `board_events`, aggregate id `posting-123`, expected version `2`, and
idempotency key `posting-123:claim:agent-9`. The data adapter appends the event
only if the stream is still at version `2`. The receipt proves the decision,
the data operation, and the new version. A later loop turn calls
`data-store.read_events` or `read_projection` to resume from the explicit board
state.

## Inputs

- `data_source_ref` (required): stable logical ref for the data source. The
  project or hosted binding maps this ref to the concrete adapter and provider
  profile.
- `resource` (required): declared resource, stream, table, keyspace, or
  projection name.
- `operation` (required for tool-level use): `append_event`, `read_events`,
  `read_projection`, or `list_stream_heads`.
- `aggregate_id` (required for event operations): stream or partition key.
- `event` (required for `append_event`): domain event or transition packet.
- `idempotency_key` (required for writes): stable retry key.
- `expected_version` (required when the source enforces concurrency): current
  stream/resource version expected by the caller.
- `limit` (optional): maximum rows or events to return.
- `after_version` (optional for `read_events`): return an ascending page whose
  event versions are strictly greater than this value. Omit it to retain the
  existing latest-tail read. Compare the last returned event version with
  `after_version` in the result envelope to know whether another page remains.
- `event_types` (optional for `list_stream_heads`): at most 20 exact latest
  event types. No pattern or arbitrary field queries are accepted.
- `cursor` (optional for `list_stream_heads`): opaque cursor returned by the
  previous page. Limits are capped at 100.
- `store_id` (local fixture adapter only): deterministic local store id that
  opts into the bundled `data.local` proof adapter. Omit it for durable local
  SQLite. Production adapters should ignore it.

## Invocation examples

Durable local dogfood with the bundled default:

```bash
runx skill data-store append_event \
  -i data_source_ref=local://runx-data-store/dev-board \
  -i resource=board_events \
  -i aggregate_id=posting-123 \
  --input-json expected_version=0 \
  -i idempotency_key=posting-123:create:v1 \
  --input-json event='{"type":"posting.created","payload":{"title":"verify a receipt link"}}' \
  --json
```

Fixture-only dogfood can still use `store_id` to select the JSON fixture store:

```bash
runx skill data-store append_event \
  -i data_source_ref=local://runx-data-store/dev-board \
  -i store_id=dev-board \
  -i resource=board_events \
  -i aggregate_id=posting-123 \
  --input-json expected_version=0 \
  -i idempotency_key=posting-123:create:v1 \
  --input-json event='{"type":"posting.created","payload":{"title":"fixture proof"}}' \
  --json
```

Production graph shape is the same at the skill boundary:

```bash
runx skill data-store append_event \
  -i data_source_ref=tenant://acme/board \
  -i resource=board_events \
  -i aggregate_id=posting-123 \
  --input-json expected_version=2 \
  -i idempotency_key=posting-123:claim:agent-9 \
  --input-json event='{"type":"posting.claimed","payload":{"actor":"agent-9"}}' \
  --json
```

The second command only works once `tenant://acme/board` is bound to an
installed provider adapter. That binding is operator configuration and may name a
credential profile or hosted grant; it must not carry raw secrets.

Project-specific SQLite uses the same command shape after binding the source:

```json
{
  "data_sources": {
    "tenant://acme/board": {
      "adapter": "data.sqlite",
      "database_path": ".runx/data/acme-board.sqlite",
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

Pass that document through `RUNX_DATA_SOURCES` or `.runx/data-sources.json`.

Redis uses the same skill and graph inputs. Only the binding changes:

```json
{
  "data_sources": {
    "tenant://acme/board": {
      "adapter": "data.redis",
      "endpoint": "redis://127.0.0.1:6379/0",
      "key_prefix": "runx:{acme-board}",
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

The Redis endpoint must not embed credentials. Use local unauthenticated Redis
for OSS dogfood, or put production secrets behind a runx credential profile or
hosted grant. For Redis Cluster, the binding's `key_prefix` must contain one
safe hash tag, such as `{acme-board}`, so the stream, idempotency, and head keys
touched by an append share one slot and update atomically. Stream-head pages use
stable keyset cursors rather than mutable offsets. Durable events and
dispositions must not receive TTLs; production Redis should enable persistence
and use a non-evicting policy.

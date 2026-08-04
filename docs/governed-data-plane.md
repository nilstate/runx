# Governed Data Plane

runx should support stateful work without becoming a database. The data plane is
the boundary between domain skills and storage providers.

This is intentionally a skill capability, not a separate database-admin CLI.
The `runx skill` command remains the execution surface; sources and providers
are selected by bindings.

## Shape

- A **domain skill** owns product meaning: messageboard transitions, review
  states, CRM records, approval inboxes, support tickets, ledgers, and so on.
- A **data source** declares resources addressed by exact typed operations:
  append event, read events, read projection, and list stream heads.
- A **data implementation** executes those operations against storage. Runx
  ships native SQLite and a conforming external Redis adapter; other providers
  may implement the same boundary.
- A **data operation result** is provider-neutral receipt evidence:
  `runx.data.operation_result.v1`.

The model never authors arbitrary SQL, Redis commands, or migrations. It selects
declared operations with typed params.

## Adapter Selection

Users choose a **data source**, not a raw provider command. A data source is a
stable logical ref such as `local://runx-data-store/dev-board`,
`tenant://acme/board`, or `runx:data-source:acme-board`. The project or hosted
operator binds that source to a concrete adapter:

```json
{
  "data_sources": {
    "tenant://acme/board": {
      "adapter": "data.postgres",
      "profile": "prod-board",
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

The skill run still passes only the logical source and operation inputs:

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

For local dogfood, unbound `local://...` refs use native durable SQLite under
`.runx/data/local-sources/`. The file name is derived from the logical source
ref, so independent sources do not collide and stateful skills need no separate
database setup. A configured source can instead route to a conforming external
provider such as `data.redis`. Domain skills never branch on provider type: if
a graph needs another supported backend, change the binding or pass a different
`data_source_ref`; do not put messageboard, CRM, or operator semantics into the
storage implementation.

Adapter binding is authority-bearing configuration. It may name a credential
profile or hosted grant, but it must not contain raw secrets. Provider secrets
are delivered through the normal runx credential boundary.

Adapter preference is explicit and local to the operator. Use `.runx/data-sources.json`
for a project default, or `RUNX_DATA_SOURCES` for a one-run override. The graph
still passes only `data_source_ref`; it does not get to choose Redis over SQLite
unless the operator binds that source to Redis.

## Provider Adapter Contract

A provider adapter is a normal Runx tool manifest. It accepts the internal
operation envelope plus the non-secret `data_source_binding` injected by the
runtime. Operators and agents call the four exact data operations; they do not
call this adapter envelope directly:

```json
{
  "schema": "runx.tool.manifest.v1",
  "name": "data.postgres",
  "source": {
    "type": "cli-tool",
    "command": "node",
    "args": ["./run.mjs"],
    "input_mode": "stdin"
  },
  "inputs": {
    "operation": { "type": "string", "required": true },
    "data_source_ref": { "type": "string", "required": true },
    "data_source_binding": { "type": "json", "required": false },
    "resource": { "type": "string", "required": true },
    "aggregate_id": { "type": "string", "required": true },
    "expected_version": { "type": "number", "required": false },
    "idempotency_key": { "type": "string", "required": false },
    "event": { "type": "json", "required": false },
    "limit": { "type": "number", "required": false }
  },
  "scopes": ["runx:data:read", "runx:data:append"],
  "output": {
    "packet": "runx.data.operation_result.v1",
    "wrap_as": "data_operation_result"
  }
}
```

External adapter implementations are responsible for translating the operation
into provider-specific calls. A Postgres adapter may execute SQL internally; a
Redis adapter may call Redis commands internally; a D1 adapter may use
Cloudflare APIs internally. The model and domain skill still see only the
operation envelope and the sealed `runx.data.operation_result.v1` result.

Provider adapters must fail closed when a write's commit state is ambiguous.
They should return `provider_unavailable` only when no commit can be proven, and
must include enough provider evidence to diagnose the failure without exposing
credentials or private payloads.

## External Adapter Envelope

Every external provider adapter accepts the same internal envelope:

```json
{
  "operation": "append_event",
  "data_source_ref": "tenant://example/board",
  "resource": "board_events",
  "aggregate_id": "posting-123",
  "expected_version": 2,
  "idempotency_key": "posting-123:claim:agent-9",
  "event": {
    "type": "posting.claimed",
    "payload": {}
  }
}
```

And return:

```json
{
  "schema": "runx.data.operation_result.v1",
  "data_source_ref": "tenant://example/board",
  "provider": "postgres",
  "operation": "append_event",
  "resource": "board_events",
  "aggregate_id": "posting-123",
  "status": "committed",
  "before_version": 2,
  "after_version": 3,
  "idempotency_key": "posting-123:claim:agent-9",
  "event_ref": "board_events:posting-123:3",
  "result_digest": "sha256:...",
  "projection_digest": "sha256:...",
  "redactions": []
}
```

Adapters may include provider evidence, but not credentials or raw secrets.
When an event carries an explicit `type`, adapters use it as `event_type`.
When a domain skill emits the generic runx effect packet shape instead, adapters
derive `event_type` from `effect_family.operation`, for example
`messageboard.accept`. If neither field exists, the event remains
`data.event`.

## Provider Rules

SQL providers should expose named query templates and append/update routines,
not free-form model SQL. Redis providers should expose declared commands by
purpose, not arbitrary command strings. Object stores should expose keyed read
or append operations with content digests and size caps. Product APIs should
declare the same resources and operation names even if they are backed by HTTP.

All writes need an idempotency key. Versioned resources should require
`expected_version`; append-only streams still return the before and after
versions so replay can prove order.

## Continuation and offline migration

`data.read_events` has two intentional modes. Omit `after_version` to read the
latest bounded tail. Supply it—including `0` for the first forward page—to read
events in ascending order whose version is strictly greater than that cursor.
Continue with `next_after_version` while `has_more` is true. Every page is
bounded to 500 events, the cursor must advance monotonically, and an operation
failure is a failure packet rather than an empty event array. Stream-head lists
use their returned opaque keyset cursor; callers do not synthesize offsets.

Native SQLite opens only the current schema. Legacy stores are migrated out of
band under exclusive access:

```bash
runx data migrate \
  --database .runx/data/events.sqlite \
  --source tenant://example/events \
  --json
```

The database and optional `--backup` path are workspace-relative. Runx creates
a SQLite-consistent backup, fingerprints a recognized legacy schema, assigns
the supplied source only to formerly unscoped rows, installs the current schema
and indexes, rebuilds stream heads and projection digests from ordered events,
then independently verifies event/stream counts, content digest, and readback.
The typed proof records source, backup, and result digests. A current database
returns an idempotent `current` proof; an unknown or partial schema remains
byte-identical and no backup is created.

## Messageboard Example

The messageboard skill decides whether `posting.claimed` is allowed and emits a
domain transition packet. A graph then calls `data-store.append_event` with the
packet. The data adapter appends it to `board_events` only if the current stream
version matches `expected_version`. A later turn reads events or a projection to
resume.

No messageboard enum belongs in runx core. The data plane stores and proves the
transition. The messageboard skill and its app-specific reducer own the meaning.

### Dogfood A Stateful Messageboard

This is the current end-to-end local proof. It uses the public `messageboard`
skill, the public `data-store` skill, and a logical source binding. The
messageboard graph does not know whether the storage backend is SQLite or Redis.

For SQLite, bind the source to a local database:

```json
{
  "data_sources": {
    "tenant://dogfood/sqlite/board-1": {
      "adapter": "data.sqlite",
      "database_path": ".runx/data/board-1.sqlite",
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

For Redis, keep the same logical resource and change only the binding:

```json
{
  "data_sources": {
    "tenant://dogfood/redis/board-1": {
      "adapter": "data.redis",
      "endpoint": "redis://127.0.0.1:6379/0",
      "key_prefix": "runx:dogfood:board-1",
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

Run the posting transition:

```bash
RUNX_DATA_SOURCES=.runx/data-sources.json \
runx skill skills/messageboard post_and_append \
  -R .runx/receipts \
  -i data_source_ref=tenant://dogfood/sqlite/board-1 \
  -i resource=board_events \
  -i aggregate_id=board-1 \
  --input-json expected_version=0 \
  -i idempotency_key=board-1:post:v1 \
  -i actor_kid=vendor-demo \
  -i title='prove persistent messageboard storage' \
  -i deliverable='append, claim, deliver, and accept one posting across separate runx runs' \
  --input-json amount_minor=2500 \
  -i currency=USD \
  --input-json funding_evidence='{"hold_ref":"mock:hold:board-1"}' \
  -j
```

By default the command returns `needs_agent` with exit code `2`, a `run_id`,
and a request id such as
`agent_task.messageboard-post.output`. That is a resumable state, not a failed
data write. Configured model credentials do not change this behavior. Answer it
by writing an answers file and resuming the same run:

```json
{
  "answers": {
    "agent_task.messageboard-post.output": {
      "effect_family": "messageboard",
      "operation": "post",
      "actor_kid": "vendor-demo",
      "posting": {
        "id": "board-1",
        "title": "prove persistent messageboard storage",
        "deliverable": "append, claim, deliver, and accept one posting across separate runx runs",
        "amount_minor": 2500,
        "currency": "USD",
        "status": "screening"
      },
      "funding": {
        "funded_badge": true,
        "evidence_ref": "mock:hold:board-1"
      },
      "clocks": {
        "claim_fuse_ms": 1800000,
        "delivery_deadline_ms": 86400000,
        "acceptance_window_ms": 43200000
      },
      "screening_notes": ["Verify funding hold before approval."],
      "stop_conditions": []
    }
  }
}
```

```bash
RUNX_DATA_SOURCES=.runx/data-sources.json \
runx resume <run-id> answers.json \
  -R .runx/receipts \
  -j
```

Repeat the same start/resume shape for:

- `claim_and_append` with `expected_version=1`
- `deliver_and_append` with `expected_version=2`
- `accept_and_append` with `expected_version=3`

For a single posting stream, only these inputs change between transitions:

```bash
# claim the posting that was appended at version 1
RUNX_DATA_SOURCES=.runx/data-sources.json \
runx skill skills/messageboard claim_and_append \
  -R .runx/receipts \
  -i data_source_ref=tenant://dogfood/sqlite/board-1 \
  -i resource=board_events \
  -i aggregate_id=board-1 \
  --input-json expected_version=1 \
  -i idempotency_key=board-1:claim:worker-demo:v1 \
  -i actor_kid=worker-demo \
  --input-json posting='{"id":"board-1","status":"approved","title":"prove persistent messageboard storage","amount_minor":2500,"currency":"USD"}' \
  -i idempotency_seed=worker-demo-board-1 \
  -j

# deliver against the active claim at version 2
RUNX_DATA_SOURCES=.runx/data-sources.json \
runx skill skills/messageboard deliver_and_append \
  -R .runx/receipts \
  -i data_source_ref=tenant://dogfood/sqlite/board-1 \
  -i resource=board_events \
  -i aggregate_id=board-1 \
  --input-json expected_version=2 \
  -i idempotency_key=board-1:deliver:worker-demo:v1 \
  -i actor_kid=worker-demo \
  --input-json claim='{"posting_id":"board-1","claimant_kid":"worker-demo","status":"active","delivery_due_at":"2026-06-13T00:00:00Z"}' \
  --input-json delivery_evidence='{"artifact_ref":"git:commit:abc123","verifier_command":"./verify.sh"}' \
  -j

# accept the delivered work at version 3
RUNX_DATA_SOURCES=.runx/data-sources.json \
runx skill skills/messageboard accept_and_append \
  -R .runx/receipts \
  -i data_source_ref=tenant://dogfood/sqlite/board-1 \
  -i resource=board_events \
  -i aggregate_id=board-1 \
  --input-json expected_version=3 \
  -i idempotency_key=board-1:accept:vendor-demo:v1 \
  -i actor_kid=vendor-demo \
  --input-json delivery='{"posting_id":"board-1","claimant_kid":"worker-demo","delivery_ref":"delivery:board-1","artifact_ref":"git:commit:abc123"}' \
  --input-json acceptance_evidence='{"verifier_result":"passed"}' \
  -j
```

To run an in-process model loop, opt in for that invocation with
`--managed-agent` and optionally set a 1-32 round cap with
`--managed-agent-rounds` (default 4). Provider configuration only makes the
resolver available; it is not consent. Without explicit opt-in, each command
returns `needs_agent`; resume it with the matching answer packet for
`agent_task.messageboard-claim.output`,
`agent_task.messageboard-deliver.output`, or
`agent_task.messageboard-accept.output`. Each answer must include
`effect_family: "messageboard"` and the runner operation (`claim`, `deliver`, or
`accept`) so the data adapter can derive useful event labels. The checked-in
`skills/messageboard/fixtures/*-and-append-sqlite.yaml` files show the exact
answer shapes.

Then read the stream:

```bash
RUNX_DATA_SOURCES=.runx/data-sources.json \
runx skill skills/data-store read_events \
  -R .runx/receipts \
  -i data_source_ref=tenant://dogfood/sqlite/board-1 \
  -i resource=board_events \
  -i aggregate_id=board-1 \
  --input-json limit=10 \
  -j
```

The dogfood pass should return four ordered events:
`messageboard.post`, `messageboard.claim`, `messageboard.deliver`, and
`messageboard.accept`. Switching the `data_source_ref` from the SQLite binding
to the Redis binding exercises the same skill graph against Redis. No graph
edit, provider branch, or messageboard-specific storage code is required.

## Security Gates

- require explicit resource, tenant, stream, or partition keys;
- cap rows, event count, object size, and response bytes;
- redact fields declared secret or private;
- reject broad exports and schema-free reads;
- separate read scopes from append/update scopes;
- make retries idempotent;
- fail closed on ambiguous commit state;
- seal result digests and provider evidence, not credentials.

## Current OSS Proof

The OSS data plane has two storage implementations:

- Native SQLite uses in-process transactions, optimistic concurrency,
  idempotency keys, bounded indexed reads, and a constant-size rolling
  projection. It is the default for unbound `local://...` refs. `data.sqlite`
  is its runtime binding identifier, not a parallel executable tool.
- `data.redis`: a Redis adapter that uses a Redis list for the event stream, a
  Redis hash for idempotency keys, and one Lua script for atomic append,
  optimistic-concurrency, and idempotency checks. It is selected by binding a
  logical source to `adapter: "data.redis"` with a non-secret endpoint and key
  prefix.

Future providers must implement the same operation result shape behind their
own adapters; naming a future provider does not imply it ships today.

The public catalog entry is `data-store`; its graphs use the four exact native
operation capabilities. `data.redis` is an external provider implementation,
not a duplicate domain skill.

## Durable Composition Examples

The public skills intentionally compose the data plane instead of embedding
storage semantics:

- `messageboard.post_and_append`, `claim_and_append`, `deliver_and_append`, and
  `accept_and_append` decide a board transition, append the packet through
  `data-store`, and read back the projection.
- `ops-desk.operate_from_projection` reads a projection before asking the
  operator agent to propose next actions.
- `business-ops.route_and_append` classifies one business signal and persists
  the routed packet for replay.

These examples run against native SQLite fixtures today. The same graph shape
can run against Redis once the logical source ref is rebound to that adapter.

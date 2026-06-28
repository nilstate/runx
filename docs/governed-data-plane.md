# Governed Data Plane

runx should support stateful work without becoming a database. The data plane is
the boundary between domain skills and storage providers.

This is intentionally a skill capability, not a separate database-admin CLI.
The `runx skill` command remains the execution surface; sources and providers
are selected by bindings.

## Shape

- A **domain skill** owns product meaning: messageboard transitions, review
  states, CRM records, approval inboxes, support tickets, ledgers, and so on.
- A **data source** declares resources and operations: named reads, append
  events, read events, read projections, compare-and-set, or provider-specific
  bounded commands.
- A **data adapter** executes those operations against one provider: Postgres,
  SQLite, D1, Redis, DynamoDB, S3, Supabase, Turso, product HTTP APIs, or local
  JSON fixtures.
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

For local dogfood, the bundled `data-store` proof uses the checked-in
`data.source` resolver. Unbound `local://...` refs default to the durable
`data.sqlite` adapter under `.runx/data/local-sources/`, with the file name
derived from the logical source ref, so stateful skills work without a separate
database setup and independent sources do not collide. Pass `store_id` only
when a fixture intentionally wants the checked-in `data.local` JSON store. For
production, install or configure a provider adapter such as `data.postgres`,
`data.d1`, `data.redis`, or `data.object`, then bind the same logical
`data_source_ref` to that adapter. Domain skills should not branch on provider
type. If a graph needs a different storage backend, change the binding or pass
a different `data_source_ref`; do not edit messageboard, CRM, or operator
semantics into runx core.

Adapter binding is authority-bearing configuration. It may name a credential
profile or hosted grant, but it must not contain raw secrets. Provider secrets
are delivered through the normal runx credential boundary.

Adapter preference is explicit and local to the operator. Use `.runx/data-sources.json`
for a project default, or `RUNX_DATA_SOURCES` for a one-run override. The graph
still passes only `data_source_ref`; it does not get to choose Redis over SQLite
unless the operator binds that source to Redis.

## Provider Adapter Contract

A provider adapter is a normal runx tool manifest. It should declare inputs for
the generic operation envelope and may optionally declare `data_source_binding`
if it needs non-secret profile/resource metadata from the resolver:

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

Adapter implementations are responsible for translating the declared operation
into provider-specific calls. A Postgres adapter may execute SQL internally; a
Redis adapter may call Redis commands internally; a D1 adapter may use
Cloudflare APIs internally. The model and domain skill still see only the
operation envelope and the sealed `runx.data.operation_result.v1` result.

Provider adapters must fail closed when a write's commit state is ambiguous.
They should return `provider_unavailable` only when no commit can be proven, and
must include enough provider evidence to diagnose the failure without exposing
credentials or private payloads.

## Operation Envelope

Every provider adapter should accept the same conceptual envelope:

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

With no managed-agent provider configured, the command returns `needs_agent`
with exit code `2`, a `run_id`, and a request id such as
`agent_task.messageboard-post.output`. That is a resumable state, not a failed
data write. Answer it by writing an answers file and resuming the same run:

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

If a managed-agent provider is configured, those commands can seal directly.
Without one, each command returns `needs_agent`; resume it with the matching
answer packet for `agent_task.messageboard-claim.output`,
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

`skills/data-store` ships three adapters:

- `data.sqlite`: a durable local adapter that uses SQLite transactions,
  optimistic concurrency, idempotency keys, and readback projections. It is the
  first real provider-shaped proof and the default for unbound `local://...`
  refs. Streams are keyed by `data_source_ref`, resource, and aggregate id.
- `data.local`: a local JSON fixture adapter for deterministic harnesses and
  contract tests. It is selected by passing `store_id`, not by normal local
  dogfood.
- `data.redis`: a Redis adapter that uses a Redis list for the event stream, a
  Redis hash for idempotency keys, and one Lua script for atomic append,
  optimistic-concurrency, and idempotency checks. It is selected by binding a
  logical source to `adapter: "data.redis"` with a non-secret endpoint and key
  prefix.

Postgres, D1, object-store, hosted, and product API providers should implement
the same operation result shape behind their own adapters.

The public catalog entry is still `data-store`. Bundled provider tools such as
`data.sqlite` and `data.redis` are surfaced as adapters behind that canonical
skill, not as duplicate domain skills.

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

These examples all run against `data.sqlite` fixtures today. The same graph
shape can run against Redis, Postgres, D1, or a product API once the logical
source ref is rebound to that adapter.

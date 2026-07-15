# data.redis

`data.redis` is the Redis provider adapter for the `data-store` operation
envelope. It is intentionally not a separate domain skill: messageboards,
operator desks, sync cursors, and business workflows keep their semantics in
their own skills, while this adapter supplies the storage backend.

## Binding

Bind a logical source to Redis with non-secret project configuration:

```json
{
  "data_sources": {
    "tenant://acme/board": {
      "adapter": "data.redis",
      "endpoint": "redis://127.0.0.1:6379/0",
      "key_prefix": "runx:acme:board",
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

Pass the document through `RUNX_DATA_SOURCES` or write it to
`.runx/data-sources.json`. The endpoint must not embed credentials. Use a local
unauthenticated Redis for OSS dogfood, or put provider credentials behind the
normal runx credential boundary when a hosted/production adapter supplies secret
delivery.

## Requirements

- `redis-cli` on `PATH`, or set `RUNX_REDIS_CLI_BIN`.
- A reachable `redis://` or `rediss://` endpoint.

Live conformance tests run only when `RUNX_REDIS_URL` is set and responds to
`PING`, so normal CI does not require Redis.

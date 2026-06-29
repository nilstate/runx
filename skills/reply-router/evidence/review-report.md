# reply-router Review Report

## Scope

- Package: `reply-router`
- Version: `0.1.0`
- Runtime: runx CLI `0.6.14`
- Default runner: `route`
- Runner type: `graph`

## What The Skill Does

- Validates that `original_send_receipt` is sealed and carries a `sha256:` checksum.
- Classifies `inbound_reply.content` against `suppression_policy.unsubscribe_signals`.
- For a clear unsubscribe reply, emits an append-only suppression event targeting `registry:runx/data-store@0.1.2`.
- Uses `aggregate_id` as the recipient key and `expected_version` from `store_projection.version`.
- Emits a deterministic idempotency key derived from receipt id, recipient, and reply content.
- For normal replies, emits `runx.reply.routing.v1` and names a separate governed send-as lane.
- For ambiguous text or unsealed original send receipts, stops in a human review lane.

## Required Harness Cases

- `sealed_unsubscribe_suppression`: sealed receipt plus unsubscribe text routes to `append_suppression`.
- `stop_ambiguous_or_unsealed`: unsealed receipt blocks to `needs_agent` and writes nothing.

## Local Validation

- `node skills/reply-router/classify.mjs` with the sealed unsubscribe fixture returned `route=suppress` and `classification.type=unsubscribe`.
- `node skills/reply-router/append_event.mjs` with the same fixture plus classification returned an `append_event` call with `before_version=7` and `after_version=8`.
- `node skills/reply-router/classify.mjs` with the unsealed fixture returned `route=needs_agent`.

## Host Limitation

This Windows host cannot complete signed runx receipt-store writes with runx CLI
`0.6.14`: the same `receipt store is unreadable: os error 87` occurs for this
package and the official `examples/hello-world` harness after receipt signing is
enabled. The package keeps the graph runner and inline harness intact so hosted
Linux verification can replay the default path.

## Safety Review

- No network calls.
- No hidden credentials.
- No send action.
- No suppression without matched unsubscribe evidence.
- No route when the original send receipt is unsealed.
- No mutable local state outside emitted runx artifacts.

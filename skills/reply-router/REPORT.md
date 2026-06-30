# Reply Router Bounty Report

## What was built

- Added `skills/reply-router` as a public runx skill with a default `route_reply` agent-task runner.
- Added typed inputs for inbound reply content, original send receipt, suppression policy, recipient stream coordinates, optimistic concurrency, and idempotency.
- Added typed outputs for `classification`, `suppression_result`, `routing_decision`, and `escalation_lane`.
- Added inline harness coverage for sealed unsubscribe suppression, sealed interested routing, and ambiguous/unsealed stop behavior.

## Behavioral boundaries

- Unsubscribe replies emit a ready-to-append suppression packet with the recipient aggregate, expected version, idempotency key, and `reply.unsubscribe_suppressed` event payload.
- Interested replies emit a bounded `runx.reply.routing.v1` packet naming a later governed `send-as` run.
- The skill never sends a message or mutates a provider directly.
- Ambiguous replies or unsealed original send receipts stop with `needs_agent`.

## Verification

- `runx-cli 0.6.14` is available through `npx.cmd -y @runxhq/cli@0.6.14`.
- `runx skill inspect ./skills/reply-router route_reply --json` passes with status `ok`.
- Local Windows harness and registry publish are blocked by the native sealed receipt store error `os error 87` while syncing the receipt directory.
- The blocker is environmental to this Windows host; the skill package itself parses and inspects successfully.

---
name: reply-router
description: Classify inbound replies to governed sends, durably suppress recipients who explicitly unsubscribe, route ordinary replies without sending, and stop ambiguous or untrusted cases for review.
links:
  source: https://github.com/runxhq/runx/tree/main/skills/reply-router
  repository: https://github.com/runxhq/runx
runx:
  category: growth
---

# Reply Router

`reply-router` turns a bounded inbound reply into exactly one governed outcome:

1. an explicit unsubscribe tied to a sealed original-send receipt is appended to
   a recipient-keyed suppression stream;
2. an ordinary reply becomes a routing decision for a separate governed lane;
3. an ambiguous reply, mismatched recipient, or unsealed receipt stops with
   `needs_agent`.

It never sends a message. A routed reply names `send-as` as a possible downstream
governed action, but this skill neither invokes it nor grants sending authority.

## Inputs

- `inbound_reply` — JSON with a stable `reply_id`, sender (`from.address` or
  `from`), body, and optional subject/timestamp.
- `original_send_receipt` — the `runx.receipt.v1` produced by the original
  governed send. Suppression requires `status: sealed`, a checksum, a principal,
  a send plan, and an audience that matches the inbound sender.
- `suppression_policy` — declared unsubscribe phrases and the suppression data
  source. `data_source_ref` and `resource` may be supplied; conservative defaults
  are used otherwise.

## Outcomes

### Explicit unsubscribe

The deterministic classifier requires a sealed, checksummed original-send
receipt and an exact recipient match. The graph then:

1. reads the recipient-keyed stream with
   `registry:runx/data-store@0.1.2`;
2. takes `projection.version` from that read;
3. calls the same pinned skill's `append_event` runner with that value as
   `expected_version` and a stable idempotency key; and
4. emits a `runx.reply.routing.v1` suppression result containing the committed
   data-operation evidence.

Only a digest-derived recipient aggregate id is stored; the event contains no
raw reply body or recipient address.

### Ordinary reply

The skill emits a `runx.reply.routing.v1` handoff decision. It identifies the
queue and a separate governed action family, but performs no network or send
side effect.

### Ambiguous or untrusted reply

The graph enters an operator `agent-task`. Without an explicit caller answer the
receipt seals as `needs_agent`. No data-store step or routing-result step runs on
this branch.

## Deterministic policy

- Phrase matching is normalized and boundary-aware; substrings such as
  `unstoppable` do not count as `stop`.
- `stop` by itself is deliberately ambiguous unless an operator has explicitly
  included it in `suppression_policy.unsubscribe_phrases`.
- Receipt shape, sealed status, checksum, principal, send plan, reply id, and
  recipient correspondence are checked before suppression is allowed.
- Idempotency keys are derived from receipt id, reply id, and recipient digest,
  making retries stable without exposing recipient data.

## Harness

The inline harness contains the required cases:

- `sealed_unsubscribe_suppression` must seal after a real read-then-CAS append;
- `stop_ambiguous_or_unsealed` must return `needs_agent`, with no write and no
  routing decision.

Run it with runx CLI 0.6.14 or newer:

```bash
runx harness ./skills/reply-router --json
```

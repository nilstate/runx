---
name: reply-router
description: Classify inbound replies against a suppression policy, emit durable suppression packets, and produce bounded routing decisions without sending.
runx:
  category: ops
---

# Reply Router

Reply Router handles inbound replies to previously governed outbound sends. It
protects the compliance boundary: an unsubscribe reply becomes a ready-to-append
recipient-keyed suppression packet, while non-unsubscribe replies produce only a
typed routing decision for a separate governed `send-as` run.

## Quality Profile

- Purpose: prevent missed suppressions and keep reply follow-up routing separate
  from the act of sending.
- Audience: operators running outreach, lifecycle, support, or sales workflows
  that need a replayable reply decision before any next send.
- Artifact contract: emit `classification`, optionally emit a
  `reply.unsubscribe_suppressed` suppression result packet with CAS inputs, and
  optionally emit a `runx.reply.routing.v1` routing decision that names a
  downstream governed `send-as` run.
- Evidence bar: every suppression or route must cite reply text, the sealed
  original send receipt, the suppression policy signal, and the prior recipient
  projection.
- Stop conditions: unsealed original receipt, ambiguous reply intent, missing
  suppression policy, policy confidence below threshold, missing recipient
  aggregate, unreadable prior suppression state, or any attempt to send from this
  skill.

## Runner

`route_reply` is the default agent-task runner.

It performs one bounded classification and packet-authoring act:

1. Classify the reply using only the supplied reply, sealed original send
   receipt, policy, and recipient stream coordinates.
2. For unsubscribe intent, emit a `runx.data.operation_result.v1` packet with
   `operation: append_event`, `expected_version`, `idempotency_key`, and the
   `reply.unsubscribe_suppressed` event payload.
3. For follow-up intent, emit a bounded `runx.reply.routing.v1` packet naming a
   downstream governed `send-as` run.
4. For ambiguity or unsealed receipts, stop with `needs_agent`.

The runner never sends a follow-up. For interested, objection, out-of-office, or
wrong-person replies, the output is a routing decision naming a separate
governed `send-as` run that a downstream driver or operator must issue.

## Inputs

- `inbound_reply` (required): object with `content`, `received_from`, and
  `received_at`.
- `original_send_receipt` (required): object with `send_plan`, `principal`,
  `receipt_id`, `checksum`, and `sealed`.
- `suppression_policy` (required): object with `unsubscribe_signals` and
  `confidence_threshold`.
- `data_source_ref` (required): logical data source for suppression events.
- `store_id` (optional): deterministic local fixture store id for downstream
  data-store replay.
- `resource` (optional): suppression event resource, defaults to
  `reply_suppressions`.
- `aggregate_id` (required): recipient aggregate id, for example
  `recipient:buyer@example.com`.
- `expected_version` (required): stream version read before append.
- `idempotency_key` (required): stable key derived from recipient, original send,
  and classification.

## Output Schema

For unsubscribe replies:

```json
{
  "classification": {
    "type": "unsubscribe",
    "confidence": 0.98,
    "evidence": ["Reply text contains unsubscribe."]
  },
  "suppression_result": {
    "aggregate_id": "recipient:buyer@example.com",
    "idempotency_key": "recipient:buyer@example.com:seq-001:unsubscribe:v1",
    "before_version": 0,
    "after_version": 1
  },
  "routing_decision": null
}
```

For routed replies:

```json
{
  "classification": {
    "type": "objection",
    "confidence": 0.86,
    "evidence": ["Reply asks about pricing."]
  },
  "routing_decision": {
    "schema": "runx.reply.routing.v1",
    "classification": "objection",
    "send_target": "send-as:reply-followup",
    "principal": "runx:principal:sales-ops"
  },
  "suppression_result": null
}
```

## Suppression Semantics

An unsubscribe classification must meet all of these conditions:

- The original send receipt is sealed.
- The reply text contains unsubscribe intent named by
  `suppression_policy.unsubscribe_signals`.
- The confidence is at or above `suppression_policy.confidence_threshold`.
- The suppression result names `append_event` with `aggregate_id` equal to the
  recipient entity, `expected_version`, and an idempotency key derived from
  recipient plus original send plus decision.
- No routing send target is emitted alongside the suppression.

The suppression packet is the compliance block a downstream data-store lane
commits and the next send preflight reads. Receipt history is evidence, not the
state store.

## Edge Cases And Stop Conditions

- `needs_receipt`: `original_send_receipt.sealed` is false or the receipt id is
  missing.
- `needs_policy`: suppression signals or threshold are missing.
- `ambiguous_reply`: the reply does not clearly match a suppression or routing
  class.
- `below_threshold`: matched signals exist but confidence is below the policy
  threshold.
- `needs_projection`: prior suppression state cannot be read.
- `conflict`: the suppression stream version no longer matches
  `expected_version`.
- `send_attempted`: any attempt to send from this skill is invalid; route by
  naming a downstream governed run instead.

## Harness

The inline harness covers:

- `sealed_unsubscribe_suppression`: a sealed unsubscribe classification emits a
  recipient suppression event packet with CAS coordinates.
- `sealed_interested_route`: a sealed interested reply emits a bounded routing
  packet and no suppression result.
- `stop_ambiguous_or_unsealed`: an ambiguous reply with an unsealed original
  receipt stops at `needs_agent` and performs no suppression write.

## Invocation

```bash
runx skill reply-router route_reply \
  --input-json inbound_reply='{"content":"unsubscribe me","received_from":"buyer@example.com","received_at":"2026-06-30T10:00:00Z"}' \
  --input-json original_send_receipt='{"send_plan":{"recipient":"buyer@example.com","sequence_id":"seq-001"},"principal":"runx:principal:sales-ops","receipt_id":"runx:receipt:sha256:sealed","checksum":"sha256:...","sealed":true}' \
  --input-json suppression_policy='{"unsubscribe_signals":["unsubscribe","opt out"],"confidence_threshold":0.8}' \
  -i data_source_ref=local://reply-router/demo \
  -i aggregate_id=recipient:buyer@example.com \
  --input-json expected_version=0 \
  -i idempotency_key=recipient:buyer@example.com:seq-001:unsubscribe:v1 \
  --json
```

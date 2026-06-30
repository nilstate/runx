---
name: reply-router
version: "0.1.0"
description: Classify inbound replies against a sealed send receipt, suppress unsubscribe replies through data-store CAS, and emit bounded routing decisions for safe follow-up.
---

# reply-router

`reply-router` is a dispatch-free reply classification skill for inbound responses to previously sent messages. It reads an inbound reply, the sealed original send receipt, and a suppression policy. It then either records an unsubscribe suppression event through a recipient-keyed data-store compare-and-set write, emits a typed routing decision for a later governed `send-as` run, or stops for human review.

The skill never sends mail, never mints an `AttenuationRequest`, and never emits an `operational_proposal` envelope. Any follow-up send is intentionally a separate governed run named in the routing packet, with its own approval and receipt.

## Inputs

- `data_source_ref`: data-store source reference for the reply suppression stream.
- `store_id`: optional local fixture store id for harness validation; omit it for durable adapter-backed stores.
- `resource`: suppression stream resource name.
- `aggregate_id`: recipient-keyed aggregate id, normally the reply sender or recipient identity.
- `expected_version`: stream version required before append.
- `idempotency_key`: stable retry key for the suppression event.
- `inbound_reply`: object with `content`, `received_from`, and `received_at`.
- `original_send_receipt`: object with `send_plan`, `principal`, `receipt_id`, `checksum`, and `sealed: true`.
- `suppression_policy`: object with `unsubscribe_signals` and `confidence_threshold`.

## Decision rules

- If the original send receipt is missing, unsealed, or lacks a receipt id/checksum, stop for human review and do not write.
- If reply text contains an unsubscribe signal named in `suppression_policy.unsubscribe_signals`, return `classification.type = unsubscribe`, append exactly one `reply_router.suppression_recorded` event with the supplied `idempotency_key` and `expected_version`, and emit no routing decision.
- If reply text is clearly interested, objection, out-of-office, or wrong-person, emit a `runx.reply.routing.v1` routing decision naming a bounded send target and principal for a later governed `send-as` run.
- If the reply is ambiguous, unsupported, or below `suppression_policy.confidence_threshold`, stop for human review and do not write or route.
- Re-running an unsubscribe path with the same `idempotency_key` must reuse the recorded suppression instead of double-applying it.

## Output

The graph returns:

- `classification`: `{ type, confidence, evidence }`.
- `suppression_result`: `{ aggregate_id, idempotency_key, before_version, after_version }` when suppressed.
- `routing_decision`: a `runx.reply.routing.v1` packet with `classification`, `send_target`, and `principal` when routed.
- `escalation_lane`: human-review reason when the reply cannot be safely classified or the original receipt is unsealed.

## Data-store contract

The unsubscribe branch writes a compliance block through `data.source` `append_event` against the caller supplied store, resource, aggregate id, expected version, and idempotency key. This durable suppression record is the fail-closed input that a later `send-as` preflight must read before any new outbound message.

## Refusals

This skill refuses to:

- suppress without unsubscribe-intent evidence present in the reply text and named in the suppression policy;
- ignore an unsubscribe-class reply or route a follow-up send alongside it;
- classify against an unsealed original send receipt;
- invent reply intent that is not grounded in the inbound content;
- send a reply, mutate a message provider, or create an `AttenuationRequest`.

## Validation

Run the local harness from the repository root:

```bash
runx harness ./skills/reply-router
```

Expected cases:

- `sealed_unsubscribe_suppression`
- `sealed_interested_route`
- `stop_ambiguous_or_unsealed`

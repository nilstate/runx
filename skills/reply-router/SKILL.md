---
name: reply-router
version: 0.1.0
description: Classify inbound replies, write unsubscribe suppression records, and emit bounded routing decisions without sending messages.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/iwannabefree00/runx/tree/reply-router-skill/skills/reply-router
runx:
  category: business-ops
---

# Reply Router

`reply-router` classifies an inbound reply against a supplied suppression
policy and the sealed receipt for the original send. It has one durable
side-effect seam: for unsubscribe-class replies it prepares a recipient-keyed
suppression `append_event` for `registry:runx/data-store@0.1.2`. For all other
clear classifications it emits a bounded routing decision naming the later
governed send-as target, but it never sends a message itself.

## Inputs

- `inbound_reply`: object with `content`, `received_from`, and `received_at`.
- `original_send_receipt`: object with `send_plan`, `principal`, `receipt_id`,
  `checksum`, and `sealed`.
- `suppression_policy`: object with `unsubscribe_signals` and
  `confidence_threshold`.
- `data_source_ref`: logical binding for the governed data-store dependency.
- `store_id`: pinned store id for deterministic suppression records.

## Outputs

- `classification`: `{ type, confidence, evidence[] }`.
- `suppression_result`: recipient-keyed suppression CAS packet when suppressed,
  otherwise `null`.
- `routing_decision`: `runx.reply.routing.v1` packet when the reply is routed,
  otherwise `null`.
- `escalation`: human-review lane for unsealed receipts, ambiguous replies, or
  insufficient confidence.
- `evidence`: receipt id, policy signals, idempotency key, before/after data
  versions, and no-send guarantees.

## Rules

1. Refuse to classify on an unsealed or malformed `original_send_receipt`.
2. Suppress when the reply content contains unsubscribe intent grounded in
   `suppression_policy.unsubscribe_signals`.
3. Never route a send alongside an unsubscribe-class reply.
4. For non-unsubscribe replies, emit only a bounded routing packet; the later
   send is a separate governed send-as run chosen by an operator or downstream
   driver.
5. Stop before write when the reply is ambiguous or confidence is below
   `suppression_policy.confidence_threshold`.

## Data-store seam

For unsubscribe replies the output includes a CAS `append_event` packet:

1. `read_projection` for the recipient aggregate.
2. `append_event` through `registry:runx/data-store@0.1.2`.
3. `aggregate_id = inbound_reply.received_from`.
4. `expected_version` comes from `original_send_receipt.send_plan.recipient_state_version` when present, else `0`.
5. `idempotency_key` is derived from `received_from + receipt_id + classification`.

That suppression record is the compliance block a later governed send-as
preflight reads. This skill does not consume credentials, call a mail provider,
emit an `AttenuationRequest`, or create an `operational_proposal` envelope.

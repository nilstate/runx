---
name: reply-router
description: Classify inbound replies against a sealed send receipt and either append a suppression event or emit a governed routing decision without sending.
runx:
  category: compliance
---

# Reply Router

`reply-router` turns an inbound reply plus the original send receipt into one
auditable decision. It can record an unsubscribe suppression, route a normal
reply to a later send-as lane, or stop for an agent when the evidence is
ambiguous or the original send receipt is not sealed.

The skill never sends a message. It emits the next governed action only after
the reply is classified and the original send evidence is checked.

## Inputs

- `inbound_reply`: object with `content`, `received_from`, and `received_at`.
- `original_send_receipt`: sealed send receipt evidence with `receipt_id`,
  `checksum`, `sealed`, `principal`, and `send_plan`.
- `suppression_policy`: object with `unsubscribe_signals` and
  `confidence_threshold`.
- `store_projection`: optional current data-store projection with `store_id`,
  `aggregate_id`, and `version`.

## Outputs

When the reply is a clear unsubscribe and the original send receipt is sealed,
the graph appends a `recipient_suppression_event` packet:

- `classification{type,confidence,evidence}`
- `suppression_result{aggregate_id,idempotency_key,before_version,after_version}`
- `data_store_call{registry_ref,operation,store_id,expected_version}`

When the reply is a normal routed response, the graph emits
`runx.reply.routing.v1` with `classification`, `send_target`, and `principal`.
The output names a separate governed send-as run and does not send.

When the reply is ambiguous or the original receipt is unsealed, the graph stops
at a human lane and returns `needs_agent`. It does not write a suppression event
or emit a routing decision.

## Safety Rules

- Refuse to suppress unless the reply text contains unsubscribe intent and the
  policy includes a matching signal.
- Refuse to route a send when the reply asks to unsubscribe.
- Refuse unsealed or checksum-less original receipts.
- Never invent a classification unsupported by reply text.
- Treat every outbound action as a separate governed run.

## Data-Store Contract

Suppression uses a pinned registry reference:
`registry:runx/data-store@0.1.2`.

The append event call is modeled as an ungated CAS append:

- `operation`: `append_event`
- `store_id`: `runx.reply-router.suppression.v1`
- `aggregate_id`: recipient address
- `expected_version`: current projection version
- `idempotency_key`: SHA-256 over receipt id, recipient, and reply content

The resulting suppression record is the compliance block consumed by the next
send-as preflight.

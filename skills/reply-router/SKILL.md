---
name: reply-router
description: Classify inbound replies against a sealed send receipt and either append a recipient-keyed suppression event or emit a bounded governed routing decision without sending.
runx:
  category: compliance
---

# Reply Router

`reply-router` reads an inbound reply alongside the sealed original send receipt,
classifies the reply against a suppression policy, and branches:

- **Unsubscribe** → appends a recipient-keyed suppression event to a durable
  data-store via an ungated CAS `append_event`. The resulting record is the
  compliance block the next send-as preflight reads as a fail-closed block.
- **Routed reply** → emits a typed `runx.reply.routing.v1` decision naming a
  separate governed send-as run that performs the send later. The skill never
  sends.
- **Ambiguous / unsealed** → stops at a human approval lane (`needs_agent`)
  with no suppression write and no routing decision.

The skill never sends a message. The routed send is a separate gated run a
downstream driver or operator issues by name.

## Inputs

- `inbound_reply`: object with `content`, `received_from`, and `received_at`.
- `original_send_receipt`: sealed send receipt evidence with `receipt_id`,
  `checksum` (sha256), `sealed`, `principal`, and `send_plan`.
- `suppression_policy`: object with `unsubscribe_signals` (list) and
  `confidence_threshold` (number).
- `store_projection`: optional current data-store projection with `store_id`,
  `aggregate_id`, and `version`.

## Outputs

**Unsubscribe (sealed receipt):**
- `classification{type,confidence,evidence}`
- `suppression_result{aggregate_id,idempotency_key,before_version,after_version}`
- `data_store_call{registry_ref,operation,store_id,expected_version}`

**Routed reply:**
- `runx.reply.routing.v1{classification,send_target,principal}` carrying a
  bounded send target, plus an escalation lane.

**Ambiguous / unsealed:**
- `needs_agent` — no suppression write, no routing decision.

No `AttenuationRequest` and no `operational_proposal` envelope are emitted.

## Safety Rules

- Refuse to suppress unless the reply text contains unsubscribe intent **and**
  the policy includes a matching signal.
- Refuse to ignore an unsubscribe-class reply or route a send alongside it.
- Refuse to classify on an unsealed `original_send_receipt`.
- Never invent a classification it cannot ground in the inbound content.

## Data-Store Contract

Suppression uses pinned registry reference `registry:runx/data-store@0.1.2`.

The append event call is modeled as an ungated CAS append:

- `operation`: `append_event`
- `store_id`: `runx.reply-router.suppression.v1`
- `aggregate_id`: recipient address
- `expected_version`: current projection version (from `read_projection`)
- `idempotency_key`: SHA-256 over receipt id, recipient, and reply content

The resulting suppression record is the compliance block consumed by the next
send-as preflight.

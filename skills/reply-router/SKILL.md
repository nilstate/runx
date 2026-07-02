---
name: reply-router
description: Classify an inbound reply against a sealed original-send receipt, append unsubscribe suppressions through the data-store contract, or emit a bounded send-as routing decision.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 20
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  inbound_reply:
    type: json
    required: true
    description: Inbound reply with content, received_from, and received_at.
  original_send_receipt:
    type: json
    required: true
    description: Sealed original send receipt with send_plan, principal, receipt_id, and checksum.
  suppression_policy:
    type: json
    required: true
    description: Suppression policy with unsubscribe_signals, confidence_threshold, and optional prior projection version.
runx:
  category: communications
  input_resolution:
    required:
      - inbound_reply
      - original_send_receipt
      - suppression_policy
  artifacts:
    wrap_as: reply_router_packet
---

# reply-router

Route inbound replies without sending mail. The skill classifies a reply using
only the inbound text, a sealed original-send receipt, and a caller-supplied
suppression policy. It emits either a suppression event shape for `data-store`,
a bounded `runx.reply.routing.v1` decision for a later governed `send-as` run,
or a human escalation lane when the inputs are ambiguous or unsealed.

## What It Does

1. Refuses to act if the original send receipt is not sealed or cannot be
   matched to a recipient.
2. Matches unsubscribe intent only when a policy signal is present in the reply
   text.
3. For unsubscribe replies, emits a recipient-keyed suppression event using the
   `registry:runx/data-store@0.1.2` append-event contract with expected-version
   CAS and a deterministic idempotency key.
4. For non-suppression replies, emits a typed routing decision naming a bounded
   downstream `send-as` target. It never sends directly.
5. For ambiguous replies, escalates to a human lane and emits no suppression
   write and no routing decision.

## Inputs

- `inbound_reply`: `{content, received_from, received_at}`.
- `original_send_receipt`: `{send_plan, principal, receipt_id, checksum, state}`.
  `state` must be `sealed`, or `sealed` may be `true`.
- `suppression_policy`:
  `{unsubscribe_signals, confidence_threshold, data_source_ref, resource,
  store_id, prior_projection}`.

## Output

The runner writes a `reply_router_packet` JSON object. Important fields are:

- `classification`: `{type, confidence, evidence}`.
- `suppression_result`: populated only for unsubscribe-class replies.
- `routing_decision`: a `runx.reply.routing.v1` object for routed replies.
- `escalation_lane`: populated when the reply requires human handling.

The skill is intentionally not a mail sender. Any later send must run through a
separate governed send-as workflow named in the routing decision.

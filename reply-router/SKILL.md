---
name: reply-router
description: >
  Classifies inbound email replies against a suppression policy. Detects
  unsubscribe signals and appends a recipient-keyed suppression event to
  data-store via ungated CAS write. For non-unsubscribe replies, emits a
  typed routing decision naming a separate governed send-as run. Routes
  ambiguous or unsealed inputs to a human review lane.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  inbound_reply:
    type: json
    required: true
  original_send_receipt:
    type: json
    required: true
  suppression_policy:
    type: json
    required: true
  store_projection:
    type: json
runx:
  category: ops
  input_resolution:
    required:
      - inbound_reply
      - original_send_receipt
      - suppression_policy
---

# reply-router

Reads an inbound reply and the sealed original send receipt, classifies the
reply against a suppression policy, and branches:

- **Unsubscribe** ? appends a suppression event to data-store
  (`registry:runx/data-store@0.1.2`, CAS append_event) keyed on the recipient,
  so the next send-as preflight reads it as a fail-closed block.
- **Routed** (interested, objection, etc.) ? emits a typed
  `runx.reply.routing.v1` decision naming a bounded send target. The skill
  never sends; a separate governed send-as run performs the send.
- **Ambiguous / unsealed** ? blocks at `needs_agent` for human review.
  No suppression write, no routing decision.

## Typed Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `inbound_reply` | `{content, received_from, received_at}` | yes | The inbound reply message |
| `original_send_receipt` | `{send_plan, principal, receipt_id, checksum}` | yes | Sealed original send receipt |
| `suppression_policy` | `{unsubscribe_signals[], confidence_threshold}` | yes | Policy for unsubscribe detection |
| `store_projection` | `{store_id, aggregate_id, version}` | no | Current data-store projection for CAS |

## Typed Outputs

| Classification `route=suppress` | Classification `route=route` | Classification `route=needs_agent` |
|---|---|---|
| `classification{type,confidence,evidence}` | `classification{type,confidence,evidence}` | `classification{type,confidence,reason}` |
| `suppression_result{aggregate_id,idempotency_key,before_version,after_version}` | `routing_decision{send_target,principal}` | escalation lane |
| No routing decision | No suppression write | No suppression, no routing |

## Behavior Rules

- Refuses to suppress without unsubscribe-intent evidence in reply text.
- Never ignores an unsubscribe-class reply or routes alongside it.
- Refuses to classify on an unsealed `original_send_receipt`.
- Never invents a classification not grounded in inbound content.

## Harness Cases

- `sealed_unsubscribe_suppression`: Unsubscribe reply with sealed receipt ?
  suppression append_event, no routing.
- `stop_ambiguous_or_unsealed`: Ambiguous reply or unsealed receipt ?
  `needs_agent`, no state mutation.

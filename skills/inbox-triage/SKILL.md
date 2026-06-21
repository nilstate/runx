---
name: inbox-triage
description: Triage a bounded inbox packet, choose the safe next action, and draft one reviewed reply without sending anything.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: ops
---

# Inbox Triage

Turn a redacted inbox packet into a priority queue and one safe reply draft.

This skill is intentionally narrow. It reads only the provided inbox packet,
sender metadata, and operator policy. It never opens a mailbox, sends email,
changes labels, mutates accounts, or claims private account state.

## Procedure

1. Require `inbox_packet.messages` and `sender_metadata`.
2. Normalize each message into a bounded summary.
3. Classify each message as `replyable`, `scheduling`, `informational`,
   `needs_context`, or `unsafe_or_sensitive`.
4. Build a priority queue with evidence references to message ids.
5. Draft one reply only when the best message is safe and supported by the
   supplied context.
6. Return a send gate that always requires human approval.

## Stop conditions

Return `needs_input` when the inbox packet is missing, empty, or the sender
metadata does not identify the operator. Return a no-send proposal when the
best candidate involves account access, passwords, OTPs, payment details,
legal terms, or private-state changes.

## Inputs

- `inbox_packet`: object with `messages`.
- `sender_metadata`: object with operator name, role, or email.
- `operator_policy`: optional signature, tone, and send rules.

## Outputs

- `classification`: queue-level counts.
- `triage_queue`: message-level classes, reasons, and evidence refs.
- `draft_reply`: proposed reply or stop reason.
- `gated_send_proposal`: explicit send-as approval gate.
- `evidence`: counts, redaction, and side-effect proof.


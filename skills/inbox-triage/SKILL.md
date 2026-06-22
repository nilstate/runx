---
name: inbox-triage
description: Classify a bounded inbox packet, draft a safe reply, and stop at an explicit send-as approval proposal.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: ops
---

# Inbox Triage

Turn a bounded inbox packet into a safe operator handoff: message
classification, a triage queue, a draft reply, and a gated send proposal.

This skill uses caller-provided fixture data or an explicit inbox packet. It
does not connect to private mailboxes, infer hidden history, or send messages.
Any outbound action is represented as a proposal that a separate send-as skill
or human operator must approve.

The default runner is deterministic and local. It reads only the supplied JSON
inputs, validates sender/body/policy safety, writes optional local artifacts
inside the skill directory, and emits one JSON packet.

## Quality Profile

- Purpose: help an operator process a small inbox packet without granting send
  authority.
- Audience: operators who need daily inbox triage and maintainers reviewing
  whether the skill preserves consent boundaries.
- Artifact contract: emit an `inbox_triage_packet` containing classification,
  `triage_queue`, `draft_reply`, and `gated_send_proposal`.
- Evidence bar: every classification and draft must cite the supplied message
  id, sender metadata, body, and operator policy. Missing body, missing sender,
  or unsafe reply instructions are stop conditions.
- Voice bar: concise operator language with clear action labels and no claims
  that private context was read.
- Safety bar: never send, schedule, archive, delete, unsubscribe, or mutate an
  inbox. Propose a send-as handoff only when the policy permits drafting.

## Inputs

- `inbox_packet` (required): bounded message packet with `messages`.
- `sender_metadata` (required): known sender facts keyed by message or address.
- `operator_policy` (required): reply style, allowed topics, and send gates.
- `objective` (optional): operator goal for this triage run.

## Output

The default runner returns:

- `classification`: per-message labels such as `needs_reply`, `waiting`,
  `calendar`, `finance`, `noise`, or `unsafe`.
- `triage_queue`: ordered next actions with reasons and source message ids.
- `draft_reply`: a draft body and citations, or `null` when drafting is unsafe.
- `gated_send_proposal`: the explicit send-as handoff packet. It must have
  `requires_approval: true` and must never claim that a message was sent.
- `decision`: `ready`, `needs_more_evidence`, or `refused`.

## Stop Conditions

Return `needs_more_evidence` when:

- a message has no sender address or sender metadata,
- a message body is missing or redacted beyond useful review,
- the operator policy forbids drafting for the topic,
- the requested reply would leak private data, bypass approval, impersonate the
  operator, make financial/legal commitments, or send automatically.

Return `refused` when `operator_policy.auto_send` is true or when policy asks
the skill to bypass the send-as gate.

## Send-As Composition

This skill composes with send-as by producing only a proposal:

```json
{
  "requires_approval": true,
  "proposed_channel": "email",
  "to": "sender@example.com",
  "subject": "Re: ...",
  "body": "...",
  "approval_gate": "send-as.explicit-operator-approval"
}
```

A separate send-as runner or human operator must verify the recipient, content,
and authority before any outbound effect happens.

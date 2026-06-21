---
name: inbox-triage
description: Classify a bounded inbox packet and draft a reply while stopping before any send action.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: ops
---

# Inbox Triage

Classify a bounded inbox packet and draft a reply without sending anything.

Operators need help turning a small, explicit inbox packet into a triage queue
and safe draft. This skill reads only the supplied messages, sender metadata,
and operator policy. It classifies messages, chooses a reply candidate, drafts a
response, and emits a `gated_send_proposal` that another approval-gated skill
may execute later.

## What this skill does

1. Validates a bounded `inbox_packet`.
2. Stops when a message is missing sender or body.
3. Classifies messages by urgency, risk, and likely intent.
4. Builds a `triage_queue` with source message ids.
5. Drafts one reply from supplied message content and policy only.
6. Emits a gated send proposal; it never sends or mutates mailbox state.

## When to use this skill

Use it for fixture-backed inbox review, daily operator triage, support queue
prep, or approval-gated send-as workflows. It is useful when the caller has
already collected and bounded the messages that may be read.

## When not to use this skill

Do not use it to connect to a private mailbox, fetch additional thread history,
send an email, or bypass approval. Do not use it when the sender, message body,
or operator policy is missing. In those cases it returns `needs_more_evidence`
or `refused` with the exact missing condition.

## Procedure

1. Parse `inbox_packet`, `sender_metadata`, and `operator_policy`.
2. Validate each message has an id, sender, subject, and body.
3. Refuse unsafe policy terms or send requests.
4. Classify each message and sort the queue by priority.
5. Draft a reply for the highest-priority replyable message.
6. Represent the send as `gated_send_proposal` with `approval_required: true`.
7. Write `evidence.json` and `report.md` under `output_dir` when requested.

## Edge cases and stop conditions

- **Missing sender:** return `needs_more_evidence`; attribution is required
  before a reply can be drafted.
- **Missing body:** return `needs_more_evidence`; do not infer a message body
  from subject alone.
- **Unsafe policy or requested auto-send:** return `refused`; this skill never
  sends.
- **No replyable messages:** return `needs_more_evidence` and surface the queue
  without a draft.
- **Blocked sender:** classify the message but do not draft a reply.

## Output schema

```yaml
schema: runx.inbox_triage.v1
decision: ready | needs_more_evidence | refused
classification:
  - message_id: string
    intent: string
    priority: high | medium | low
    risk: low | medium | high
triage_queue:
  - message_id: string
    reason: string
    next_step: string
draft_reply:
  message_id: string
  to: string
  subject: string
  body: string
gated_send_proposal:
  approval_required: true
  send_skill: send-as
  blocked_until_approval: true
missing_evidence: []
```

The same object is returned as `evidence_json`. `report_md` renders the queue
and draft in reviewer-readable form.

## Worked example

```bash
runx skill "$PWD/skills/inbox-triage" \
  --input inbox_packet='[
    {"id":"msg-1","from":"alex@example.com","subject":"Invoice correction","body":"Can you confirm the updated invoice by Friday?","timestamp":"2026-06-21T09:00:00Z"}
  ]' \
  --input operator_policy='{"approval_gate":"send-as","signature":"Arbaz","allowed_intents":["billing","support"]}' \
  --json
```

The output classifies `msg-1` as billing, drafts a concise confirmation request,
and emits a gated send proposal that requires approval before any send happens.

## Inputs

- `inbox_packet`: required bounded message array.
- `sender_metadata`: optional trust metadata by sender or message id.
- `operator_policy`: optional reply policy.
- `output_dir`: optional package-local artifact output directory.

## Outputs

- `inbox_triage`: complete triage and draft packet.
- `evidence_json`: same packet as machine-checkable JSON.
- `report_md`: concise Markdown report.

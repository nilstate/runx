---
name: inbox-triage
version: 0.1.0
description: Classify a bounded inbox thread, route it to the right queue, draft a safe reply when possible, and stop before any send action.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/LubuSeb/runx/tree/lubu/inbox-triage-34/skills/inbox-triage
runx:
  category: ops
  input_resolution:
    required:
      - inbox_packet
      - operator_policy
---

# Inbox Triage

Classify one bounded inbox thread, decide the safest queue, draft a reply only
when the supplied context is enough, and return a send proposal that requires a
separate approval gate. The skill reads fixture-style inbox packets and never
connects to a mailbox, sends mail, mutates tickets, or accesses private account
state.

## When To Use

Use this skill when an operator or agent has an already-bounded inbox packet and
needs a safe first-pass decision:

- classify the message intent and urgency;
- route the thread to a named queue;
- prepare a reply draft for low-risk informational messages;
- preserve the evidence and citations used for that decision;
- hand off any send through `send-as` or another governed sender.

## When Not To Use

Do not use this skill as a mailbox connector, live sending tool, account
recovery authority, billing operator, abuse moderator, or customer identity
verifier. Do not pass raw mailbox exports, unrelated threads, credentials,
private account records, or broad contact lists. If the request needs private
state, identity proof, payment action, legal review, abuse handling, or an
unapproved send, the skill must return a blocked/manual-review proposal.

## Procedure

1. Require `inbox_packet` to contain a source, thread id, and at least one
   message with sender metadata and body text. Stop with a failure receipt when
   those bounded-context fields are missing.
2. Normalize the latest message and classify it as `product_question`,
   `bug_report`, `billing`, `account_access`, `abuse`, `unsafe_send_request`, or
   `unknown`.
3. Choose a queue from `operator_policy.queues` or a safe default.
4. Draft a reply only for low-risk product questions where sender metadata and
   body text are present.
5. For bug, billing, account, abuse, unknown, or unsafe-send cases, produce no
   reply body and route to review.
6. Always emit `gated_send_proposal.decision = "requires_human_approval"` or a
   stricter blocked state; never authorize delivery.
7. Include cited message ids, matched signals, missing context, and the exact
   send-as handoff requirements.

## Output Shape

```json
{
  "classification": {
    "label": "product_question",
    "confidence": 0.88,
    "urgency": "normal",
    "matched_signals": ["how do i", "setup"],
    "rationale": "The message asks a bounded setup question."
  },
  "triage_queue": {
    "name": "support.reply_drafts",
    "priority": "normal",
    "reason": "Safe product question with enough context for a draft.",
    "cited_message_ids": ["msg-1"],
    "missing_context": []
  },
  "draft_reply": {
    "proposed": true,
    "to": "mira@example.test",
    "subject": "Re: Verify sending domain",
    "body": "..."
  },
  "gated_send_proposal": {
    "decision": "requires_human_approval",
    "send_as_skill": "send-as",
    "approval_required": true,
    "blocked_reason": null
  }
}
```

## Send-As Composition

This skill only prepares a reply draft. A downstream sender must bind the
principal, recipient, content digest, provider account, consent basis, and human
approval before delivery. The output names the send-as handoff but does not
perform it.

## Worked Example

```bash
runx skill "$PWD" \
  --runner triage \
  --input-json inbox_packet='{
    "thread_id": "thr-100",
    "source": "fixture:safe-product-question",
    "messages": [{
      "id": "msg-1",
      "from": {"name": "Mira", "email": "mira@example.test"},
      "subject": "Verify sending domain",
      "body": "How do I finish the DNS verification step?"
    }]
  }' \
  --input-json operator_policy='{
    "product_name": "ExampleDesk",
    "support_signature": "ExampleDesk Support",
    "queues": {"reply_drafts": "support.reply_drafts"}
  }' \
  --json
```

Expected result: `classification.label = product_question`,
`triage_queue.name = support.reply_drafts`, `draft_reply.proposed = true`, and
`gated_send_proposal.decision = requires_human_approval`.

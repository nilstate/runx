---
name: support-desk
description: Classify an inbound support ticket or message into one of four categories — bug, feature_request, how_to, or urgent — and suggest a response template or escalation path. Never sends — just classifies and recommends.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: ops
  input_resolution:
    required:
      - ticket
---

## What this skill does

Classify one inbound support ticket or message into one of four categories —
`bug`, `feature_request`, `how_to`, or `urgent` — and produce the safe next
action:

- **Urgent**: emit an `runx.support.escalation.v1` escalation decision naming
  the on-call escalation target and the priority. No message is sent.
- **Bug, feature_request, how_to**: emit a `runx.support.routing.v1` routing
  decision naming a bounded handling lane and a suggested response template
  reference. No message is sent.

This skill never sends email, SMS, chat messages, or any outbound
communication. It prepares the classification and recommendation that a
separate governed send skill can review, approve, and deliver with its own
authority grant and receipt.

## When to use this skill

Use this skill when an agent has received a support ticket, help request, or
customer message and needs a safe first decision about how to triage it:

- Classify the ticket intent (bug, feature request, how-to, urgent).
- Route bugs and how-to questions to the right handling lane.
- Escalate urgent or production-down reports to the on-call path.
- Suggest a response template for the agent to review before sending.

## When not to use this skill

Do not use this skill as a message transport, identity verifier, billing
handler, or automatic sender. Do not use it to modify account state, process
refunds, access private customer records, or take any live action against a
production system.

If the ticket asks for account recovery, billing changes, data deletion, or
anything requiring private records or a regulated action, the skill must not
route to a definitive send. It should return a stop and let a stronger
authority gate handle the consequence.

## Procedure

1. Require `ticket` to contain `content`, `submitted_by`, and `submitted_at`.
2. Optional `context` may include `product`, `tier`, and `account_id` to refine
   the routing target.
3. Normalize the ticket content and classify it as `bug`, `feature_request`,
   `how_to`, or `urgent`.
4. Estimate confidence from matched signal count and signal strength.
5. If the classification is `urgent` and confidence meets the
   `triage_policy.confidence_threshold`:
   a. Emit `runx.support.escalation.v1` with `classification`, `escalation_target`,
      `priority`, and `submitted_by`.
6. For `bug`, `feature_request`, and `how_to` above the confidence threshold,
   emit `runx.support.routing.v1` with `classification`, `handling_lane`,
   `suggested_response_template`, and `submitted_by`.
7. If confidence is below threshold or the classification is ambiguous, stop
   with an error so the ticket goes to manual review.

## Edge cases and stop conditions

Return a stop (exit non-zero) when:

- `ticket.content` is empty or missing.
- `ticket.submitted_by` is missing.
- The ticket content does not match any classification with sufficient
  confidence (ambiguous ticket).
- The ticket requests a regulated action (refund, account deletion, password
  reset, data export) that requires a stronger authority gate. In this case the
  skill stops rather than routing a sensitive action automatically.

The authority scope is classification, escalation preparation, and routing
recommendation only. The proof surface is the sealed receipt containing the
ticket summary, classification, evidence, and either the escalation decision or
routing decision. Any live send requires a separate `send-as` receipt.

## Output schema

### Urgent (escalated)

```json
{
  "classification": {
    "type": "urgent",
    "confidence": 0.92,
    "evidence": {
      "matched_signals": ["production down", "outage", "critical"],
      "source_summary": "Production is down, this is a critical outage..."
    }
  },
  "runx.support.escalation.v1": {
    "classification": "urgent",
    "escalation_target": "on-call-engineer",
    "priority": "P1",
    "submitted_by": "mailto:ops@example.com"
  }
}
```

### Routed (bug, feature_request, how_to)

```json
{
  "classification": {
    "type": "bug",
    "confidence": 0.85,
    "evidence": {
      "matched_signals": ["bug", "error", "stack trace", "broken"],
      "source_summary": "I'm getting an error when I try to log in..."
    }
  },
  "runx.support.routing.v1": {
    "classification": "bug",
    "handling_lane": "engineering-bugs",
    "suggested_response_template": "bug-acknowledgment",
    "submitted_by": "mailto:alice@example.com"
  }
}
```

### Stop (regulated action)

The skill exits non-zero and writes a stop reason to stderr. No routing or
escalation object is emitted.

## Worked example

```bash
runx skill "$PWD" \
  --input-json ticket='{
    "content": "Production is down! We have a critical outage affecting all users right now.",
    "submitted_by": "mailto:ops@example.com",
    "submitted_at": "2026-07-01T10:00:00Z"
  }' \
  --input-json context='{
    "product": "api-gateway",
    "tier": "enterprise"
  }' \
  --input-json triage_policy='{
    "urgent_signals": ["production down", "outage", "critical", "sev1", "sev-1"],
    "confidence_threshold": 0.75
  }' \
  --json
```

Expected result: `classification.type = urgent`,
`runx.support.escalation.v1.escalation_target = on-call-engineer`.
The run does not send any message.

## Inputs

- `ticket`: object with `content` (string), `submitted_by` (string), and
  `submitted_at` (ISO 8601 string).
- `context`: optional object with `product` (string), `tier` (string), and
  `account_id` (string). Used to refine the handling lane.
- `triage_policy`: optional object with `urgent_signals` (array of strings) and
  `confidence_threshold` (number from 0 to 1, default 0.75).

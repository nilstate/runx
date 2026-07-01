---
name: reply-router
description: Classify an inbound reply message and either append a suppression event for unsubscribes or emit a bounded routing decision for all other classifications. Never sends — just routes.
source: https://github.com/armstrongsam25/runx-demo
runx:
  category: ops
  input_resolution:
    required:
      - inbound_reply
      - original_send_receipt
---

## What this skill does

Classify one inbound reply message into one of five categories — `interested`,
`objection`, `out_of_office`, `wrong_person`, or `unsubscribe` — and take the
safe next action:

- **Unsubscribe**: append a suppression event to a local event store using
  compare-and-swap version checking and an idempotency key. Return a
  `suppression_result` with `aggregate_id`, `idempotency_key`, `before_version`,
  and `after_version`.
- **All other classifications**: emit a `runx.reply.routing.v1` routing decision
  naming a bounded send target and the principal. No message is sent.

This skill never sends email, SMS, chat messages, or any outbound communication.
It prepares the routing decision or suppression record that a separate governed
send skill can review, approve, and deliver with its own authority grant and
receipt.

## When to use this skill

Use this skill when an agent has received a reply to a previously sent message
and needs a safe first decision about how to handle it:

- Classify the reply intent (interested, objection, out-of-office, wrong-person,
  unsubscribe).
- Suppress future sends to a recipient who unsubscribed.
- Route interested or objection replies to the right follow-up lane.

## When not to use this skill

Do not use this skill as a message transport, identity verifier, bounce handler,
or automatic sender. Do not use it to modify account state, process payments, or
access private customer records unless that state has already been summarized
into the `original_send_receipt`.

If the reply asks for account recovery, billing changes, or anything requiring
private records, the skill must not route to a definitive send. It should return
a stop and let a stronger authority gate handle the consequence.

## Procedure

1. Require `inbound_reply` to contain `content`, `received_from`, and
   `received_at`.
2. Require `original_send_receipt` to contain `send_plan`, `principal`,
   `receipt_id`, and `checksum`. If the receipt is missing a `checksum` or
   `receipt_id`, treat the reply as unsealed and stop.
3. Normalize the reply content and classify it as `interested`, `objection`,
   `out_of_office`, `wrong_person`, or `unsubscribe`.
4. Estimate confidence from matched signal count and signal strength.
5. If the classification is `unsubscribe` and confidence meets the
   `suppression_policy.confidence_threshold`:
   a. Derive `aggregate_id` from `principal` and `receipt_id`.
   b. Derive `idempotency_key` from `aggregate_id`, `unsubscribe`, and the
      receipt `checksum`.
   c. Append a suppression event to the local event store with
      `expected_version` CAS (compare-and-swap).
   d. Return `suppression_result` with `aggregate_id`, `idempotency_key`,
      `before_version`, and `after_version`.
6. For all other classifications above the confidence threshold, emit
   `runx.reply.routing.v1` with `classification`, `send_target`, and
   `principal`.
7. If confidence is below threshold or the classification is ambiguous, stop
   with an error so the reply goes to manual review.

## Edge cases and stop conditions

Return a stop (exit non-zero) when:

- `inbound_reply.content` is empty or missing.
- `original_send_receipt` lacks `receipt_id` or `checksum` (unsealed reply).
- The reply content does not match any classification with sufficient
  confidence (ambiguous reply).
- The suppression event store reports a version conflict (the aggregate was
  modified by another process).

The authority scope is classification, suppression recording, and routing
preparation only. The proof surface is the sealed receipt containing the reply
summary, classification, evidence, and either the suppression result or routing
decision. Any live send requires a separate `send-as` receipt.

## Output schema

### Unsubscribe (suppressed)

```json
{
  "classification": {
    "type": "unsubscribe",
    "confidence": 0.92,
    "evidence": {
      "matched_signals": ["unsubscribe", "don't want", "mailing list"],
      "source_summary": "Please unsubscribe me from this mailing list..."
    }
  },
  "suppression_result": {
    "aggregate_id": "principal:marketing:rcpt_01JXNEWSLETTER001",
    "idempotency_key": "principal:marketing:rcpt_01JXNEWSLETTER001:unsubscribe:sha256:abc123def456",
    "before_version": 0,
    "after_version": 1
  }
}
```

### Routed (interested, objection, out_of_office, wrong_person)

```json
{
  "classification": {
    "type": "interested",
    "confidence": 0.85,
    "evidence": {
      "matched_signals": ["interested", "tell me more"],
      "source_summary": "I'm interested, tell me more about this."
    }
  },
  "runx.reply.routing.v1": {
    "classification": "interested",
    "send_target": "sales-follow-up",
    "principal": "principal:marketing"
  }
}
```

## Worked example

```bash
runx skill "$PWD" \
  --input-json inbound_reply='{
    "content": "Please unsubscribe me from this mailing list. I don'"'"'t want these emails anymore.",
    "received_from": "mailto:alice@example.com",
    "received_at": "2026-07-01T10:00:00Z"
  }' \
  --input-json original_send_receipt='{
    "send_plan": "newsletter-weekly-2026-w26",
    "principal": "principal:marketing",
    "receipt_id": "rcpt_01JXNEWSLETTER001",
    "checksum": "sha256:abc123def456"
  }' \
  --input-json suppression_policy='{
    "unsubscribe_signals": ["unsubscribe", "stop sending", "remove me", "opt out", "don'"'"'t want"],
    "confidence_threshold": 0.75
  }' \
  --json
```

Expected result: `classification.type = unsubscribe`, `suppression_result.after_version = 1`.
The run does not send any message.

## Inputs

- `inbound_reply`: object with `content` (string), `received_from` (string),
  and `received_at` (ISO 8601 string).
- `original_send_receipt`: object with `send_plan` (string), `principal`
  (string), `receipt_id` (string), and `checksum` (string with `sha256:`
  prefix).
- `suppression_policy`: optional object with `unsubscribe_signals` (array of
  strings) and `confidence_threshold` (number from 0 to 1, default 0.75).

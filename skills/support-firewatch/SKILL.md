---
name: support-firewatch
description: Read a fixtured support thread and SLA policy, detect sentiment, SLA breach, and churn-risk signals, and emit an escalation packet only when warranted. It pages nobody and changes no ticket.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: ops
  input_resolution:
    required:
      - thread
      - sla_policy
---

## What this skill does

Read one support thread and its SLA policy, detect signals (sentiment, SLA
breach, churn risk), and emit an escalation packet only when warranted. Each
signal is grounded in a specific thread turn or policy clock — the skill never
invents sentiment, breach, or churn risk.

The skill produces:

- **signals**: an object with `sentiment` (`positive`, `neutral`, `negative`,
  or `very_negative`), `sla_breach` (boolean), and `churn_risk` (`none`,
  `low`, `medium`, or `high`).
- **escalation**: an object with `needed` (boolean), `priority` (`low`,
  `medium`, `high` — only when needed), and `context` (string explaining why).

The escalation packet routes to a human approval inbox. The skill pages nobody,
reassigns nothing, and notifies no customer.

## When to use this skill

Use this skill when an agent has a support thread and SLA policy and needs a
safe first pass at detecting escalation-worthy situations:

- Detect negative sentiment trends in a customer support thread.
- Identify SLA breach conditions based on response-time policy.
- Flag churn-risk signals (cancellation threats, competitor mentions, repeated
  complaints).
- Emit a structured escalation packet for human review.

## When not to use this skill

Do not use this skill to page on-call engineers, reassign tickets, notify
customers, auto-close threads, or modify any ticket state. Do not use it to
send alerts, trigger webhooks, or create tasks in external systems.

## Procedure

1. Require `thread` to contain `customer` (string) and `turns` (array of
   `{author, text, timestamp}`). Require `sla_policy` to contain
   `response_time_minutes` (number) and optionally `resolution_hours`
   (number). If any required field is missing or invalid, stop.
2. For each customer turn, detect sentiment using keyword analysis: negative
   words (angry, frustrated, disappointed, terrible, unacceptable, broken,
   useless, cancel, refund, switch, leave, competitor, ridiculous) escalate
   sentiment; positive words (great, happy, thanks, excellent, resolved,
   working) improve it.
3. Detect SLA breach: compare the time between the first customer turn and the
   first agent response against `response_time_minutes`, and (if provided) the
   total thread duration against `resolution_hours`.
4. Detect churn risk: cancellation language ("cancel", "close my account",
   "switch to", "leave"), competitor mentions, or repeated unresolved
   complaints elevate churn risk.
5. Determine escalation: needed when sentiment is `very_negative` OR
   `sla_breach` is true OR `churn_risk` is `high` or `medium`. Priority is
   `high` when multiple signals fire, `medium` for a single strong signal,
   `low` for borderline cases.
6. Emit the `signals` and `escalation` objects. If no escalation is warranted,
   emit `escalation.needed: false` with `priority: null`.

## Edge cases and stop conditions

Return a stop (exit non-zero) when:

- `thread.turns` is empty, missing, or not an array.
- `thread.customer` is missing or not a string.
- `sla_policy.response_time_minutes` is missing or not a number.
- The thread has no customer turns at all (cannot assess sentiment or churn).

The authority scope is signal detection, sentiment analysis, SLA clock
comparison, and escalation payload preparation only. The proof surface is the
sealed receipt containing the signals and escalation decision. Any live paging,
ticket reassignment, or customer notification requires a separate receipt.

## Output schema

### Sealed (escalation needed)

```json
{
  "signals": {
    "sentiment": "very_negative",
    "sla_breach": true,
    "churn_risk": "medium"
  },
  "escalation": {
    "needed": true,
    "priority": "high",
    "context": "customer sentiment is very_negative; SLA breached (first response 360m vs 60m policy); medium churn risk (churn language detected)."
  }
}
```

### Sealed (no escalation needed)

```json
{
  "signals": {
    "sentiment": "positive",
    "sla_breach": false,
    "churn_risk": "none"
  },
  "escalation": {
    "needed": false,
    "priority": null,
    "context": "Thread is healthy, no SLA breach, no churn signals."
  }
}
```

## Worked example

```bash
runx skill "$PWD" \
  --input-json thread='{"customer":"Acme Corp","turns":[{"author":"customer","text":"This is unacceptable, I want to cancel my account.","timestamp":"2026-07-09T09:00:00Z"},{"author":"agent","text":"Let me help you with that.","timestamp":"2026-07-09T15:00:00Z"}]}' \
  --input-json sla_policy='{"response_time_minutes":60,"resolution_hours":24}' \
  --json
```

Expected result: `signals.sentiment = very_negative`, `signals.sla_breach = true`,
`signals.churn_risk = medium`, `escalation.needed = true`,
`escalation.priority = high`.

## Inputs

- `thread`: object with `customer` (string), `turns` (array of
  `{author: string, text: string, timestamp: ISO 8601 string}`).
- `sla_policy`: object with `response_time_minutes` (number) and optional
  `resolution_hours` (number).

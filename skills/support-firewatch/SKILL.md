---
name: support-firewatch
version: 0.1.0
description: Detect support threads that need human escalation from bounded thread and SLA policy inputs without paging anyone or changing tickets.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 10
inputs:
  thread:
    type: json
    required: true
    description: Support thread turns with author, timestamp, role, and body fields.
  sla_policy:
    type: json
    required: true
    description: SLA clock and threshold policy used to decide whether a response is breached.
runx:
  category: ops
  input_resolution:
    required:
      - thread
      - sla_policy
---

# Support Firewatch

Support Firewatch reviews a bounded customer support thread and an explicit SLA
policy, then emits signals and a human-approval escalation packet only when the
supplied evidence warrants one.

It never sends messages, pages an engineer, reassigns a ticket, changes account
state, or notifies a customer. The output is a decision packet for a human inbox
or a later governed workflow.

## Inputs

- `thread`: an array of support turns. Each turn may include `id`, `role`,
  `author`, `timestamp`, and `body`.
- `sla_policy`: an object with `now`, `first_response_minutes`, and
  `next_response_minutes`.

## Output

```yaml
signals:
  sentiment:
    label: positive | neutral | negative
    score: number
    evidence: array
  sla_breach:
    breached: boolean
    elapsed_minutes: number | null
    threshold_minutes: number | null
    evidence: object | null
  churn_risk:
    level: low | medium | high
    evidence: array
escalation:
  needed: boolean
  priority: null | normal | urgent
  context:
    reason: string
    approval_inbox: string
    no_side_effects: true
```

## Behavior

1. Normalize only the supplied thread turns.
2. Score sentiment from explicit words in customer turns.
3. Compare the latest unanswered customer turn with the supplied SLA clock.
4. Detect churn-risk signals such as cancellation, refund, legal, social, or
   executive-escalation language.
5. Emit `escalation.needed = true` only for breached, strongly negative, or
   high-churn-risk threads.
6. Emit `escalation.needed = false` for healthy threads and explain why.

## Refusal Rules

- Refuse invalid or empty thread inputs.
- Refuse missing or unparsable SLA policy clocks.
- Do not infer account state, customer value, private billing status, or actual
  customer identity beyond the supplied text.
- Do not page, assign, notify, send, or mutate anything.

## Verification Notes

The harness includes one escalation case with a negative breached thread and one
healthy no-escalation case. Both cases are sealed local runs; neither performs
external side effects.

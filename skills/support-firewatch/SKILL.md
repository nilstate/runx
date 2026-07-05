---
name: support-firewatch
version: 0.1.0
description: Watch a bounded support thread for SLA breach, negative sentiment, and churn risk, then emit a governed escalation proposal only when the evidence supports it.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/Difficult-Burger/runx/tree/bounty/support-firewatch-80/skills/support-firewatch
runx:
  category: ops
  input_resolution:
    required:
      - thread
      - sla_policy
---

## What this skill does

Support Firewatch evaluates one bounded support thread against an explicit SLA
policy. It emits receipt-backed signals for sentiment, SLA breach, and churn
risk, then proposes an escalation only when the thread is overdue, strongly
negative, or commercially risky.

The skill never sends messages, opens tickets, changes account state, or pages a
human directly. It produces a packet that a separate governed workflow can
review and act on.

## When to use this skill

Use this skill when an agent has already collected a support conversation and
needs a deterministic first-pass firewatch decision: no escalation, normal
escalation, urgent escalation, or critical escalation.

It is useful for support queue monitoring, customer-success triage, and
governed handoff workflows where escalation requires clear evidence.

## When not to use this skill

Do not use this skill as a helpdesk transport, pager, refund authority, account
recovery workflow, or abuse/legal/security decision maker. If the input lacks a
thread or SLA policy, stop and request those inputs instead of guessing.

Do not submit private account data, credentials, full inbox exports, or
unredacted customer secrets as inputs.

## Procedure

1. Require `thread` and `sla_policy` objects.
2. Normalize message text and timestamps.
3. Determine whether the support response SLA is breached.
4. Score sentiment from concrete negative and positive signals.
5. Estimate churn risk from cancellation, refund, contract, tier, and breach
   signals.
6. Emit `signals{sentiment,sla_breach,churn_risk}`.
7. Emit `escalation{needed,priority,context}` only when evidence supports it.
8. Record matched signals, timing evidence, and limitations.

## Output schema

The runner emits `runx.support.firewatch.v1`:

```json
{
  "signals": {
    "sentiment": "strong_negative | negative | neutral | positive",
    "sla_breach": {
      "breached": true,
      "age_hours": 31.5,
      "threshold_hours": 12,
      "last_customer_message_at": "2026-07-05T08:30:00Z"
    },
    "churn_risk": {
      "level": "high",
      "score": 0.86,
      "drivers": ["cancel", "enterprise", "sla_breach"]
    }
  },
  "escalation": {
    "needed": true,
    "priority": "urgent",
    "context": "Enterprise thread is 31.5h old against a 12h SLA and contains cancellation language."
  },
  "evidence": {
    "source": "fixture:enterprise-overdue",
    "matched_signals": ["cancel", "refund", "no response"],
    "message_count": 3,
    "policy_name": "standard-support-sla",
    "side_effects": "none"
  }
}
```

## Inputs

- `thread`: object with `messages[]`, optional `subject`, optional
  `customer_tier`, optional `source`, and optional `current_time`.
- `thread.messages[]`: objects with `author`, `role`, `body`, and
  `created_at`. Roles can be `customer`, `agent`, or `system`.
- `sla_policy`: object with `response_hours`, optional
  `vip_response_hours`, optional `critical_terms`, optional `churn_terms`, and
  optional `policy_name`.

## Outputs

- `signals.sentiment`: thread sentiment derived from matched language.
- `signals.sla_breach`: SLA timing evidence.
- `signals.churn_risk`: level, score, and concrete drivers.
- `escalation`: whether to escalate, priority, and reviewer context.
- `evidence`: source summary, matched signals, limitations, and proof that this
  skill made no external side effects.

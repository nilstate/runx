---
name: support-firewatch
description: Detect support threads that need escalation from bounded thread turns and SLA policy without paging or mutating tickets.
runx:
  category: support
---

# Support Firewatch

Support Firewatch reads one bounded support thread and an SLA policy. It emits a compact signal packet with sentiment, SLA breach, churn risk, and an escalation recommendation. It never pages anyone, changes tickets, sends messages, or reads private systems.

## Inputs

- `thread` (required array): ordered support thread turns. Each turn may include `id`, `at`, `author`, `role`, and `body` or `message`.
- `sla_policy` (required object): SLA thresholds and optional keyword policy. Supported fields include `now`, `first_response_due_minutes`, `followup_due_minutes`, `churn_risk_terms`, and `negative_sentiment_terms`.

## Outputs

- `signals`: object with `sentiment`, `sla_breach`, and `churn_risk`.
- `escalation`: object with `needed`, `priority`, and `context`.

## Rules

- Use only the supplied thread and policy.
- Preserve evidence in `context.evidence_refs`; do not invent facts.
- Healthy threads must return `escalation.needed=false`.
- A breached SLA or high churn risk may require escalation, but the skill only recommends escalation and has no side effects.
- Do not include secrets, customer private data, tokens, or account identifiers beyond caller-provided bounded IDs.

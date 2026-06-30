---
name: escalation-judge
description: Decide whether a bounded support thread should be escalated, append a durable case event, and emit a typed escalation packet without sending notifications.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - support
    - escalation
    - data-store
links:
  composes:
    - registry:runx/data-store@0.1.2
    - slack-notify
    - send-as
---

# Escalation Judge

This skill reads a support triage packet, a bounded thread body, escalation
policy rules, and prior case state for one support thread. It decides whether
the thread crosses a named policy threshold, records a durable case event for
escalations, and emits a typed escalation packet naming the downstream rail.

## Inputs

- `triage_packet`: object with `classification`, `severity`, `confidence`, and
  optional `signals[]`.
- `thread_body`: bounded support-thread text supplied by the caller.
- `policy_rules`: object with `severity_thresholds`, `churn_risk_signals`, and
  `escalation_lanes`.
- `aggregate_id`: thread id used as the data-store aggregate id.
- `expected_version`: prior projection version used for CAS append.
- `idempotency_key`: caller-provided idempotency key for the append event.
- `prior_case_projection`: optional bounded read-projection fixture containing
  the prior case state and version.

## Outputs

The skill emits `runx.support.escalation_judge.v1`:

- `decision`: `{ escalate, lane, reason }`.
- `case_id`: present only when a new escalation case is appended.
- `append_event`: an ungated CAS append event shaped for
  `registry:runx/data-store@0.1.2`.
- `escalation_packet`: present only when escalation is warranted. It names the
  target rail, such as `slack-notify` for an internal lane or `send-as` for a
  cross-provider lane.
- `stop_state`: present for no-change or needs-human outcomes.

## Safety Boundaries

The skill does not post to Slack, send email, page anyone, mutate CRM data, or
emit an operational proposal envelope. It only emits the typed packet a
downstream governed run can honor later. It refuses to route to lanes that are
not declared in `policy_rules.escalation_lanes`, refuses to escalate without
policy rules, and marks ambiguous severity or missing inputs for human review.

## Procedure

1. Validate the triage packet, thread body, policy rules, aggregate id,
   expected version, and idempotency key.
2. Read the supplied prior-case projection for the thread aggregate.
3. Compare the triage severity and thread signals to named policy thresholds.
4. If no threshold is met, seal a deterministic no-change decision with no case
   append and no escalation packet.
5. If a matching threshold is met and no case is already open, append one
   data-store event using the supplied `expected_version` and
   `idempotency_key`.
6. Emit exactly one typed escalation packet naming the downstream rail for the
   matched lane.

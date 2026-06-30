---
name: escalation-judge
version: 0.1.0
description: Judge whether a support thread crosses named escalation thresholds, append one durable case record, and emit a typed packet for a separate governed dispatcher.
links:
  source: https://github.com/runxhq/runx/tree/main/skills/escalation-judge
runx:
  category: ops
  input_resolution:
    required:
      - triage_packet
      - thread_body
      - policy_rules
      - aggregate_id
      - expected_version
      - idempotency_key
---

## What this skill does

`escalation-judge` reads a support triage packet, the original thread, named
escalation policy, and prior case projection. It grounds every decision in a
declared severity threshold or churn signal. When escalation is warranted it
appends one case event through `data-store@0.1.2` and emits a typed packet that
names, but never invokes, the downstream rail.

The skill performs no Slack post, email send, paging action, legal notification,
or other egress. A separate governed `slack-notify` or `send-as` run is required.

## Decision procedure

1. Read the prior projection for `aggregate_id`, the stable support thread id.
2. Refuse automatic escalation when policy thresholds or lane mappings are absent.
3. Stop with `already_escalated` when the prior projection records an existing case.
4. Compare the supplied severity only with named `severity_thresholds`.
5. Match churn risk only against literal strings in `churn_risk_signals`.
6. Reject any route not declared by `escalation_lanes`.
7. On a match, append an idempotent `support.escalation.opened` event using the
   caller's `expected_version` and `idempotency_key`.
8. Emit a typed escalation packet naming the target rail. Do not dispatch it.

## Inputs

- `triage_packet`: `{classification,severity,confidence}` from a bounded triage run.
- `thread_body`: source text used only to ground declared churn signals.
- `policy_rules`: `{severity_thresholds,churn_risk_signals,escalation_lanes}`.
- `aggregate_id`: support thread id and data-store aggregate key.
- `expected_version`: compare-and-swap version for the case append.
- `idempotency_key`: stable retry key for the event.
- `data_source_ref`: logical data source binding used by `data-store`.

## Outputs and stops

The decision packet contains `decision`, `case_id`, `case_event`,
`escalation_packet`, `stop_state`, and evidence. A normal non-match seals with
`decision.escalate=false`, no case event, no escalation packet, and reason
`no_change`. Missing policy or an undeclared lane returns `needs_human` without
opening a case. Ambiguous or invented severity is never promoted.

## Example

```bash
runx skill ./skills/escalation-judge \
  --input-json triage_packet='{"classification":"account_access","severity":"critical","confidence":0.96}' \
  --input thread_body='Enterprise renewal is at risk after a production lockout.' \
  --input-json policy_rules='{"severity_thresholds":{"executive_review":"critical"},"churn_risk_signals":["renewal is at risk"],"escalation_lanes":{"executive_review":"slack-notify"}}' \
  --input data_source_ref='local://escalation-judge/example' \
  --input aggregate_id='thread-123' \
  --input expected_version=0 \
  --input idempotency_key='thread-123:escalate:v1' \
  --json
```

Verify the resulting receipt with `runx verify --receipt <receipt.json> --json`.
The packet's `target_rail` is an instruction for a separately authorized driver,
not proof that a message was sent.


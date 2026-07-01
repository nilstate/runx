---
name: escalation-judge
description: Decide when a support thread crosses a named escalation policy threshold, record the case, and emit one governed escalation packet without sending or posting.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 10
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  triage_packet:
    type: json
    required: true
    description: Support triage classification with classification, severity, and confidence.
  thread_body:
    type: string
    required: true
    description: Support thread text used only to match policy-declared churn signals.
  policy_rules:
    type: json
    required: true
    description: Escalation policy with severity_thresholds, churn_risk_signals, and escalation_lanes.
  aggregate_id:
    type: string
    required: true
    description: Thread id and data-store aggregate id.
  expected_version:
    type: number
    required: true
    description: Current case stream version required for the append_event CAS write.
  idempotency_key:
    type: string
    required: true
    description: Stable retry key for the case append.
  data_source_ref:
    type: string
    required: false
    description: Logical data source bound by the operator; defaults to local runx dogfood storage.
  store_id:
    type: string
    required: false
    description: Optional deterministic local fixture store id.
runx:
  category: support
  input_resolution:
    required:
      - triage_packet
      - thread_body
      - policy_rules
      - aggregate_id
      - expected_version
      - idempotency_key
  artifacts:
    named_emits:
      decision: runx.escalation_judge.decision.v1
      escalation_packet: runx.escalation.packet.v1
      case_event: runx.escalation.case_event.v1
---

# Escalation Judge

`escalation-judge` decides whether a support thread should open a priority case.
It reads a triage packet, the thread body, explicit policy rules, and prior case
state, then returns a typed decision. When escalation is warranted it appends one
case-opened event through `registry:runx/data-store@0.1.2` and emits one packet
that names the target rail. It never posts to Slack, sends email, or pages a
person; those are downstream governed runs selected by the packet.

## Decision Contract

Inputs:

- `triage_packet`: JSON with `classification`, `severity`, and `confidence`.
- `thread_body`: thread text used to ground churn signals declared in policy.
- `policy_rules`: JSON with `severity_thresholds`,
  `churn_risk_signals`, and `escalation_lanes`.
- `aggregate_id`: the support thread id and data-store aggregate id.
- `expected_version`: the case stream version required for the append.
- `idempotency_key`: retry key for the append.
- `data_source_ref`: optional logical data source, defaulting to
  `local://runx-escalation-judge/default`.
- `store_id`: optional deterministic local fixture store id.

Output:

```json
{
  "schema": "runx.escalation_judge.result.v1",
  "decision": {
    "schema": "runx.escalation_judge.decision.v1",
    "escalate": true,
    "lane": "priority_support",
    "reason": "severity_threshold_matched"
  },
  "case_id": "case_...",
  "escalation_packet": {
    "schema": "runx.escalation.packet.v1",
    "target_rail": "slack://support-priority"
  }
}
```

## State Flow

The `case_flow` profile is a graph for source-repo and operator runs:

1. Read `registry:runx/data-store@0.1.2` with `read_projection` for the thread.
2. Decide from the triage packet, thread body, policy, and prior projection.
3. When `decision.escalate` is true, append `case_event` with
   `append_event(idempotency_key, expected_version)`.

The default `judge` runner returns the same typed decision and the exact
data-store operation envelope for deterministic hosted harness and registry
dogfood runs. Both paths use the same package files and same policy rules.

## Refusals And Stops

- Missing `policy_rules` returns `needs_human` and refuses to escalate.
- Unknown severity returns `needs_human`; the skill does not invent severity.
- A lane not declared in `policy_rules.escalation_lanes` returns `needs_human`.
- A missing `target_rail` returns `needs_human`.
- A prior active case returns `no_change` with no escalation packet.
- No matched severity threshold or churn signal returns `no_change`.

## Invocation

```bash
runx skill ./skills/escalation-judge \
  --input-json triage_packet='{"classification":"billing","severity":"critical","confidence":0.94}' \
  -i thread_body="Customer says they will churn today unless restored." \
  --input-json policy_rules='{"severity_thresholds":{"high":"priority_support"},"churn_risk_signals":[{"signal":"explicit_churn","lane":"priority_support","patterns":["will churn"]}],"escalation_lanes":{"priority_support":{"target_rail":"slack://support-priority"}}}' \
  -i aggregate_id=thread-4821 \
  --input-json expected_version=0 \
  -i idempotency_key=thread-4821:escalate:v1 \
  --json
```

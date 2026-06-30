---
name: escalation-judge
description: Judge support-thread escalation against named policy thresholds and append a durable case record without posting or sending.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
    require_enforcement: false
inputs:
  triage_packet:
    type: json
    required: true
    description: Packet from support-triage-reply with classification, severity, and confidence.
  thread_body:
    type: string
    required: true
    description: Bounded support thread text used to ground severity and churn signals.
  policy_rules:
    type: json
    required: true
    description: Severity thresholds, churn risk signals, and declared escalation lanes.
  aggregate_id:
    type: string
    required: true
    description: Support thread id and data-store aggregate id.
  expected_version:
    type: number
    required: true
    description: Compare-and-set version expected before appending the case record.
  idempotency_key:
    type: string
    required: true
    description: Stable retry key for the case append.
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
---

# Escalation Judge

`escalation-judge` decides whether a support thread needs a priority lane: severity, churn risk, legal review, or executive visibility. It reads a triage packet, thread body, policy rules, and a prior-case projection for the same thread; compares grounded signals against named thresholds; appends a durable case record when escalation is warranted; and emits a typed escalation packet naming the downstream target rail.

The skill never posts to Slack and never sends cross-provider messages. Internal Slack or external provider egress happens only through a separate governed run named by the packet, such as `slack-notify` or `send-as`.

## Contract

- Typed inputs are `triage_packet{classification,severity,confidence}`, `thread_body`, `policy_rules{severity_thresholds,churn_risk_signals,escalation_lanes}`, `aggregate_id`, `expected_version`, and `idempotency_key`.
- Output is a `runx.escalation_judgment.v1` packet containing:
  - `decision{escalate,lane,reason}`
  - `case_id` and `data_store.append_event` only when escalation is warranted
  - one typed `escalation_packet` only when escalation is warranted
  - `stop` / `needs_human` when policy is missing, a lane is undeclared, severity is ambiguous, or a prior escalation already exists.

## Decision rules

- Refuse to escalate without `policy_rules`.
- Refuse to route to any lane not declared in `policy_rules.escalation_lanes`.
- Never invent severity or churn signals; signals must be present in `triage_packet` or grounded in `thread_body`.
- If severity meets a named lane threshold, escalate to that lane.
- If a declared churn signal phrase is found in the thread body, escalate to that signal's declared lane.
- If no threshold matches, seal `decision.escalate=false` with reason `no_change`, no append, and no packet.

## State and authority boundary

The state operation is modeled against `registry:runx/data-store@0.1.2` with pinned `store_id = runx-escalation-judge-store-v1`:

1. `read_projection` for the support thread aggregate id
2. decide against named policy thresholds
3. `append_event(idempotency_key, expected_version)` as an ungated CAS case write
4. emit a typed packet that names the downstream target rail

The append is durable state. The egress is not performed here.

## Local verification

```bash
runx harness ./skills/escalation-judge
```

Dogfood after publish:

```bash
runx skill <owner>/escalation-judge@0.1.0 --json \
  --input-json triage_packet='{"classification":"billing_outage","severity":"sev1","confidence":0.93}' \
  -i thread_body='Enterprise renewal blocked; CFO says they will cancel unless the outage is prioritized today.' \
  --input-json policy_rules='{"severity_order":["sev4","sev3","sev2","sev1"],"severity_thresholds":{"priority_support":{"minimum_severity":"sev2","name":"sev2_or_higher_priority_support"}},"churn_risk_signals":[{"name":"renewal_blocked","phrases":["renewal blocked","will cancel"],"lane":"priority_support"}],"escalation_lanes":{"priority_support":{"target_rail":"slack://support-priority","driver":"slack-notify"}}}' \
  -i aggregate_id=thread:dogfood-escalation-001 \
  --input-json expected_version=0 \
  -i idempotency_key=thread:dogfood-escalation-001:escalation:2026-06-30
```

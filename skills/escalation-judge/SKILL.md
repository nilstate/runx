---
name: escalation-judge
description: Decide whether a support thread should open an escalation case, append that case to data-store, and name the downstream rail without dispatching it.
runx:
  category: support
---

# Escalation Judge

Judge whether a support thread crosses a named escalation policy threshold. The
skill reads a triage packet, the thread body, escalation policy rules, and prior
case state. It appends a durable case record only when escalation is warranted
and emits a typed escalation packet that names the downstream rail. It never
posts to Slack, sends customer email, pages an executive lane, or proposes a
live operational action.

The case append is a guarded compare-and-set write through `data-store`
(`read_projection -> append_event`); the egress consequence is gated elsewhere.
A downstream operator can consume the named target rail and issue a separate
governed `slack-notify` or `send-as` run.

## Inputs

- `triage_packet`: `classification`, `severity`, and `confidence`, normally from
  `support-triage-reply` or an equivalent bounded triage source.
- `thread_body`: support thread text used only to ground severity and churn
  signal checks.
- `policy_rules`: `severity_thresholds`, `churn_risk_signals`, and
  `escalation_lanes`. Missing policy rules produce `needs_input`.
- `data_source_ref` and `store_id`: the pinned data-store binding.
- `aggregate_id`: the thread id. It is the data-store aggregate id.
- `expected_version` and `idempotency_key`: optimistic concurrency and retry
  safety for the case append.

## Output Contract

The output packet is `runx.support.escalation_judge.v1` data:

- `decision{escalate,lane,reason}` always appears.
- `case_id`, `case_event`, and `escalation_packet` appear only when escalation is
  warranted.
- `escalation_packet` names `target_rail` and keeps `rail_effect: none`.
- `stop_state` appears when the thread does not escalate, when required input is
  missing, when policy is ambiguous, or when a policy threshold names an
  undeclared lane.
- `observations` cite the matched threshold, severity, churn signals, prior-case
  projection, case id, stop reason, target rail, harness cases, and data-store
  append controls.

The packet must not contain an `operational_proposal`. It is a judgment and
state append, not a live notification or send.

## State Model

The default graph follows the github-sync-style shape:

1. `read_projection` loads the prior escalation-case projection for the thread.
2. `decide` evaluates severity thresholds and churn signals against declared
   policy lanes.
3. `append_event` records `support_case.escalation_opened` with
   `expected_version` and `idempotency_key` only when
   `decision.escalate == true`.
4. `read_projection` reads back the durable case state for receipt evidence.

If a prior case projection already exists, the skill stops with no new case so
the same thread is not re-escalated.

## Escalation Boundary

The policy must declare every lane under `policy_rules.escalation_lanes`.
Severity thresholds and churn-risk signals can only route to those lanes. If a
threshold names an undeclared lane, the result is `needs_human` and no case is
opened.

Internal lanes should name a downstream rail such as
`downstream.slack-notify.priority-support`. Cross-provider lanes can name a
separate `send-as` rail. This skill only names the rail; the downstream operator
or driver performs the governed action in a separate run.

## Local Harness

Run:

```bash
runx harness ./skills/escalation-judge --json
```

Harness cases:

- `high-severity-churn-opens-priority-case`: critical support thread and renewal
  risk match named policy thresholds, append a case, and emit a priority-support
  escalation packet.
- `low-confidence-howto-stops-no-change`: low-severity how-to thread matches no
  threshold, so the graph stops with `decision.escalate=false`, no case, and no
  escalation packet.
- `missing-policy-needs-input`: policy rules are absent, so the skill refuses to
  escalate and reports `needs_input`.
- `undeclared-lane-needs-human`: a threshold matches but names an undeclared
  lane, so the skill refuses to route and reports `needs_human`.

## Example Invocation

```bash
runx skill escalation-judge --json \
  --input-json triage_packet='{"classification":"bug","severity":"critical","confidence":0.93}' \
  -i thread_body='Enterprise tenant says production webhooks are down, renewal is blocked, and the sponsor may cancel.' \
  --input-json policy_rules='{"severity_thresholds":[{"name":"severity-high-or-critical","lane":"priority_support","min_severity":"high","classifications":["bug"]}],"churn_risk_signals":[{"name":"renewal_blocked","lane":"priority_support","terms":["renewal is blocked","cancel"]}],"escalation_lanes":{"priority_support":{"target_rail":"downstream.slack-notify.priority-support","consequence":"internal_lane"}}}' \
  -i data_source_ref=local://runx-escalation-judge/example \
  -i store_id=escalation-judge-example-v2 \
  -i aggregate_id=thread:acct-4242:case-1001 \
  --input-json expected_version=0 \
  -i idempotency_key=thread:acct-4242:case-1001:escalation:v1
```

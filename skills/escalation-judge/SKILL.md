---
name: escalation-judge
description: Decide whether a triaged thread crosses declared escalation policy, append one case event through data-store, and emit a typed downstream packet without posting or sending.
runx:
  category: ops
---

# Escalation Judge

Escalation Judge turns an issue, support, or incident thread into one bounded
decision: escalate, stop, or ask for human input. It is a judge and case opener,
not a notifier. It reads the existing case projection, compares a triage packet
and thread body against declared policy rules, appends exactly one case event
through `registry:runx/data-store@0.1.2` when escalation is warranted, and emits
a typed packet naming the downstream rail. The downstream operator or driver
must issue a separate governed `slack-notify` run for an internal lane or
`send-as` run for a cross-provider lane.

## What This Skill Does

1. **Validate policy first.** Refuse when `policy_rules` are missing, when
   `escalation_lanes` are empty, or when the selected lane is not declared.
2. **Read prior case state.** Use the thread id as `aggregate_id` and read the
   projection before deciding. Existing open cases are treated as state, not
   ignored duplicate work.
3. **Match named thresholds.** Escalate only when the triage severity or
   grounded churn-risk signal crosses a named policy threshold. Do not invent
   severity or signals outside `triage_packet` and `thread_body`.
4. **Append one case event.** For an escalation, append an ungated CAS event via
   `append_event(idempotency_key, expected_version)` on
   `registry:runx/data-store@0.1.2`. The output includes the appended
   `case_id`, store id, aggregate id, expected version, and event type.
5. **Name the target rail.** Emit an escalation packet that names only the
   target rail and lane. It never posts to Slack, sends email, opens GitHub
   comments, or calls a provider itself.
6. **Stop cleanly.** For no threshold match, return `decision.escalate: false`
   with reason `no_change`, no case event, and no escalation packet. For
   ambiguous severity or missing policy detail, return `needs_human`.

## Contract Boundaries

- **Inputs are typed.**
  - `triage_packet`: `classification`, `severity`, `confidence`, and optional
    `signals`.
  - `thread_body`: source text used only for grounded signal confirmation.
  - `policy_rules`: `severity_thresholds`, `churn_risk_signals`, and
    `escalation_lanes`.
  - `aggregate_id`: the stable thread id and data-store aggregate id.
  - `expected_version`: the projection version read before append.
  - `idempotency_key`: stable key for the append.
- **State is explicit.** The data-store shape is
  `read_projection -> decide -> append_event(idempotency_key, expected_version)`.
  A caller must pin a `store_id`; the default harness store is
  `runx-escalation-cases`.
- **Output is typed.** The primary artifact is `escalation_judgment`, containing
  `decision`, `data_store`, optional `case_event`, optional
  `escalation_packet`, `needs_input`, and `needs_human`.
- **No provider send.** The escalation packet names `slack-notify` or `send-as`
  as the target rail. Execution of that rail is a separate governed run.

## Refusals And Stops

- Refuse if `policy_rules` are absent.
- Refuse if the chosen lane is not in `policy_rules.escalation_lanes`.
- Refuse if the task asks this skill to post, send, page, or notify directly.
- Return `needs_human` when severity is ambiguous, policy thresholds conflict,
  or thread evidence cannot ground a churn signal.
- Return a sealed stop with `reason: no_change` when policy exists but no
  threshold is crossed.

## Decision Rules

Severity thresholds are named rules, for example:

```yaml
severity_thresholds:
  sev2_customer_impact:
    min_severity: high
    lane: customer-risk-internal
    target_rail: slack-notify
```

Churn-risk signals are also named rules:

```yaml
churn_risk_signals:
  renewal_blocked:
    keywords: ["renewal blocked", "contract at risk"]
    lane: customer-risk-external
    target_rail: send-as
```

The output must cite the exact rule name matched, the evidence source, and the
lane. If several rules match, choose the most severe declared threshold, then
prefer the policy order. If none match, stop with `no_change`.

## Quality Profile

- Purpose: make one auditable escalation decision for a triaged thread.
- Audience: operators, reviewers, and downstream governed notification lanes.
- Artifact contract: read projection, named policy match, case append result,
  target rail packet, and refusal/stop reason.
- Evidence bar: every escalation cites the severity or churn signal and the
  named threshold; every append cites `store_id`, `aggregate_id`,
  `expected_version`, `idempotency_key`, and `case_id`.
- Safety bar: policy is caller-owned, lanes are allowlisted, and sends are
  always deferred to a separate governed skill.
- Stop conditions: missing policy, undeclared lane, ambiguous severity, or no
  threshold match.

## Output Schema

```yaml
escalation_judgment:
  decision:
    escalate: boolean
    lane: string | null
    reason: policy_threshold_matched | no_change | needs_human | refused
    matched_policy: string | null
    matched_threshold: string | null
  evidence:
    severity: string
    confidence: number
    grounded_signals:
      - name: string
        source: triage_packet | thread_body
        excerpt_or_ref: string
  data_store:
    store_id: string
    aggregate_id: string
    read_projection:
      version: number
      open_case_ids: [string]
      prior_escalation_count: number
    append_event:
      attempted: boolean
      idempotency_key: string
      expected_version: number
      event_type: escalation.case_opened | null
      case_id: string | null
  case_event:
    case_id: string
    event_type: escalation.case_opened
    aggregate_id: string
    payload:
      classification: string
      severity: string
      lane: string
      matched_policy: string
  escalation_packet:
    packet_type: runx.escalation.packet.v1
    case_id: string
    target_rail: slack-notify | send-as
    lane: string
    thread_ref: string
    summary: string
  needs_input: [string]
  needs_human: [string]
```

## Inputs

- `triage_packet` (required): classification, severity, confidence, and
  optional signals from an upstream triage skill.
- `thread_body` (required): sanitized thread body or digest-bearing excerpt.
- `policy_rules` (required): severity thresholds, churn-risk signals, and
  declared escalation lanes.
- `aggregate_id` (required): stable thread id and data-store aggregate id.
- `expected_version` (required): projection version expected by the append.
- `idempotency_key` (required): stable idempotency key for the case append.
- `store_id` (optional): pinned data-store id; defaults to
  `runx-escalation-cases`.

---
name: renewal-risk-judge
description: Judge renewal risk from sealed usage, support, and payment signals, then emit a read-only save-plan recommendation when warranted.
runx:
  category: ops
---

# Renewal Risk Judge

## What this skill does

`renewal-risk-judge` fuses three bounded inputs for one renewing account:
usage signals, support history, and a payment snapshot. It emits one
`runx.support.renewal_risk.v1` decision packet with a risk level, justification,
signal weights, escalation path, and, only for high or critical risk, a bounded
save-message plan.

The skill is read-only over money and delivery. It does not quote prices, apply
discounts, mutate billing, touch payment rails, send a message, or trigger a
provider action. The save plan is data for a separate governed `send-as` lane
that must run under its own authority and human approval.

## When to use this skill

Use this skill when an operator, support workflow, or renewal operations graph
has receipt-backed signals for one account and needs a trustworthy renewal-risk
verdict before deciding whether to prepare a save message.

Good inputs are current, sealed, and account-scoped:

- `usage_signals` with `trend` and `mau_pct_change`
- `support_history` with `volume` and `ticket_severity_avg`
- `payment_snapshot` with `days_late` and `churn_flag`
- optional `operator_context` with policy, approval, or content reference rules

## When not to use this skill

Do not use this skill to send retention messages, apply discounts, approve
refunds, change subscription state, change a price, charge a payment method, or
make promises to the customer. Do not run it when the usage trend is missing or
when the supplied signals contradict each other in a way that prevents a
grounded verdict.

If the account needs an actual message, hand the emitted save plan to a
separate governed `send-as` run. If the account needs a commercial concession,
billing mutation, or live outreach, stop for the appropriate human approval and
provider-specific lane.

## Procedure

1. Confirm that the account scope is one bounded renewal decision and that all
   inputs describe the same account and renewal window.
2. Require `usage_signals.trend` and `usage_signals.mau_pct_change`. Without
   usage trend data, return a refused packet and do not emit `save_plan`.
3. Normalize support pressure from `support_history.volume` and
   `support_history.ticket_severity_avg`.
4. Normalize payment pressure from `payment_snapshot.days_late` and
   `payment_snapshot.churn_flag`.
5. Refuse contradictory signals when usage shows decline but payment shows no
   lateness, no churn flag, and no other risk evidence.
6. Compute a fused score with explicit weights:
   usage trend `0.50`, support pressure `0.25`, payment pressure `0.25`.
7. Map the fused score to `low`, `moderate`, `high`, or `critical`.
8. For `high` or `critical`, emit one bounded `save_plan` with `channel`,
   `audience`, and `content_ref`. The plan may name message content only; it
   must not include amount, currency, counterparty, discount, quote, or send
   authorization.
9. For `moderate` or ambiguous edge cases, route to human approval with no
   send-as dispatch.
10. Record evidence refs, signal weights, missing signals, and the approval
    posture in the packet so the receipt is auditable.

## Edge cases and stop conditions

- Missing `usage_signals`, `usage_signals.trend`, or
  `usage_signals.mau_pct_change`: return `status: refused`, name the missing
  signal, and omit `save_plan`.
- Missing support or payment inputs: return `needs_input` or route to manual
  review rather than inventing pressure.
- Contradictory evidence: refuse to verdict when usage suggests decline but the
  payment snapshot and support history show no corroborating risk.
- Requested discount, quote, credit, payment action, or live send: refuse that
  action and keep the packet recommendation-only.
- Missing or mutable `content_ref`: for high-risk accounts, stop with no
  dispatch-ready save plan until the content is digest-bound.
- Raw customer data, secrets, tokens, or payment material: redact or replace
  with stable refs. Do not put private material in the packet.

## Output schema

The runner emits `renewal_risk` as `runx.support.renewal_risk.v1`:

```yaml
schema: runx.support.renewal_risk.v1
status: verdict | refused | needs_input
account_ref: string
decision:
  risk_level: low | moderate | high | critical | null
  justification: string
score:
  fused: number | null
  weights:
    usage_trend: 0.5
    support_pressure: 0.25
    payment_pressure: 0.25
  components:
    usage_trend: number | null
    support_pressure: number | null
    payment_pressure: number | null
escalation:
  route: none | human_approval | data_quality_review
  approval_required: boolean
  downstream_lane: send-as | null
save_plan:
  channel: email | support_thread | chat
  audience: account_owner | renewal_owner | support_owner
  content_ref: string
refusal:
  reason: string
  missing_signals: [string]
evidence_refs: [string]
```

`save_plan` is present only when `decision.risk_level` is `high` or `critical`
and the content reference is stable. The packet must never include price,
discount, amount, currency, counterparty, payment rail, provider token, or a
send authorization.

## Worked example

High-risk input:

```yaml
usage_signals:
  trend: declining
  mau_pct_change: -42
support_history:
  volume: 18
  ticket_severity_avg: 4.4
payment_snapshot:
  days_late: 17
  churn_flag: true
```

Expected result: `status: verdict`, `decision.risk_level: high`, a fused score
with the three signal weights, `escalation.downstream_lane: send-as`, and one
bounded `save_plan` that names only channel, audience, and `content_ref`.

Missing usage trend input:

```yaml
support_history:
  volume: 8
  ticket_severity_avg: 3.1
payment_snapshot:
  days_late: 9
  churn_flag: false
```

Expected result: `status: refused`, `decision.risk_level: null`,
`refusal.reason: missing_usage_signals`, and no `save_plan`.

## Inputs

- `account_ref` (optional): stable account or renewal reference.
- `usage_signals` (required for verdict): object with `trend` and
  `mau_pct_change`.
- `support_history` (required): object with `volume` and
  `ticket_severity_avg`.
- `payment_snapshot` (required): object with `days_late` and `churn_flag`.
- `operator_context` (optional): approval posture, content reference policy, or
  downstream send-as constraints.

## Outputs

- `renewal_risk`: one `runx.support.renewal_risk.v1` packet containing the
  grounded verdict or refusal.

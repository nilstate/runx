---
name: renewal-risk-judge
description: Judge renewal risk from bounded usage, support, and payment signals, emitting a renewal-risk packet and save-plan recommendation only for high or critical risk.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  usage_signals:
    type: json
    required: true
    description: usage_signals{trend,mau_pct_change}
  support_history:
    type: json
    required: true
    description: support_history{volume,ticket_severity_avg}
  payment_snapshot:
    type: json
    required: true
    description: payment_snapshot{days_late,churn_flag}
  account_ref:
    type: string
    required: false
    description: Stable bounded account reference for save-plan audience.
runx:
  category: ops
  input_resolution:
    required:
      - usage_signals
      - support_history
      - payment_snapshot
---

# Renewal Risk Judge

## What this skill does

`renewal-risk-judge` fuses bounded account signals into one
`runx.support.renewal_risk.v1` packet:

- `usage_signals{trend,mau_pct_change}`;
- `support_history{volume,ticket_severity_avg}`;
- `payment_snapshot{days_late,churn_flag}`.

It emits:

```yaml
decision:
  risk_level: low | moderate | high | critical | refused
  justification: string
  fused_score: number | null
  signal_weights: object
escalation:
  lane: string
  reason: string
save_plan:
  channel: string
  audience: string
  content_ref: string
```

`save_plan` is present only for high or critical risk. It is a recommendation,
not an effect: no message is sent, no authority is minted, and no amount,
currency, or counterparty appears in the plan.

## When to use this skill

Use this skill when a downstream operator or driver needs a bounded renewal
risk verdict before deciding whether a human-approved save motion should be
prepared. High or critical risk can name a downstream `send-as` run by verdict,
but that run must still be governed separately and held for human approval.

## Stop conditions

The skill refuses to verdict when:

- usage trend data is missing;
- `mau_pct_change` is missing;
- support or payment fields are missing;
- contradictory evidence appears, such as usage decline while the payment
  snapshot shows no lateness and no churn risk;
- the output would require invented usage decline or invented payment lateness.

Missing or contradictory evidence returns `decision.risk_level: refused`,
routes to `human_approval`, and emits no `save_plan`.

## Signal weights

- Usage trend and MAU change: weight `0.45`
- Support volume and average severity: weight `0.25`
- Payment lateness and churn flag: weight `0.30`

Risk thresholds:

- `critical`: fused score `>= 0.85`
- `high`: fused score `>= 0.60`
- `moderate`: fused score `>= 0.35`
- `low`: below `0.35`

## Harness cases

- `high_risk_with_save_play`: declining usage, high support volume, high ticket
  severity, late payment, and churn flag. It emits `decision.risk_level: high`
  or stronger and includes one bounded save plan.
- `missing_usage_signals_stop`: missing usage trend blocks qualification, emits
  no save plan, and names the missing signal in the refused reason.

## Authority boundary

This skill performs no send. A separate governed `send-as` run, issued by a
downstream driver or operator and named by the verdict, performs any delivery
only under human approval. Moderate or edge-case accounts route to human
approval and cannot fire `send-as` without that approval.

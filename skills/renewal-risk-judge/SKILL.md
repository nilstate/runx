---
name: renewal-risk-judge
description: Fuse sealed usage, support, and payment snapshot signals into a bounded renewal-risk verdict and save-message recommendation.
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
runx:
  category: support
  input_resolution:
    required:
      - usage_signals
      - support_history
      - payment_snapshot
---

# Renewal Risk Judge

`renewal-risk-judge` is a read-only renewal intervention classifier. It reads
sealed usage signals, support history, and a payment snapshot, fuses them into
one `runx.support.renewal_risk.v1` packet, and includes a bounded save-message
plan only when the risk is high or critical.

The skill does not send, apply discounts, quote prices, touch money rails, mint
authority, or emit an operational proposal. The save plan is data: a human or
downstream lane may read it, and a separate governed `send-as` run must perform
any actual delivery under human approval.

## Contract

Inputs:

- `usage_signals{trend,mau_pct_change}`
- `support_history{volume,ticket_severity_avg}`
- `payment_snapshot{days_late,churn_flag}`

Output packet:

- `runx.support.renewal_risk.v1`
- `decision{risk_level, justification}`
- `escalation`
- `save_plan{channel, audience, content_ref}` only for high or critical risk

The `save_plan` is deliberately bounded to message content only. It never
contains amount, currency, counterparty, discount, invoice, or payment rail data.

## Scoring

The fused score is transparent and bounded:

- Usage trend weight: 45 points
- Support burden weight: 25 points
- Payment risk weight: 30 points

Risk bands:

- `critical`: reserved for future critical-only signals above the v0.1
  100-point scale
- `high`: 65-100
- `moderate`: 35-64
- `low`: below 35

## Refusals and human lane

- Missing `usage_signals.trend` stops the qualify sub-step; no save plan is
  emitted and the reason names the missing signal.
- Contradictory input where usage clearly declines while the payment snapshot
  shows no renewal risk stops for human review instead of inventing a reason.
- Moderate or edge cases route to `support.renewal_risk.human_approval`; no
  send-as delivery can fire without approval.

## Verification

Local harness:

```bash
runx harness ./skills/renewal-risk-judge
```

Example dogfood run:

```bash
runx skill ./skills/renewal-risk-judge --json \
  --input-json usage_signals='{"trend":"declining","mau_pct_change":-38}' \
  --input-json support_history='{"volume":11,"ticket_severity_avg":4.2}' \
  --input-json payment_snapshot='{"days_late":12,"churn_flag":true}'
```

# Frantic #62-#69 runx skill verification report

This report covers the eight prepared runx skill packages in PR
<https://github.com/runxhq/runx/pull/182>.

All packages were tested under Ubuntu-24.04 in WSL using `runx-cli 0.6.14`.
The earlier Windows receipt-store issue is not present in this environment.

| Bounty | Package | Harness result | Cases |
| --- | --- | --- | --- |
| #62 | `spam-risk-reviewer` | passed | `low-risk-verified-sender`, `high-risk-incomplete-auth-poor-list` |
| #63 | `renewal-risk-judge` | passed | `high_risk_with_save_play`, `missing_usage_signals_stop` |
| #64 | `oncall-alert-triage` | passed | `sealed_escalate_checkout_alert`, `stop_unsealed_runbook_needs_agent` |
| #65 | `deliverability-judge` | passed | `sealed_healthy_signals_continue`, `contradictory_signals_escalate` |
| #66 | `flaky-test-judge` | passed | `quarantine_justified`, `missing_run_history` |
| #67 | `mandate-planner` | passed | `in_grant_charter`, `out_of_grant_charter` |
| #68 | `list-hygiene-judge` | passed | `sealed_decay_re_permission`, `sealed_hard_bounce_suppress`, `stop_missing_or_stale_evidence` |
| #69 | `escalation-judge` | passed | `sealed_priority_escalation`, `stop_no_threshold_no_change` |

The package source lives under `skills/<package>/`. Each package has an
`X.yaml`, `SKILL.md`, `run.mjs`, and deterministic fixtures. The skills are
read-only or bounded packet emitters; public sends, authority minting, direct
money movement, deployment, and live external effects are either absent or
routed to explicit downstream governed lanes.

Remaining before final Frantic delivery:

1. successfully claim the bounty slot;
2. publish the exact package to the runx registry;
3. run hosted registry harness;
4. run a post-publish dogfood invocation;
5. verify the emitted receipt and submit the final Frantic artifact fields.

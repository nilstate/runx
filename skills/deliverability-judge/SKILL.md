---
name: deliverability-judge
description: Read-only deliverability posture judge that fuses sealed provider evidence into a continue/throttle/pause recommendation or a human-escalation refusal.
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
  evidence:
    type: object
    required: true
    description: Sealed deliverability evidence with postmaster_report, bounce_metrics, complaint_metrics, and placement_probe.
  policy:
    type: object
    required: true
    description: Operator thresholds with min_reputation_score, max_bounce_pct, and max_complaint_pct.
runx:
  category: ops
  input_resolution:
    required:
      - evidence
      - policy
---

# deliverability-judge

Use this skill when an operator needs a read-only judgment on whether a sending
posture is healthy enough to continue sending.

The skill fuses four sealed provider signals:

- `postmaster_report.reputation_score`
- `bounce_metrics.bounce_pct`
- `complaint_metrics.complaint_pct`
- `placement_probe.passed`

It compares those signals against an operator policy:

- `min_reputation_score`
- `max_bounce_pct`
- `max_complaint_pct`

The output is a JSON verdict. When all signals are sealed, present, and
non-contradictory, the verdict includes a read-only recommendation:

- `continue` for healthy posture
- `throttle` for moderate aligned risk
- `pause` for clearly unhealthy aligned risk

When signals are missing, unsealed, or contradictory, the skill refuses to emit
a recommendation and returns an escalation record instead.

This skill is read-only. It mints no authority, holds no state, emits no Effect,
and never performs a send, throttle, payment, or operational handoff.

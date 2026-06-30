---
name: deliverability-judge
description: Fuse sealed deliverability evidence into a read-only continue, throttle, or pause recommendation without emitting effects.
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
  evidence:
    type: json
    required: true
    description: Sealed provider evidence with postmaster, bounce, complaint, and placement signals.
  policy:
    type: json
    required: true
    description: Operator thresholds for reputation, bounce rate, and complaint rate.
runx:
  category: compliance
  input_resolution:
    required:
      - evidence
      - policy
---

# Deliverability Judge

`deliverability-judge` sits upstream of any send or throttle rail. It fuses
sealed provider evidence into one read-only verdict and recommendation:
`continue`, `throttle`, or `pause`.

It does not send, throttle, hold state, mint authority, emit an Effect, create an
`operational_proposal.v1` envelope, or create an `AttenuationRequest`.
Contradictory or partial signals seal as an escalation record instead of a
recommendation. A human or downstream deliverability lane may later dispatch a
separate governed throttle run by name.

## Inputs

- `evidence.postmaster_report`
- `evidence.bounce_metrics`
- `evidence.complaint_metrics`
- `evidence.placement_probe`
- `policy.min_reputation_score`
- `policy.max_bounce_pct`
- `policy.max_complaint_pct`

Each evidence signal must be sealed and carry `source` and `timestamp`.

## Decision rules

- Healthy reputation, bounce, complaint, and placement signals emit
  `verdict.state: healthy` and `recommendation.action: continue`.
- Degraded but non-contradictory signals emit `throttle` or `pause` depending
  on severity.
- High reputation contradicted by high bounce or complaint rates refuses to
  fuse and escalates.
- Missing or unsealed signals refuse to fuse and escalate.
- The runner never invents missing signals.

## Verification

Local harness:

```bash
runx harness ./skills/deliverability-judge --json
```

Dogfood fixture run:

```bash
runx skill ./skills/deliverability-judge --json \
  --input-json evidence=@fixtures/healthy-evidence.json \
  --input-json policy=@fixtures/operator-policy.json
```


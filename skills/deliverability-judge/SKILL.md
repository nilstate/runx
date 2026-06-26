---
name: deliverability-judge
description: Fuse sealed deliverability signals into a read-only verdict and recommendation.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 10
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
runx:
  category: deliverability
  tags:
    - deliverability
    - reputation
    - placement
links:
  source: https://github.com/Li-AmG/deliverability-judge-skill
---

# Deliverability Judge

`deliverability-judge` is a read-only SHAPE-A judgment skill. It accepts sealed
postmaster, bounce, complaint, and placement-probe evidence plus a policy, then
emits a typed deliverability verdict and a recommendation only when every signal
is sealed and non-contradictory.

The skill never sends mail, never throttles a campaign, never changes DNS,
never mutates a subscriber list, never holds state, and never mints authority.
If a live throttle lane exists later, that is a separate governed run dispatched
by naming. This skill only emits a decision packet a human or downstream lane can
read.

## Inputs

- `evidence.postmaster_report{sealed, source, timestamp, reputation_score}`
- `evidence.bounce_metrics{sealed, source, timestamp, bounce_pct}`
- `evidence.complaint_metrics{sealed, source, timestamp, complaint_pct}`
- `evidence.placement_probe{sealed, source, timestamp, inbox_placement_pct}`
- `policy{min_reputation_score, max_bounce_pct, max_complaint_pct, min_inbox_placement_pct}`

## Output

The skill writes one JSON object to stdout containing:

- `verdict{state, confidence_window, reason}`
- `recommendation{action, signal_bindings, evidence_hash}` only for a healthy,
  fully sealed, non-contradictory signal set
- `escalation_record{reason, signals}` when evidence is missing, unsealed, or
  contradictory
- `evidence_json` and `report_md` for delivery review

## Decision Contract

- `verdict.state=healthy` is allowed only when all four signals are sealed,
  present, within policy, and non-contradictory.
- `recommendation.action=continue` is emitted only with a deterministic
  `evidence_hash` over the signal values and policy.
- Contradictory evidence such as high reputation with high bounce rate, high
  complaints, or poor inbox placement escalates to a human reviewer and emits no
  recommendation.
- Partial, unsealed, malformed, or timestamp-less evidence escalates.
- The output is a read-only recommendation, not an Effect, operational proposal,
  or AttenuationRequest.

## Harness Cases

- `sealed_healthy_signals_continue`: sealed healthy reputation, low bounce, low
  complaints, and strong placement produce `verdict.healthy` and
  `recommendation.action=continue`.
- `contradictory_signals_escalate`: high reputation conflicts with high bounce
  and weak placement, so no recommendation is emitted and the refusal still
  seals as an escalation record.

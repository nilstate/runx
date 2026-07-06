---
name: deliverability-judge
description: Judge whether a sending posture is healthy enough to send by fusing sealed postmaster reputation, bounce, complaint, and placement-probe evidence against operator policy thresholds into one read-only verdict (continue, throttle, or pause) with a confidence window, escalating instead of guessing when signals contradict or are too thin.
runx:
  category: ops
---

# Deliverability Judge

send-as gates a send by approval and the provider delivers once approved, but
neither judges whether the sending posture is healthy enough to send at all.
deliverability-judge sits upstream of both: it reads sealed provider evidence
(postmaster reputation, bounce rate, complaint rate, placement probe) against
operator policy thresholds, fuses them into one verdict with a confidence
window, and recommends `continue`, `throttle`, or `pause`.

A single-threshold check would be a tool. The judgment here is fusing signals
that disagree — and refusing to call a verdict when they contradict. A 96
reputation score next to a 9.5% bounce rate does not average into "mostly
fine"; it means the evidence disagrees with itself (a stale report, a wrong
stream, a poisoned list) and a human needs to look before anything sends.

This skill is read-only (SHAPE-A). It mints no authority, holds no state, and
emits no Effect: no `operational_proposal.v1` envelope and no
AttenuationRequest. The sealed verdict is a recommendation a human or a
downstream deliverability lane reads. When the T5 deliverability family ships
a live throttle, that throttle is a separate governed run an operator
dispatches by naming; this judge never auto-executes it.

## What This Skill Does

1. **Seal-check every signal.** All four signals — `postmaster_report`,
   `bounce_metrics`, `complaint_metrics`, `placement_probe` — must be present
   and each sealed with a `source` and a parseable `timestamp`. A partial or
   unsealed signal set escalates with the missing signal names; the judge
   never invents a signal it cannot find sealed in the evidence.
2. **Evaluate each signal against policy.** Reputation is scored against
   `min_reputation_score`, bounce rate against `max_bounce_pct`, complaint
   rate against `max_complaint_pct`, and inbox placement against
   `min_inbox_rate_pct`. Rates built from raw counts carry a Wilson 95%
   interval, so 2 bounces in 100 sends is honestly wide while the same rate
   over 50,000 sends is tight. Rates reported without a denominator carry a
   fixed uncertainty penalty.
3. **Refuse contradictions.** When one signal is strongly healthy and another
   strongly failing (high reputation against a high bounce rate is the
   canonical case), no verdict is issued. The escalation names both sides of
   the contradiction and every evaluation that fed it.
4. **Fuse what agrees.** Non-contradictory sealed signals fuse into a verdict
   state — `healthy`, `degraded`, or `at_risk` — by weakest link: any signal
   breaching policy degrades the verdict, two or more put it at risk. The
   confidence window is the evidence-weighted spread of the fused score; a
   window wider than `max_confidence_window` escalates as too uncertain to
   call.
5. **Recommend, read-only.** `continue` for healthy, `throttle` for degraded,
   `pause` for at risk. The recommendation binds each signal it relied on
   (source, timestamp, measured value, threshold, status) and carries a
   sha256 `evidence_hash` of the exact evidence judged.

## Refusals And Stops

- Malformed or missing `evidence` or `policy` input exits with a usage
  refusal and no analysis.
- A missing or unsealed signal (no source, no parseable timestamp) produces
  an escalation record naming the signal; no verdict, no recommendation.
- A signal with no measurable volume (zero sends, zero seeds) escalates as
  too thin to judge.
- Contradictory strong signals escalate with both sides named. The refusal
  seals: the receipt records that judgment was refused and why, which is
  itself the deliverable.
- Escalations recommend nothing. A human deliverability reviewer, or a
  downstream governed lane, decides what happens next.

## Inputs

- `evidence` (required): object with four signal blocks, each sealed with
  `source` (string) and `timestamp` (ISO 8601):
  - `postmaster_report`: `reputation_score` (number, 0–100 scale).
  - `bounce_metrics`: `sends` + `bounces` counts, or `bounce_rate_pct`.
  - `complaint_metrics`: `delivered` + `complaints` counts, or
    `complaint_rate_pct`.
  - `placement_probe`: `seeds` + `inbox` counts, or `inbox_rate_pct`.
- `policy` (required): `min_reputation_score`, `max_bounce_pct`,
  `max_complaint_pct` (required numbers); `min_inbox_rate_pct` (optional,
  default 80); `max_confidence_window` (optional, default 0.5).

## Output Schema

```yaml
# When every signal is sealed and non-contradictory:
verdict:
  state: healthy | degraded | at_risk
  confidence_window: [number, number]   # fused score spread, 0..1
  reason: string
recommendation:
  action: continue | throttle | pause
  read_only: true
  signal_bindings:
    - signal: string
      source: string
      timestamp: string
      measured: string
      threshold: string
      status: pass | warn | fail
  evidence_hash: string                 # sha256 of the canonicalized evidence

# Otherwise, an escalation record instead:
escalation:
  kind: deliverability_escalation
  reason: string
  missing_or_unsealed: [{signal, problem}]      # when the set is partial
  contradicting_signals: {healthy_side, failing_side}  # when signals disagree
  signal_evaluations: [...]
  next_step: string
```

## Quality Profile

- Purpose: decide whether a sending posture is healthy enough to send, before
  any send is approved or delivered.
- Audience: deliverability operators, ESP integrators, and reviewers of
  governed sending lanes.
- Artifact contract: one verdict with a confidence window and a bound
  recommendation, or one escalation record naming exactly what blocked
  judgment.
- Evidence bar: every signal evaluation cites its sealed source, timestamp,
  measured value, and the policy threshold it was judged against; the
  recommendation hashes the evidence it fused.
- Safety bar: read-only and deterministic; no network calls, no state, no
  Effect, no authority minted; contradictory or unsealed evidence escalates
  to a human instead of averaging into a verdict.
- Stop conditions: malformed input, a partial or unsealed signal set, no
  measurable volume, contradiction between strong signals, or a confidence
  window too wide to support a call.

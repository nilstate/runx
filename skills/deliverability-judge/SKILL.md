---
name: deliverability-judge
description: Fuse sealed provider evidence against operator policy thresholds to produce a read-only deliverability verdict and recommendation.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - deliverability
    - email
    - judgment
    - read-only
links:
  source: https://github.com/deltah9420/runx/tree/main/skills/deliverability-judge
---

## What this skill does

This skill reads sealed provider evidence — postmaster reputation, bounce rate,
complaint rate, and inbox placement probe — and fuses it against operator policy
thresholds to produce a deliverability verdict and a read-only recommendation.

The skill is read-only. It mints no authority, holds no state, emits no Effect,
and cannot trigger a send-as run or live throttle action. The recommendation
(continue, throttle, or pause) is a signal for a human or a downstream
deliverability lane to read; the live throttle, when the T5 deliverability
family ships, is a separate governed run an operator dispatches by naming.

## When to use this skill

Use this skill when an operator needs a reproducible, sealed judgment on whether
an email sending posture is healthy enough to continue sending. It is
appropriate when all four provider signals are available as sealed evidence and
the operator has defined policy thresholds for reputation, bounce, and
complaint rates.

The skill is especially useful upstream of a send-as gate: it produces a
verdict that a human reviewer or downstream lane can inspect before approving
or pausing sends.

## When not to use this skill

Do not use this skill when signals are missing, unsealed, or when you need a
live throttle action. This skill never executes a throttle, pause, or resume
action — it only emits a recommendation. A separate governed run handles the
live action under human approval.

Do not use this skill to invent signals not present in the sealed evidence, to
fuse contradictory signals into a false verdict, or to bypass a human approval
gate for deliverability decisions.

## Procedure

1. Read the `evidence` input containing four sealed signal objects.
2. Validate that all four signals are present and each has a `source` and `timestamp`.
3. Extract the numeric values: reputation_score, bounce_pct, complaint_pct, inbox_pct.
4. Compare each signal against the `policy` thresholds.
5. Check for contradictions: high reputation paired with high bounce or high complaint.
6. If all signals are sealed, within policy, and non-contradictory → emit `verdict.healthy` with `recommendation.action continue`.
7. If signals contradict → refuse to emit a recommendation; emit an escalation record naming the contradicting signals.
8. If signals are missing or unsealed → refuse; emit an escalation record naming the missing signals.
9. Write `evidence.json` and `report.md` when `output_dir` is provided.

## Edge cases and stop conditions

Return `needs_input` when the `evidence` input is missing or empty. Return
`refused` when the caller asks the skill to execute a throttle action, persist
state, mint authority, or access a money rail.

Stop with an error when a signal object lacks `source` or `timestamp`, when
numeric values are outside plausible ranges (reputation 0-100, percentages
0-100), or when the skill is asked to invent a signal not present in the
evidence.

Contradictory signals always escalate. A high reputation score (at or above
`min_reputation_score`) paired with a bounce rate above `max_bounce_pct` is a
contradiction: the reputation says "healthy" but the bounce data says
"degraded." The same applies to high reputation paired with high complaints.
The skill refuses to resolve the contradiction and instead names both signals
in the escalation record.

## Output schema

The primary output is `deliverability_verdict`, with schema
`deliverability.judge.result.v1`:

```json
{
  "schema": "deliverability.judge.result.v1",
  "data": {
    "verdict": {
      "state": "healthy | degraded | critical | refused",
      "confidence_window": "7d",
      "reason": "string"
    },
    "signals": {
      "postmaster_report": { "sealed": true, "within_policy": true, "value": 0, "threshold": 0 },
      "bounce_metrics": { "sealed": true, "within_policy": true, "value": 0, "threshold": 0 },
      "complaint_metrics": { "sealed": true, "within_policy": true, "value": 0, "threshold": 0 },
      "placement_probe": { "sealed": true, "within_policy": true, "value": 0 }
    },
    "recommendation": {
      "action": "continue | throttle | pause | none",
      "signal_bindings": [],
      "evidence_hash": "sha256:hex"
    },
    "contradictions": [],
    "missing_signals": [],
    "refusal_reason": null,
    "validation": {
      "valid": true,
      "every_signal_sealed": true,
      "every_signal_has_source": true,
      "every_signal_has_timestamp": true,
      "no_contradictions": true,
      "no_invented_signals": true
    }
  }
}
```

When signals contradict or are missing, `recommendation` is null and
`refusal_reason` names the issue.

When `output_dir` is provided, the runner also writes `evidence.json` and
`report.md` inside that directory and returns their relative paths in
`data.artifacts`.

## Worked example

Healthy signals, all within policy:

```bash
runx skill "$PWD" \
  --input evidence='{"postmaster_report":{"source":"postmaster.example.com","timestamp":"2026-06-25T12:00:00Z","reputation_score":95,"domain":"example.com"},"bounce_metrics":{"source":"bounce-monitor.example.com","timestamp":"2026-06-25T12:00:00Z","bounce_pct":1.2},"complaint_metrics":{"source":"feedback-loop.example.com","timestamp":"2026-06-25T12:00:00Z","complaint_pct":0.05},"placement_probe":{"source":"placement-test.example.com","timestamp":"2026-06-25T12:00:00Z","inbox_pct":97.5}}' \
  --input policy='{"min_reputation_score":80,"max_bounce_pct":5,"max_complaint_pct":0.3}' \
  --input output_dir=artifacts/healthy \
  --json
```

Expected: `verdict.state` is `healthy`, `recommendation.action` is `continue`,
all four signals show `sealed: true` and `within_policy: true`.

Contradictory signals (high reputation, high bounce):

```bash
runx skill "$PWD" \
  --input evidence='{"postmaster_report":{"source":"postmaster.example.com","timestamp":"2026-06-25T12:00:00Z","reputation_score":92,"domain":"example.com"},"bounce_metrics":{"source":"bounce-monitor.example.com","timestamp":"2026-06-25T12:00:00Z","bounce_pct":8.5},"complaint_metrics":{"source":"feedback-loop.example.com","timestamp":"2026-06-25T12:00:00Z","complaint_pct":0.05},"placement_probe":{"source":"placement-test.example.com","timestamp":"2026-06-25T12:00:00Z","inbox_pct":95.0}}' \
  --input policy='{"min_reputation_score":80,"max_bounce_pct":5,"max_complaint_pct":0.3}' \
  --input output_dir=artifacts/contradictory \
  --json
```

Expected: `verdict.state` is `refused`, `recommendation` is null,
`contradictions` names the reputation-vs-bounce conflict.

## Inputs

- `evidence`: sealed provider evidence with four signal objects (see schema above).
- `policy`: operator thresholds — `min_reputation_score`, `max_bounce_pct`, `max_complaint_pct`.
- `output_dir`: optional directory for `evidence.json` and `report.md`.

## Outputs

- `deliverability_verdict`: complete verdict packet.
- `evidence_json`: same evidence as machine-checkable JSON.
- `report_md`: concise report with signal evaluations, verdict, and recommendation.

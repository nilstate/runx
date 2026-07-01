# Local Evidence

Toolchain:

```text
runx-cli 0.6.14
node v22.17.1
```

Direct runner verification was executed against the same inputs used by the
inline harness cases.

## sealed_healthy_signals_continue

Expected: sealed evidence fuses into a healthy verdict and read-only
`continue` recommendation.

Observed:

```json
{
  "verdict": {
    "state": "healthy",
    "confidence_window": "high",
    "reason": "all_sealed_signals_pass_policy"
  },
  "recommendation": {
    "action": "continue",
    "signal_bindings": {
      "postmaster_report": "google-postmaster",
      "bounce_metrics": "esp-bounce-export",
      "complaint_metrics": "feedback-loop",
      "placement_probe": "seed-inbox-probe"
    },
    "evidence_hash": "de4d14b9583c678f096fecbc0a147a20b9f86ca17b8d297420ba9365bf718c5a"
  }
}
```

## contradictory_signals_escalate

Expected: contradictory sealed signals refuse a recommendation and escalate.

Observed:

```json
{
  "verdict": {
    "state": "escalate",
    "confidence_window": "low",
    "reason": "contradictory_signals"
  },
  "escalation": {
    "reason": "Signals disagree, so no read-only recommendation is emitted.",
    "contradictions": [
      "high_reputation_conflicts_with_high_bounce"
    ],
    "signal_names": [
      "postmaster_report",
      "bounce_metrics",
      "complaint_metrics",
      "placement_probe"
    ]
  }
}
```

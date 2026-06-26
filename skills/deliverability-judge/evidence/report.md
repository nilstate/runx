# Deliverability Judge — Evidence Report

## What was built

A read-only runx skill that fuses sealed provider email deliverability evidence against operator policy thresholds to produce a verdict and recommendation.

## Why it's trustworthy

- **Read-only**: Mints no authority, holds no state, emits no Effect
- **Grounded judgments**: Every signal evaluation is tied to sealed evidence with source and timestamp
- **Contradiction refusal**: High reputation paired with high bounce/complaint rates triggers a refusal, not a false verdict
- **No invented signals**: Only the four declared signals are evaluated; the skill never fabricates data
- **Sealed receipts**: Both harness cases produce sealed receipts with Ed25519 signatures

## How to install, run, and verify

### Install
```bash
runx add deltah9420/deliverability-judge@0.1.0 --registry https://api.runx.ai
```

### Run (healthy example)
```bash
runx skill deltah9420/deliverability-judge@0.1.0 --registry https://api.runx.ai \
  --input evidence='{"postmaster_report":{"source":"postmaster.example.com","timestamp":"2026-06-25T12:00:00Z","reputation_score":95,"domain":"example.com"},"bounce_metrics":{"source":"bounce-monitor.example.com","timestamp":"2026-06-25T12:00:00Z","bounce_pct":1.2},"complaint_metrics":{"source":"feedback-loop.example.com","timestamp":"2026-06-25T12:00:00Z","complaint_pct":0.05},"placement_probe":{"source":"placement-test.example.com","timestamp":"2026-06-25T12:00:00Z","inbox_pct":97.5}}' \
  --input policy='{"min_reputation_score":80,"max_bounce_pct":5,"max_complaint_pct":0.3}' \
  --json
```

### Verify
```bash
runx verify --receipt <receipt.json> --json
```

## Harness results

| Case | Status | Description |
|------|--------|-------------|
| sealed_healthy_signals_continue | sealed | All signals healthy → verdict.healthy + recommendation.continue |
| contradictory_signals_escalate | failure | Contradicting signals → refusal, no recommendation |

## Dogfood result

- **Receipt ID**: `runx:receipt:sha256:c1fc8b39fa56404ab9c3f540392ea2be0b5eeedee5277b2b89d1b33c196a2a49`
- **Verdict**: healthy
- **Recommendation**: continue
- **All signals**: sealed, within policy

## Key design decisions

1. **Contradiction detection**: High reputation (≥ threshold) paired with high bounce (> threshold) is a contradiction. The skill refuses to resolve it and names both signals in the escalation record.

2. **Degraded state**: When signals are sealed and non-contradictory but some are out of policy, the verdict is "degraded" with a throttle or pause recommendation.

3. **No Effect envelope**: The recommendation is read-only. A downstream deliverability lane or human must approve any actual throttle/pause action.

## Pending

- Maintainer approval for CI on the PR (new fork, workflows awaiting approval)

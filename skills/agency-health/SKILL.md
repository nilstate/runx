---
name: agency-health
description: Read one agency case projection and bounded receipt-id stubs, grade grounded health signals, and route only evidence-backed interventions.
runx:
  category: governance
---

# Agency Health

Assess a running agency from durable case state, not narration. The runner first
calls `data-store.read_projection` using the supplied domain-keyed
`data_source_ref` and `case_id`. Cross-run evidence, when supplied, is read only
through `ledger.read` and is reduced to receipt-id stubs. It never accepts or
copies a receipt body.

## Inputs

- `data_source_ref` and `agency_ref` are required.
- `store_id`, `period`, and `case_id` are optional bounded selectors.
- `health_baseline` can explicitly set `threshold_days_stuck`, `cap_pressure_pct`,
  and `refusal_spike_rate`. Missing thresholds are not invented.

## Output

The result is always shaped as:

```json
{
  "decision": "ready | needs_more_evidence | needs_human",
  "health_verdict": { "status": "healthy | degraded | critical | unknown", "findings": [] },
  "intervention_findings": []
}
```

A missing or unreadable case projection returns `needs_more_evidence`, an
`unknown` verdict, and no findings or interventions. A degraded case may route
policy ambiguity to `policy-author` or repeated execution failure to
`improve-skill`. Cap/authority widening and critical conditions require human
ops; this skill does not widen authority itself.
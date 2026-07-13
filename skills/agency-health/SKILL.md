---
name: agency-health
description: Read one agency case projection and bounded receipt-id stubs, grade grounded health signals, and route only evidence-backed interventions.
runx:
  category: governance
---

# Agency Health

Assess a running agency from durable case state, not narration. The runner reads
the case through `data-store.read_projection` with the supplied domain key. When
cross-run evidence is necessary it reads only receipt-id stubs through
`ledger.read`; it neither accepts nor copies receipt bodies.

## Inputs

- `data_source_ref` and `agency_ref` are required.
- `store_id`, `period`, and `case_id` are optional bounded selectors.
- `health_baseline` can explicitly set `threshold_days_stuck`, `cap_pressure_pct`,
  and `refusal_spike_rate`. Missing thresholds are not invented.

## Output

The result always has `decision`, `health_verdict {status, findings[]}`, and
`intervention_findings[]`. Missing case events produces sealed
`needs_more_evidence` with no findings or interventions. Policy ambiguity routes
to `policy-author`; execution recovery routes to `improve-skill`; cap/authority
widening and critical conditions require human ops.
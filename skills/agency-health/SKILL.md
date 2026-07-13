---
name: agency-health
description: Grade one agency case over a bounded period by folding its projection state and receipt-stub ledger aggregates into a typed health bundle.
runx:
  category: ops
---

# Agency Health

`agency-health` is a read-only operator skill for grading one running agency
case over a bounded period. It reads domain-keyed case state through
`data-store read_projection`, reads cross-run aggregate signals through `ledger`
by receipt id-stub only, and returns a typed health bundle plus typed
intervention findings.

## Purpose

Use this skill when an operator needs to know whether one agency is healthy
enough to continue without widening caps or authority. It does not append
events, widen authority, route money, or issue follow-up runs. It only grades
the folded case and names the next lane when intervention is warranted.

## Inputs

- `data_source_ref`: logical source for the case projection read.
- `store_id`: binding or fixture store used for the projection fold.
- `agency_ref`: the agency stream ref being graded.
- `period` (optional): bounded window with `from` and `to`.
- `case_id` (optional): concrete case id when the agency groups more than one
  case.
- `health_baseline` (optional):
  - `threshold_days_stuck`
  - `cap_pressure_pct`
  - `refusal_spike_rate`

## Output

`agency_health_report` returns:

- `decision`: `ready`, `needs_more_evidence`, or `needs_human`
- `agency_ref`
- `case_id`
- `period`
- `health_verdict`
  - `status`
  - `findings[]`
- `intervention_findings[]`
- `refused_reason` when the case cannot be graded safely

Each `health_verdict.findings[]` entry ties a folded metric to a named norm.
This skill grades these metrics by name:

- `seal_rate`
- `stuck_case_count`
- `cap_usage_pct`
- `escalation_backlog`

Each `intervention_findings[]` entry names a `target_lane` and cites the
grounding `case_id` and turn or ledger id-stub.

## Lane rules

- `improve-skill`: dispatch/tooling failure inside the case
- `policy-author`: written baseline or cap thresholds need tightening
- `human-ops`: any critical finding, cap widening, or authority widening path

This is dispatch-by-naming only. The report grants no access, carries no
ceiling, and is consumed only when a downstream driver or operator issues a
separate governed run.

## Refusals

This skill refuses to:

- grade a signal not grounded in the folded case projection or a ledger
  aggregate referenced only by id-stub
- invent a cap or threshold it cannot read from the supplied baseline or case
  context
- invent a turn state the folded event order does not support

If no readable case events exist over the requested period, it returns
`decision: needs_more_evidence`, grades no findings, and emits no intervention.

## Harness contract

The package ships two inline harness cases:

- `concerning-agency-sealed`
  - sealed result
  - `decision: ready`
  - `health_verdict.status: degraded`
  - graded findings present
  - typed intervention findings present
- `no-case-events-stop`
  - sealed result
  - `decision: needs_more_evidence`
  - no findings graded
  - no intervention emitted

## Operator reading

Interpretation is intentionally narrow:

- `decision: ready` means the case is assessable, not healthy
- `status: degraded` means continued work is possible but intervention is
  warranted
- `needs_more_evidence` means the folded case and ledger aggregate are too thin
  to grade honestly

---
name: agency-health
description: Assess one agency case for stall risk, cap pressure, and governance drift by reading its projection and the cross-run receipt ledger.
runx:
  category: ops
---

# Agency Health

Assess whether one agency case is healthy enough to continue, and route any
intervention to the right lane.

An agency case is not just its latest turn. Health depends on the current case
projection, the recent sealed/refused receipt pattern around that case, and the
governance lanes available to correct drift. This skill reads the case through
`data-store read_projection`, reads recent receipt history through `ledger`,
and emits one read-only health report. It never appends events, widens
authority, or edits policy itself.

## What this skill does

`agency-health` reads one domain-keyed agency projection and one bounded
ledger slice, then grades the case on three axes:

- progress health: is the case moving, stalled, or burning turns without
  outcome
- cap health: is the case approaching or exceeding its turn/spend envelope
- governance health: do recent receipts show refusal drift, repeated retries,
  or other signals that should be routed to a named lane

The output is a single `agency_health_report` with a decision, graded findings,
and zero or more intervention findings. Intervention findings are routing
proposals only:

- `improve-skill` for repeated dispatch/tooling failure inside the case
- `policy-author` for cap sizing or policy drift that should be tightened in
  writing
- `human-ops` for critical findings or any authority/cap widening discussion

The ledger input stays receipt-stub only. This skill may consume matched
receipt ids, status, skill refs, and timestamps, plus the ledger chain verdict.
It must not request or emit receipt bodies.

## When to use this skill

- An operator wants to know whether an agency case is still healthy enough to
  continue.
- A case appears stuck and you need to separate case-state drift from
  cross-run receipt drift.
- A grant owner wants an evidence-backed answer before widening caps or
  changing policy.

## When not to use this skill

- To advance the case or dispatch the next member. Use `agency`.
- To rewrite a failing skill directly. Use `improve-skill`.
- To author or tighten policy text. Use `policy-author`.
- To inspect one specific receipt for over-reach. Use `receipt-auditor`.
- To mutate state, append events, or widen authority. This skill is read-only.

## Procedure

1. Read the case projection through `data-store read_projection`.
2. Read a bounded ledger slice through `ledger`, using only receipt stubs and
   optional chain verification.
3. For replay or harness work, a caller may provide `projection_snapshot` as a
   sanitized stand-in when durable state is unavailable. Treat the live
   `data-store read_projection` result as the primary source when it is
   populated.
4. If there is no readable case state and no usable case events in the ledger,
   stop with `needs_more_evidence`. Do not grade a case from absence alone.
5. Grade progress health:
   - `healthy` when turns are advancing toward a bounded outcome
   - `degraded` when progress is stalled, retries cluster, or the case is near
     its cap
   - `critical` when the case is effectively stuck, caps are exhausted, or the
     ledger shows severe governance drift
6. Emit graded findings only when there is enough evidence to support them.
   Every finding must cite `data-store.read_projection`, `ledger.read`, or both.
7. Emit intervention findings only when a named downstream lane is justified.
   Route cap or authority widening discussions, and all critical findings, to
   `human-ops`.
8. Return one sealed `agency_health_report`.

## Edge cases and stop conditions

- **No readable case state:** return `needs_more_evidence`.
- **Projection exists but carries no progress/cap signal:** return
  `needs_more_evidence` unless the ledger alone clearly establishes health.
- **Ledger slice is empty:** do not fabricate a clean history; mark that gap in
  `needs_input` or stop for evidence.
- **Case is stalled but still inside caps:** return `ready` with
  `health_verdict.status: degraded` and route the stall to `improve-skill`.
- **Cap or authority widening would be required to continue safely:** do not
  recommend widening directly. Route to `human-ops`, and to `policy-author`
  only if the written cap/policy itself appears mis-sized.
- **Critical signal with conflicting evidence:** keep the report read-only and
  route to `human-ops`.

## Output schema

```yaml
agency_health_report:
  decision: ready | needs_more_evidence | needs_agent | refused
  case_ref: string
  objective: string
  health_verdict:
    status: healthy | degraded | critical | needs_more_evidence
    summary: string
    basis:
      progress: on_track | stalled | unknown
      cap_pressure: low | elevated | critical | unknown
      receipt_signal: normal | warning | critical | unknown
  ordered_tool_calls:
    - tool: string
      purpose: string
      requires_confirmation: boolean
  findings:
    - id: string
      grade: critical | warning | info
      dimension: progress | spend | authority | receipts | evidence
      summary: string
      evidence_refs: [string]
  intervention_findings:
    - id: string
      target_lane: improve-skill | policy-author | human-ops
      trigger: string
      action: string
      reason: string
  blockers: [string]
  needs_input: [string]
  success_checkpoint:
    milestone: string
    description: string
```

`decision: ready` means the case was assessable, not that it is healthy. A
case can be `ready` with `health_verdict.status: degraded` or `critical` if the
evidence is sufficient.

## Worked example

The case projection shows 9 turns used out of a 10-turn cap, 3 consecutive
no-progress turns, and spend reserved at 92% of the limit. The ledger slice
shows recent sealed turns plus one refusal caused by cap pressure. The report
returns `decision: ready` and `health_verdict.status: degraded`. Findings cite
the stalled turn pattern and elevated cap pressure. Intervention findings route
dispatch stall remediation to `improve-skill` and cap sizing review to
`policy-author`, with `human-ops` named as the escalation lane if widening the
cap is under consideration.

If both the projection and ledger are effectively unreadable, the report stops
at `needs_more_evidence`, emits no graded findings, and proposes no
intervention.

## Inputs

- `data_source_ref` (required for live reads): logical data source holding the
  case projection.
- `resource` (required): projection or event resource to read.
- `aggregate_id` (required): agency case id.
- `objective` (required): the health question being answered.
- `ledger_question` (optional): bounded ledger question for the cross-run read.
- `ledger_filter` (optional): ledger filter passed through to `ledger`.
- `proof` (optional): optional ledger verification request, for example
  `{ "verify_chain": true }`.
- `projection_snapshot` (optional): sanitized replay projection for harness or
  controlled evaluation when durable state is unavailable.
- `receipts` (optional): explicit receipt stubs for replay or controlled
  evaluation.
- `health_focus` (optional): operator emphasis such as `progress-first`,
  `cap-pressure`, or `governance-drift`.

---
name: agency-health
description: Assess one agency's operational health read-only, folding its domain-keyed case projection in version order and corroborating it against an audit-only ledger aggregate, then grade seal rate, stuck cases, cap usage, and escalation backlog against named norms and route each intervention to a target lane without ever minting authority.
runx:
  category: data
---

# Agency Health

Turn an agency's own case history into a governed, read-only health report.

An agency accumulates state: cases open and advance turn by turn, spend accrues
against a charter cap, escalations get raised and picked up (or don't). This
skill folds that state, grades it against named norms, and routes what it finds
to the lane that can act on it. It appends nothing, sends nothing, executes
nothing, and consumes no effect — it is a judgment, not an executor.

## The two reads, and why they are not interchangeable

This is the heart of the skill. It performs **exactly two reads**, and they do
different jobs:

| | read | how it is referenced |
|---|---|---|
| **Domain-keyed state read** | `registry:runx/data-store@0.1.2`, operation `read_projection` | keyed on `agency_ref` (narrowed by `case_id`), folded **in version order** |
| **Cross-run aggregate read** | `registry:runx/ledger@0.2.0`, runner `read` | **receipt id-stub only** |

The data-store `read_projection` is the **only** read that yields case and turn
state. The ledger is **audit-only** and can never stand in for it — not by
policy, but structurally. Upstream `skills/ledger/SKILL.md` says of the ledger's
runners: *"Both runners project to id-stubs only."* An id-stub is a receipt
handle; it is not a domain-keyed projection of a case. So the ledger can
corroborate that a run happened and seal an audit trail over it, but it cannot
tell you what turn a case is on. Substituting it for the domain-keyed read would
mean inventing the very state this skill refuses to invent.

Both reads are registry-pinned, so a report names the exact source revision it
folded.

## What this skill does

1. **Fold the case projection.** `read_projection` at `data_source_ref`, keyed on
   `agency_ref`, folded in version order. Version order is what makes the fold
   deterministic: the latest turn is the last one the sealed event order shows,
   not the last one written.
2. **Corroborate against the ledger aggregate.** Cite receipt id-stubs only.
3. **Grade four findings against named norms.** `seal_rate`, `stuck_case_count`,
   `cap_usage_pct`, `escalation_backlog` — each ties a folded metric to a norm
   from `health_baseline` or the agency charter snapshot, with an assessment.
   Never a bare number.
4. **Route interventions to lanes.** Each `intervention_finding` names a target
   lane and cites the `case_id` plus the turn or ledger id-stub that grounds it.

## Inputs

`data_source_ref`, `store_id`, `agency_ref` are required. `period`, `case_id`,
and `health_baseline{threshold_days_stuck,cap_pressure_pct,refusal_spike_rate}`
are optional. `health_baseline` and the agency charter snapshot carried in the
projection are the **only** sources of norms.

## Output

- `decision` — `ready | needs_more_evidence | needs_human`
- `health_verdict{status, findings[]}` — each finding folds a metric and names
  the norm it is graded against
- `intervention_findings[]` — each names a target lane and cites its grounding
  `case_id` and turn or ledger id-stub

## Read-only, and the dispatch-by-naming seam

The skill moves no money and grants no access. So every `intervention_finding`
carries **no ceiling and no effect bound**. It is not a proposal a rail can
consume; it is a named finding pointed at a named lane. It is consumed only when
a downstream driver or operator issues a **separate** `policy-author` or
`improve-skill` run. This skill issues no rail run, and no rail consumes its
output.

Routing follows the defect, with one hard escalation:

- a **skill-behavior** defect (stuck turns behind repeated refusals) → `improve-skill`
- a **routing-policy** defect (an escalation backlog that will not drain) → `policy-author`
- any **cap-widening or authority-widening** remedy, **and any finding graded
  `critical`** → the **human ops lane**, never a routine tighten

The escalation rule is the point of the seam: a report that could widen its own
subject's authority by routing itself is not read-only in any sense that matters.

## Refusals

- Refuses to grade a signal not grounded in the folded case projection or a
  ledger id-stub aggregate.
- Refuses to invent a cap or threshold it cannot read from the agency charter
  snapshot or the supplied `health_baseline`.
- Never invents a turn state the sealed event order does not show.

When the projection returns **no readable case events**, the run does not fail —
it **seals on the refusal**. `decision` is `needs_more_evidence`, no finding is
graded, no intervention is emitted, and the report says exactly what is missing.
Reporting the deterministic conflict honestly *is* the complete run.

## Harness

The two contract cases **both seal**, and a third case exercises the required
human-ops refusal path:

- `concerning-agency-sealed` — a running agency with stuck turns and cap
  pressure. `decision: ready`, `health_verdict.status: degraded`, all four
  findings graded, interventions typed to `improve-skill`, `human_ops`, and
  `policy-author`.
- `no-case-events-stop` — an `agency_ref` with no readable case events over the
  period. `decision: needs_more_evidence`, nothing graded, nothing emitted, and
  the receipt **seals** on the refusal.
- `cap-widening-escalates-human-ops` — a 97-percent-cap agency whose only
  plausible remedy widens authority. The run returns `needs_agent` rather than
  routing the remedy as a routine tighten. This case also satisfies the hosted
  registry's requirement that a publishable harness include a stop/error path.

## Install and run

```
runx add fablerlabs/agency-health@<published-version> \
  --registry https://api.runx.ai
runx skill fablerlabs/agency-health@<published-version> assess \
  --registry https://api.runx.ai \
  --input data_source_ref=registry:runx/data-store@0.1.2 \
  --input store_id=agency-ops-store \
  --input agency_ref=agency:acme-support \
  --input period=30d --json
runx verify --receipt receipt.json --allow-local-development-signatures --json
```

Use the content version shown on the public registry page (for example,
`sha-...`) in place of `<published-version>`.

---
name: agency-health
description: "Read one running agency case end-to-end by composing the registry-pinned data-store read_projection (C2) keyed on the agency case and the ledger read runner (C7) by receipt id-stub only; fold the case projection in version order, grade signals against declared norms, and seal a health_verdict plus typed intervention findings with named target lanes. Read-only: appends nothing, sends nothing, executes nothing, and consumes no effect."
runx:
  category: ops
---

# Agency Health

Agency Health assembles a health bundle for one running agency over a period.
An agency runs a standing mandate one governed turn at a time, and every turn
appends an event to that agency's case stream in the hosted data-store. Over
days that stream is operational state: turns that advanced cleanly, turns
parked in `awaiting_approval`, cumulative spend and act counts approaching
the charter caps, and turns making no progress.

This skill reads the domain-keyed turn state by composing two existing runners:

1. the registry-pinned data-store read_projection (C2) keyed on the agency case
   over the supplied period; and
2. the ledger read runner (C7) referenced by receipt id-stub only, because the
   ledger is audit-only and can never be a domain-keyed state read.

It folds the case projection in version order, grades the signals against the
declared norms (or supplied baseline), and seals a `health_verdict` plus typed
intervention findings. It is read-only: it appends nothing, sends nothing,
executes nothing, and consumes no effect. Each warranted finding names its
target lane (`policy-author` to tighten a policy or timeout, `improve-skill` to
debug a member behind a refusal spike). Any remedy that would widen a cap or
authority, and any critical finding, escalates to the human ops lane rather
than routing as a routine tighten.

`run-history-analyst` reads runs across the whole catalog ledger, and
`receipt-auditor` audits one receipt. This skill reads one live agency case
projection end-to-end, so it composes those two lanes without reimplementing
them.

## When to use this skill

- A standing agency has been running for at least one period, the operator
  wants a single health bundle for one case, and the agency charter snapshot
  (mandate, roster, cumulative limits) is in the data-store already.
- The reviewer needs to know whether a case is making progress, where it is
  parked, what its cumulative cap usage looks like, and where a downstream
  `policy-author` or `improve-skill` run should be triggered.

## When not to use this skill

- One-shot or interactive work that does not span multiple agency turns. The
  operator should call the member skills directly; this skill is overhead when
  the operator already knows which move to make.
- Anything that would mutate the agency case, write to the ledger, or issue a
  rail run. The intervention findings are dispatch-by-naming only: each
  finding names a target lane and grounds it in a `case_id` and a turn or a
  ledger id-stub. A downstream driver or operator issues the separate run.
- Inventing a threshold or a cap that is not in the agency charter snapshot or
  the supplied baseline. The skill refuses to grade what it cannot ground.

## Procedure

1. Compose the case projection read from the data-store runner (C2), keyed on
   `data_source_ref`, `store_id`, `case_id`, bounded by `period`. The runner
   returns events in version order; the skill folds them in that order.
2. For each grounded signal, compose the ledger read by id-stub only (C7). The
   ledger is audit-only; the skill never pulls aggregate state from it and
   never uses the ledger as a domain-keyed state source.
3. Compute graded findings:
   - `seal_rate` from sealed vs refused turns over the period.
   - `stuck_case_count` from turns with status `awaiting_approval` or with
     zero version advance across consecutive reads.
   - `cap_usage_pct` from cumulative `acts` and `spend` against the charter
     snapshot's limits, plus the optional `health_baseline.cap_pressure_pct`.
   - `escalation_backlog` from the count of turns parked in
     `awaiting_approval` over the period.
   - `refusal_spike_rate` from the recent refusal rate versus the optional
     `health_baseline.refusal_spike_rate`.
4. Emit the typed intervention findings. Each finding cites its grounding
   `case_id` and either a turn number or a ledger id-stub. Critical findings,
   and any finding whose remedy would widen a cap or authority, escalate to
   the human ops lane and never to a routine `policy-author` tighten.
5. Seal the verdict. The skill never invents a turn state the sealed event
   order does not show, and never invents a cap or threshold the charter
   snapshot or the supplied baseline does not expose.

## Inputs

- `data_source_ref` (required string): the registry-pinned identifier of the
  hosted data-store whose runner is C2.
- `store_id` (required string): the store within the data-source that carries
  the agency case stream.
- `agency_ref` (required string): the agency the case belongs to.
- `period` (optional object): `{ since, until }` ISO timestamps bounding the
  read. Defaults to the entire case stream when omitted.
- `case_id` (optional string): a specific case within the agency. Defaults to
  the agency's current case when omitted.
- `health_baseline` (optional object):
  - `threshold_days_stuck` (number): days a parked turn may stay parked before
    graded as `stuck_case_count`.
  - `cap_pressure_pct` (number): percentage of a cumulative cap above which
    graded `cap_usage_pct` is `concerning` rather than `healthy`.
  - `refusal_spike_rate` (number): sealed-vs-refused ratio above which graded
    `refusal_spike_rate` is `concerning`.

## Output schema

```yaml
agency_health:
  schema: runx.agency.health.v1
  decision: ready | needs_more_evidence | needs_human
  health_verdict:
    status: healthy | degraded | critical
    findings:
      - metric: seal_rate | stuck_case_count | cap_usage_pct | escalation_backlog | refusal_spike_rate
        assessment: healthy | concerning | critical
        norm: string
        evidence:
          case_id: string
          turn: number | null
          ledger_id_stub: string | null
  intervention_findings:
    - target_lane: policy-author | improve-skill | human-ops
      reason: string
      remedy_class: tighten | debug | escalate
      cap_widening: bool
      authority_widening: bool
      grounding:
        case_id: string
        turn: number | null
        ledger_id_stub: string | null
  refusals:
    - when: composition_unreadable | no_case_events | baseline_missing
      reason: string
```

## Refusals

The skill refuses to grade a signal that is not grounded in the folded case
projection or a ledger id-stub aggregate. It refuses to invent a cap or
threshold it cannot read from the agency charter snapshot or the supplied
baseline. It never invents a turn state the sealed event order does not show.

When no readable case events exist over the period, the verdict is
`needs_more_evidence`, no findings are graded, and no intervention is emitted.
The case is recorded in `refusals` with `when: no_case_events`.

## Quality bar

- Compose the data-store read and the ledger read by id-stub; never read
  aggregate state from the ledger, never use the ledger as a domain-keyed
  source.
- Fold the case projection in version order; never reorder events and never
  infer state the events do not show.
- Name the target lane on every intervention finding; never claim a remedy
  without grounding it in a `case_id` and either a turn or a ledger id-stub.
- Escalate cap-widening or authority-widening remedies, and any critical
  finding, to the human ops lane; never route them as routine tightens.
- Stop cleanly with `needs_more_evidence` or `needs_human`; never fake a
  `ready` decision.

## Worked example

Open the data-store read for one agency over the last seven days. Fold
forty-two events; thirty-eight advanced, two parked in `awaiting_approval`,
two refused. `seal_rate` is healthy at 0.95; `escalation_backlog` is two;
`cap_usage_pct` is concerning at 82 percent against the supplied baseline.
Emit one intervention finding naming `policy-author` with the remedy's
grounding turn numbers, and seal the verdict as `degraded`. The next
operator turn calls `policy-author` with this finding as input.

When a fresh agency has zero case events over the period, return
`decision: needs_more_evidence`, `health_verdict.status: degraded`, an empty
findings list, no intervention findings, and one refusal with
`when: no_case_events`.

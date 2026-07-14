---
name: agency-health
description: "Read one running agency case and its receipt-ledger id-stubs, fold the sealed event order, grade operational health against declared norms, and emit read-only intervention findings for named downstream lanes."
runx:
  category: ops
---

# Agency Health

Assess one live `agency` case without changing it. This skill composes the
domain-keyed `data-store.read_projection` and `data-store.read_events` reads with
the cross-run `ledger.read` runner, folds the agency case in version order, and
seals one health verdict plus grounded intervention findings.

For isolated registry installs, the package vendors the exact read-only C2/C7
runner surfaces pinned by the source commit: `runx/data-store@sha-ca3a75ec5f21`
and `runx/ledger@sha-3e6341beba7f`. The package-local copies preserve the
upstream runner names and execution logic; they add no replacement metrics or
caller-authored answers.

It is a read-only diagnostic lane. It appends nothing, dispatches nothing,
moves no money, grants no access, and consumes no effect. An intervention names
the separate lane an operator or driver may run next; it is never that run.

## When to use this skill

- A running agency appears stuck, approval-heavy, refusal-prone, or close to a
  charter cap.
- An operator needs a reproducible health bundle for one agency case over a
  bounded period.
- A downstream driver needs grounded reasons before invoking `policy-author`,
  `improve-skill`, or the human ops lane.

## When not to use this skill

- To run or advance the agency. Use `agency`.
- To search the whole receipt catalog. Use `run-history-analyst`.
- To audit one receipt body or signature. Use `receipt-auditor` or `runx verify`.
- To change a timeout, cap, policy, member, credential, payment, or authority.
  This skill can only name the appropriate separate lane.

## Inputs

The public `assess` runner accepts only:

- `data_source_ref` (required): the configured data source holding the case.
- `store_id` (optional): an explicit local fixture store id; omit it for the
  normal durable SQLite binding.
- `agency_ref` (required): the agency definition expected in the opened event.
- `period` (optional): `{ from, to }` ISO-8601 bounds used for stuck-time and
  ledger queries. Time-based grades stop when the required bound is absent.
- `case_id` (optional): the `agency_cases` aggregate id. When omitted, the
  deterministic prepare stage uses `agency_ref` as the aggregate id.
- `health_baseline` (optional):
  `{ threshold_days_stuck, cap_pressure_pct, refusal_spike_rate }`.

Norms may also come from the charter snapshot in the opened event. The skill
never invents a cap or threshold that is absent from both sources.

## Procedure

1. Normalize `case_id`, period, and the ledger query without changing public
   input or authority.
2. Call `data-store.read_projection` on resource `agency_cases` and the resolved
   case id. This is the authoritative domain-keyed stream identity and digest.
3. Call `data-store.read_events` for the same source, resource, and case id.
   Verify ascending versions and projection/event digest consistency before
   folding event bodies.
4. Call `ledger.read` for the bounded period. The runx ledger projects a sealed
   receipt as status `closed`, which this grader normalizes to `sealed` for the
   seal-rate metric. A second deterministic C7 read may
   replay only receipt id-stubs already cited by ordered case events when the
   ambient ledger has no matching case-cited rows. Intersect ambient history
   with those case-cited ids, then retain only (`receipt_id`, `skill_ref`,
   `status`, `created_at`); ledger history is cross-run evidence, never the
   agency's domain state, and the output records which C7 source grounded it.
5. Fold the opened/turn/approved/denied event order and grade:
   `seal_rate`, `stuck_case_count`, `cap_usage_pct`, and
   `escalation_backlog` against named norms.
6. Seal the verdict and any read-only intervention findings.

The bundled `data.source` manifest is only the operator-context contract for
runx's virtual router. The runtime always replaces that ref with the concrete
adapter bound to `data_source_ref`; its fail-closed stub is never a state reader.

## Output

The sealed `runx.agency_health.v1` packet contains:

```yaml
decision: ready | needs_more_evidence | needs_human
health_verdict:
  status: healthy | degraded | critical | unknown
  findings:
    - metric: seal_rate | stuck_case_count | cap_usage_pct | escalation_backlog
      value: number
      norm: string
      assessment: within_norm | concerning | breached
      severity: info | warning | critical
      evidence_refs: [string]
intervention_findings:
  - target_lane: policy-author | improve-skill | human-ops
    severity: warning | critical
    reason: string
    grounding:
      case_id: string
      turns: [number]
      ledger_id_stubs: [string]
evidence:
  folded_case_id: string
  turn_numbers: [number]
  ledger_id_stubs: [string]
  refused_reasons: [string]
```

An intervention deliberately has no ceiling and no effect bound. It is consumed
only when a downstream operator or driver issues a separate governed run.

## Decision and routing rules

- `ready`: the readable case supports a health verdict. Routine tightening or
  debugging suggestions name `policy-author` or `improve-skill`.
- `needs_more_evidence`: no events are readable, event/projection integrity does
  not reconcile, an agency id conflicts, or a requested signal lacks a declared
  norm. No ungrounded finding or intervention is emitted.
- `needs_human`: any critical finding, cap-widening remedy, or
  authority-widening remedy routes only to `human-ops`.

`policy-author` may tighten a policy or timeout but cannot be used here to widen
a cap. `improve-skill` may diagnose a member associated with a refusal spike or
stalled turn. Neither lane runs automatically.

## Refusals and evidence rules

- Refuse to grade a signal not grounded in the folded case projection or ledger
  id-stub aggregate.
- Refuse to invent a turn, case state, cap, or threshold.
- Refuse event rows that are out of order, duplicate a version, disagree with
  the projection version/digests, or belong to another case.
- Refuse ledger bodies as domain-keyed state and expose only id-stubs.
- Refuse to emit an intervention when no case events are readable.
- Never expose credentials, signing material, private receipt bodies, or provider
  dumps in the output or evidence.

## Worked example

A case has three sealed turn events, one unresolved approval, no progress for
six days, and 90% of its declared spend cap consumed. With a five-day stuck norm
and an 80% cap-pressure norm, the skill returns `ready`, a `degraded` verdict,
grounded stuck/cap/backlog findings, and named `policy-author` and
`improve-skill` interventions. It does not tighten the timeout or dispatch the
member itself.

For an `agency_ref` whose resolved case has zero readable events, the same graph
seals `needs_more_evidence`, `unknown`, empty findings, and no intervention.

## Verification

Run the local harness and verify a real receipt:

```text
runx harness ./skills/agency-health --json
runx skill ./skills/agency-health --input data_source_ref=local://agency-health/real --input agency_ref=agent-17af92 --input case_id=case-frantic-revenue-001 --input-json period={...} --input-json health_baseline={...} --json
runx verify --receipt <receipt.json> --json
```

For registry use, install the exact immutable version, run that registry ref on
the real durable case, and verify the distinct post-publish receipt.

## Quality Bar

- The projection read, ordered event read, and ledger read must all execute in
  the sealed graph; prose or caller-authored metrics are not substitutes.
- Every grade names its norm and evidence reference.
- Every intervention cites its case/turn or ledger id-stubs and names only a
  separate downstream lane.
- Missing evidence produces a truthful non-ready packet, never a fake healthy or
  degraded result.

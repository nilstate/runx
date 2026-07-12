---
name: agency-health
description: "Assemble a read-only health bundle for one running agency over a period: fold the domain-keyed turn state from the data-store read_projection (C2), grade signals against declared norms, and seal a health_verdict plus typed intervention findings. Reads cross-run aggregates (seal rate, refusal spikes) from the ledger read runner (C7) by receipt id-stub only."
runx:
  category: ops
---

# Agency Health

Assemble a health bundle for one running agency over a period, read-only.

An agency runs a standing mandate one governed turn at a time. Every turn appends
an event to that agency's case stream in the hosted data-store, and over days that
stream becomes operational state: turns that advanced cleanly, turns parked in
`awaiting_approval`, cumulative spend and act counts approaching the charter caps,
and turns making no progress. This skill reads the domain-keyed turn state by
composing the registry-pinned data-store `read_projection` (C2) keyed on the agency
case, and reads cross-run aggregates (seal rate, refusal spikes) from the ledger
read runner (C7), referencing those receipts by id-stub only because the ledger is
audit-only and can never be a domain-keyed state read. It folds the case projection
in version order, grades the signals against declared norms, and seals a
`health_verdict` plus typed intervention findings. It is read-only: it appends
nothing, sends nothing, executes nothing, and consumes no effect. Each warranted
finding names its target lane (`policy-author` to tighten a policy or timeout,
`improve-skill` to debug a member, `ops-desk` to retune dispatch, or `human` when a
consequential call needs a person).

## What this skill does

- Reads the agency case projection via `data-store.read_projection` keyed on
  `case_id`, pinned to the registry-pinned `data_source_ref` for that agency.
- Folds the projection in version order: turn sequence, status histogram
  (`advanced`, `awaiting_approval`, `resolved`, `failed`, `needs_input`), cumulative
  act and spend totals, and the latest turn timestamp.
- Reads cross-run aggregates from the ledger read runner (C7) keyed on the agency's
  `agency_ref` / operator: seal rate, refusal spikes, and member dispatch counts.
  The ledger is referenced by receipt id-stub only — this skill never treats the
  ledger as domain state.
- Grades each signal against declared norms supplied in `norms` (defaults documented
  below) and emits a typed finding when a signal breaches its norm.
- Seals a `health_verdict` (`healthy` | `watch` | `degraded`) plus a list of typed
  `intervention_findings`, each naming its target lane and the evidence (turn ids,
  receipt id-stubs, version ranges).
- Is strictly read-only: no `append_event`, no `send`, no `advance`, no effect
  consumption.

## When to use this skill

- An operator wants a point-in-time health read on a running agency before deciding
  whether to tighten a policy, debug a member, or escalate to a human.
- A dashboard or loop wants a sealed, replayable health bundle per agency per period.
- A post-mortem needs the folded case state plus the ledger-backed seal/refusal
  context, each from its own authority.

## When not to use this skill

- To advance the case, dispatch a member, or change state. Use `agency.advance`.
- To answer one precise audit question. Use `ledger`.
- To grade platform-wide health across many agencies. Use `run-history-analyst`.
- To mutate, redact, or export receipts. This skill is read-only.

## Procedure

1. Resolve inputs: `data_source_ref`, `case_id`, `agency_ref`, `period`
   (ISO window or turn range), and optional `norms`.
2. Call `data-store.read_projection` with `resource=agency_cases`,
   `aggregate_id=case_id`. Fold the returned events in version order.
3. Compute the status histogram, cumulative act/spend, stalled-turn detection
   (turns whose `next` has not resolved within `norms.stall_window_turns`), and
   approval-parked count.
4. Call the ledger read runner (C7) with `agency_ref` + `period` for seal rate and
   refusal spikes. Keep only id-stubs; never re-read domain state from the ledger.
5. Grade each signal against `norms`. Emit a finding per breach, naming the lane.
6. Seal `health_verdict` from the worst finding severity. Return the bundle.

## Declared norms (defaults if `norms` omitted)

```yaml
norms:
  stall_window_turns: 5          # a turn with no progress for > this many turns = stalled
  awaiting_approval_cap: 3       # more parked approvals than this = degraded
  spend_cap_pct: 90              # cumulative spend over this % of limit = watch
  act_cap_pct: 90                # cumulative acts over this % of limit = watch
  refusal_spike_threshold: 0.2   # ledger refusal rate over this = degraded
  seal_rate_floor: 0.8           # ledger seal rate under this = watch
```

## Output schema

```yaml
health_bundle:
  schema: runx.agency.health.v1
  case_id: string
  agency_ref: string
  period: { from: iso, to: iso }
  verdict: healthy | watch | degraded
  folded:
    turns_total: number
    status_histogram: { advanced: n, awaiting_approval: n, resolved: n, failed: n, needs_input: n }
    cumulative_acts: number
    cumulative_spend: number
    stalled_turns: [turn_id, ...]
    approval_parked: number
  ledger_stubs:                # C7, id-stubs only
    seal_rate: number
    refusal_rate: number
    receipt_stubs: [receipt_id, ...]
  intervention_findings:
    - lane: policy-author | improve-skill | ops-desk | human
      signal: string
      severity: watch | degraded
      evidence: string         # turn ids / receipt id-stubs / version ranges
      recommendation: string
  receipt:
    schema: runx.receipt.v1
```

## Inputs

- `data_source_ref` (required): registry-pinned logical ref for the agency's data
  source; the project/hosted binding maps it to the concrete adapter.
- `case_id` (required): the agency case aggregate id.
- `agency_ref` (required): operator/agency handle for the C7 ledger query.
- `period` (optional): `{from, to}` ISO window or `{from_turn, to_turn}` range.
- `norms` (optional): override the declared defaults above.

##Invocation

```bash
runx skill agency-health \
  -i data_source_ref=tenant://acme/agency-board \
  -i case_id=case-acme-ops-001 \
  -i agency_ref=acme-ops \
  --input-json period='{"from":"2026-07-01T00:00:00Z","to":"2026-07-08T00:00:00Z"}' \
  --json
```

The command only works once `tenant://acme/agency-board` is bound to an installed
`data-store` adapter. OSS dogfood uses the bundled `local://` or `store_id` fixture
adapter; pass a seeded projection so the harness can prove a folded, graded bundle
without standing up hosted infrastructure.

---
name: roster-tuner
description: "Read the sealed agency case event stream, fold each member's refusal and completion signals the same way the agency reducer folds case state, and emit a typed roster-tuning decision naming the bounded member change as plain data. The change is dispatched by naming only; a downstream driver or the human agency operator re-opens the case with the revised roster."
runx:
  category: ops
---

# Roster Tuner

Decide whether the standing team on a long-running agency case has drifted.
`roster-tuner` reads the case-keyed event stream through the hosted data store,
folds every member's turn count, refusal tally, and completion time the same
way the agency reducer folds case state, ranks each member against the
operator-supplied `performance_norms`, and emits one bounded roster change as
plain data. The skill records the judgment as a case-keyed append, and stops.

It is a read-and-write judgment skill. It never pages a person, runs a member
act, opens a fresh agency case, or replaces the roster itself. The human
agency operator is the only lane that acts on the produced decision, by
re-opening the case with the revised roster; no catalog skill executes a
roster mutation.

## What this skill does

The skill accepts one case at a time:

- `case_id`, `data_source_ref`, `store_id`, `resource`, `aggregate_id`
  (= the case), `expected_version`, `idempotency_key`
- `roster[member, skill, turn_count]` — the standing team for this case,
  snapshotted at case open and not mutated by the agency runtime
- `performance_norms{refusal_threshold, completion_time_threshold, min_roster_size}`
- `agency_event_schema_version`

It reads the sealed case projection via `data-store.read_projection` keyed
on `aggregate_id = case_id`, folds the same refusal and completion signals
the agency reducer folds, and binds at most one `decision`:

```yaml
decision:
  underperformer: bool
  member_to_remove: string | null
  replacement_candidate: string | null
  reason: string
  refusal: string | null
```

When the folded projection matches `agency_event_schema_version`, the
performance norms bind a single underperformer, and the change is bounded,
`roster-tuner` first writes the same projection it just read (idempotent
readback for the harness gate), then records the judgment as an
`append_event(idempotency_key, expected_version)` against the same
`aggregate_id`. If the judgment is unsafe, the skill seals a typed refusal
in place of the decision and stops before any append.

## When to use it

- An operator wants a receipt-backed, governance-friendly decision about
  which standing member of a long-running agency case should be swapped
  for a skill-matched peer, without taking that action inside the catalog
  skill.
- A workflow needs to prove which case projection and performance-norm
  clause justified the bounded roster change so a downstream driver or
  human can re-open the case on the same evidence.
- A run should separate judgment from action, so the human agency
  operator can review the typed decision before any case is re-opened.

## When not to use it

- To actually re-open the case, swap a member, or page anyone. Use a
  downstream governed run for any of those effects; `roster-tuner` only
  emits the typed decision.
- To tune a roster that does not match the declared
  `agency_event_schema_version`, or a case whose event stream is not
  sealed at `expected_version`.
- To reduce the roster below `min_roster_size`, or to remove the only
  member that still holds a required skill.
- To invent a member, a refusal tally, a completion time, or a
  performance norm; `roster-tuner` only folds values that are present in
  the sealed case projection.
- To clear an unsealed, ambiguous, or schema-mismatched case projection;
  the run stops with a sealed refusal instead of guessing.

## Procedure

1. Read the bounded inputs and confirm `aggregate_id == case_id`.
2. Read the sealed case projection via `data-store.read_projection` keyed
   on `aggregate_id`; reject any case whose events fail schema matching
   against the declared `agency_event_schema_version`.
3. Compute each member's refusal rate as
   `refusals / max(turn_count, 1)` and each member's completion time as
   the mean `completion_time` recorded on the case events.
4. Rank members against the operator-supplied `performance_norms`:
   `refusal_threshold` is the band ceiling, `completion_time_threshold`
   is the multiplicative ceiling against the case-wide mean completion
   time, `min_roster_size` is the lower bound the skill refuses to cross.
5. If exactly one member crosses both thresholds, name that member for
   removal and a skill-matched replacement already present in the case
   projection. If no member crosses, or more than one crosses, or the
   only required-skill holder crosses, seal a refusal instead.
6. `append_event(idempotency_key, expected_version)` the typed judgment
   against the same `aggregate_id`, with `side_effects: "none"` and the
   folded evidence stamped on the event.
7. Stop. The human agency operator decides whether to re-open the case
   with the revised roster; `roster-tuner` never executes the change.

## Output contract

```yaml
decision:
  schema: runx.roster.tune.v1
  underperformer: bool
  member_to_remove: string | null
  replacement_candidate: string | null
  reason: string
  evidence:
    case_id: string
    aggregate_id: string
    expected_version: number
    schema_version: string
    folded_refusal_rates: object
    folded_completion_times: object
    norms_applied: object
append_event:
  schema: runx.case.append.v1
  resource: agency_cases
  aggregate_id: string
  expected_version: number
  idempotency_key: string
  side_effects: string
refusal:
  reason: string | null
```

`decision.underperformer` is `true` only when a single member is named for
removal and a single skill-matched peer is named as replacement.
`append_event` is emitted only when the decision is bound and the run is
sealed, never when a refusal is returned. Missing evidence stops the run
with a sealed refusal instead of inventing any fold.

## Harness cases

The harness covers two cases:

- `roster-tuner-escalate-sealed`: a member sits at `refusal_rate 0.75`
  (above the `0.6` threshold) and `completion_time 3x` the case mean
  (above the `3x` threshold). The folded case projection emits one
  `runx.roster.tune.v1` decision naming that member for removal and a
  skill-matched replacement, the `append_event` is recorded, and the run
  seals.
- `roster-tuner-stop-needs-agent`: the caller omits
  `caller.answers.agent_task.roster-tuner.output`, so the grading
  agent-task sub-step blocks and the run stops with `reason needs_agent`
  before any decision or append is emitted.

## Evidence requirements

Evidence should include the runx CLI version, package name and version,
registry reference, public URL, source URL, the raw `X.yaml`, the raw
`SKILL.md`, the harness case names, hosted harness status, the dogfood
command and receipt reference, the `append_event` idempotency key and the
recorded `expected_version` movement, the typed decision's
`underperformer` verdict and reason, the folded refusal rate and
completion time of the named member against the named norms, the
proposed replacement rationale, the stop reason, and a reproducible
install + run + verify command for a new operator.

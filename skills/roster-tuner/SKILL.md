---
name: roster-tuner
description: "Read a sealed agency case event stream, fold per-member metrics, rank members against operator-supplied norms, and emit a typed roster tuning decision naming the bounded member change as plain data."
runx:
  category: ops
---

# Roster Tuner

Tune a standing agency roster by reading one case's sealed event stream and
deciding which members underperform relative to the mandate.

An agency case runs a standing team toward a mandate. The roster is snapshotted
as operator config at case open and the agency runtime exposes no verb that
mutates it. Member performance drifts over a long case. This skill reads the
sealed event stream through the hosted data-store keyed on the case, folds
each member's turn count, refusal tally, and completion time the same way the
agency reducer folds case state, ranks members against operator-supplied norms,
and decides which members underperform relative to the mandate.

It records the judgment as durable case-keyed state through an ungated append,
emits a typed roster tuning decision naming the bounded member change as plain
data, and stops. The human agency operator is the only lane that acts on it, by
re-opening the case with the revised roster. No catalog skill executes a roster
mutation.

## What this skill does

- Reads the sealed case event stream from the data-store keyed on the agency
  case aggregate, using `read_projection` to reconstruct the case state.
- Folds per-member metrics from the event stream: turn count, refusal tally,
  refusal rate, average completion time, and completion ratio against the
  operator-supplied norm.
- Grades each folded member against `performance_norms` thresholds supplied by
  the operator. The grading step runs as an agent-task sub-step so the judgment
  can cite specific evidence from the folded metrics.
- Decides whether any member is an underperformer: refusal rate above
  `refusal_threshold` and completion time above `completion_time_threshold`
  together name a member for removal.
- Names a skill-matched replacement candidate from the remaining roster or from
  the operator's candidate pool.
- Appends the recorded judgment to the case event stream as an ungated CAS
  write via `registry:runx/data-store@0.1.2`, keyed on `aggregate_id` under
  `expected_version` and `idempotency_key`.
- Emits the decision as plain data: `decision{underperformer, member_to_remove,
  replacement_candidate, reason}`. No AttenuationRequest, no mint, no execution.
- Stops. The human operator reviews the decision and re-opens the case with the
  revised roster through a separate governed run.

## When to use this skill

- A long-running agency case shows performance drift and the operator needs an
  evidence-based roster review before the next case phase.
- The operator wants a sealed, replayable judgment about member fitness, not a
  model opinion detached from the case event stream.
- A downstream driver or human needs a typed decision packet to act on, not a
  narrative report.

## When not to use this skill

- To mutate the roster directly. This skill names the change; the operator
  executes it.
- To analyze catalog-wide platform run history. Use `run-history-analyst` for
  that. This skill reads one case's per-member signals.
- To grade events that do not match the declared
  `agency_event_schema_version`. Mismatched schemas are refused.
- To reduce the roster below `min_roster_size`. The skill refuses.
- To remove the only member holding a required skill. The skill refuses.

## Procedure

1. Receive the case inputs: `case_id`, `data_source_ref`, `resource`,
   `aggregate_id`, the current `roster`, `performance_norms`, and
   `agency_event_schema_version`.
2. Read the case projection from the data-store. This reconstructs the case
   state from the sealed event stream.
3. Fold per-member metrics from the projection. Each member gets: `turn_count`,
   `refusal_count`, `refusal_rate`, `avg_completion_time`, and
   `completion_ratio` (actual time divided by the norm).
4. Refuse to grade if any case events do not match the declared
   `agency_event_schema_version`. Stop with `schema_version_mismatch`.
5. Grade each member against the norms. A member is a candidate for removal
   when `refusal_rate` exceeds `refusal_threshold` and `avg_completion_time`
   exceeds `completion_time_threshold`.
6. Check guard rails:
   - Refuse to reduce below `min_roster_size`.
   - Refuse to remove the only member holding a required skill.
   - Never invent a member or a performance signal not foldable from the sealed
     events.
7. If an underperformer is identified, name the `member_to_remove`, a
   `replacement_candidate` matched by skill, and the `reason` citing folded
   metrics against norms.
8. Append the judgment event to the case stream via `data-store.append_event`
   with the supplied `expected_version` and `idempotency_key`.
9. Emit the decision and stop. The operator acts on it.

## Edge cases and stop conditions

- `needs_agent`: the grading agent-task sub-step blocks because caller answers
  are not supplied. No decision is appended.
- `schema_version_mismatch`: case events do not match the declared
  `agency_event_schema_version`. The skill refuses to grade.
- `min_roster_guard`: removing the underperformer would reduce the roster below
  `min_roster_size`. The decision records the underperformance but refuses the
  removal.
- `sole_skill_guard`: the underperformer is the only member holding a required
  skill. The decision records the underperformance but refuses the removal.
- `needs_more_evidence`: the case event stream is empty or unreadable. The
  skill escalates to the operator rather than inventing metrics.
- `version_conflict`: the `expected_version` does not match the current stream
  version. The append fails with a CAS conflict.

## Output schema

The `tune` runner emits `runx.roster.tuning.v1`:

```json
{
  "schema": "runx.roster.tuning.v1",
  "case_id": "case-rt-1",
  "decision": {
    "underperformer": true,
    "member_to_remove": "writer-alpha",
    "replacement_candidate": "writer-delta",
    "reason": "writer-alpha refusal rate 0.75 exceeds threshold 0.6 and completion time 360s is 3x the 120s norm"
  },
  "projection": {
    "aggregate_id": "case-rt-1",
    "version_before": 3,
    "events_folded": 15
  },
  "appended_judgment": {
    "aggregate_id": "case-rt-1",
    "version_after": 4,
    "idempotency_key": "case-rt-1:roster-tune:v1",
    "event_ref": "agency_cases:case-rt-1:4"
  },
  "folded_metrics": [
    {
      "member": "writer-alpha",
      "skill": "draft-content",
      "turn_count": 12,
      "refusal_count": 9,
      "refusal_rate": 0.75,
      "avg_completion_time": 360,
      "completion_ratio": 3.0
    }
  ],
  "guard_rails": {
    "min_roster_size": 2,
    "remaining_after_removal": 2,
    "sole_skill_block": false
  }
}
```

## Inputs

- `case_id` (required): the agency case identifier.
- `data_source_ref` (required): logical data source holding the sealed case
  event stream.
- `store_id` (optional): opt into the bundled data.local fixture store; omit
  for durable local SQLite.
- `resource` (required): declared event resource or stream family.
- `aggregate_id` (required): the case aggregate id for partition keying.
- `expected_version` (required): current stream version for CAS write.
- `idempotency_key` (required): stable retry key for the judgment append.
- `roster` (required): current roster as `[{member, skill, turn_count}]`.
- `performance_norms` (required):
  `{refusal_threshold, completion_time_threshold, min_roster_size}`.
- `agency_event_schema_version` (required): declared schema version; events
  that do not match are refused.

## Worked example

An agency case `case-docs-1` has run for 30 turns with a roster of three
members: a writer, a reviewer, and a researcher. The operator suspects the
writer is underperforming and runs:

```bash
runx skill roster-tuner tune \
  -i case_id=case-docs-1 \
  -i data_source_ref=tenant://agency/docs-cases \
  -i resource=agency_cases \
  -i aggregate_id=case-docs-1 \
  --input-json expected_version=30 \
  -i idempotency_key=case-docs-1:roster-tune:v1 \
  --input-json roster='[{"member":"writer-alpha","skill":"draft-content","turn_count":12},{"member":"reviewer-beta","skill":"review-skill","turn_count":8},{"member":"researcher-gamma","skill":"deep-research","turn_count":10}]' \
  --input-json performance_norms='{"refusal_threshold":0.6,"completion_time_threshold":120,"min_roster_size":2}' \
  -i agency_event_schema_version=1 \
  --json
```

The skill reads the case projection, folds the writer's metrics (refusal rate
0.75, completion time 360s which is 3x the 120s norm), grades against the
norms, and emits a decision naming `writer-alpha` for removal with
`writer-delta` as a skill-matched replacement. The judgment is appended to the
case stream at version 31. The operator reviews and re-opens the case with the
revised roster.

## Quality Bar

- Fold every metric from the sealed case events; never invent a signal the
  stream does not contain.
- Cite the folded refusal rate and completion time against the named thresholds
  in every underperformer verdict.
- Append the judgment as a CAS write with the caller's `expected_version` and
  `idempotency_key`; never skip the version check.
- Respect all guard rails: `min_roster_size`, sole-skill protection, schema
  version match.
- Stop cleanly with `needs_agent`, `schema_version_mismatch`,
  `min_roster_guard`, `sole_skill_guard`, or `needs_more_evidence` rather than
  producing a weak judgment.
- The roster change is plain data, not an AttenuationRequest or mint. The
  operator is the only lane that acts.

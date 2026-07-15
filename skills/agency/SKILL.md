---
name: agency
description: "Run a standing team with a mandate, advanced one governed case-turn at a time: a fixed roster, a persistent objective, a multi-turn case, member dispatch under a scoped grant, escalation gates, a measurable done-check, and a sealed receipt trail."
runx:
  category: ops
---

# Agency

Run a standing, accountable team toward a mandate, one governed turn at a time.

An agency is the only runx skill that holds a roster, a persistent objective, and a
case that spans turns. It is a governed delegation envelope: a defined set of members
with scope ceilings, a mandate, cumulative limits, and a case whose every turn is
sealed and replayable. It composes the existing skills and reimplements none. Each
turn borrows `ops-desk` for judgment, the roster members for execution, `data-store`
for the event log, and receipts for the ledger.

It is not a durable-execution engine and it is not an autonomous daemon. One turn is
one stateless governed act; an external driver (a human, a cron, a board poll) runs
the loop by calling `advance` until the case resolves.

## What this skill does

- `open` starts a case: it appends `opened` with the mandate, the roster, and the
  cumulative limits snapshot, so the charter travels with the case.
- `advance` runs one turn: it folds the case from its event stream, asks `ops-desk`
  for the single next move constrained to the roster, enforces the measurable gate,
  records one turn event whose append is the contention lease, and names the member
  to run. The member runs as a separate governed run; its outcome is fed back to the
  next `advance` as `member_result`.
- `status` folds and returns the current case state.

The case reducer is the agency's own code, because `data-store` carries events but
does not fold domain state. Everything else is delegation.

## When to use this skill

- A standing, consequential mandate must run for days or weeks, dispatch different
  members, and leave an auditable trail sealed to a bounded authority.
- A process needs scoped delegation with a measurable ceiling and a human gate on
  consequence, not an unbounded agent.

## When not to use this skill

- One-shot or interactive work. Call the member skills directly; the agency is
  overhead when the operator is already the loop.
- To compute proposals (that is `ops-desk`) or claim and clock logic (that is
  `messageboard`). Compose them.
- To bake a storage backend. The case lives in `data-store` via `data_source_ref`.
- To let the model invent the roster, the mandate, or the limits. They are operator
  config, snapshotted into the case at `open`.

## Procedure

1. `open` the case with the mandate, roster, and limits.
2. `advance` the case. Read the turn packet:
   - `advanced`: run the named member under its scope, then `advance` again with the
     member's outcome as `member_result`.
   - `awaiting_approval`: resolve the escalation, then `advance`.
   - `resolved` or `failed`: the case is closed.
3. Repeat until the case resolves. The driver, not this skill, decides the cadence.

## The measurable gate

The done-check and the limit-check are measurable first. `advance` folds cumulative
totals (acts, spend) and the trusted planner overrides the model when a cap is
breached: an over-cap turn fails regardless of what `ops-desk` proposed. The narrative
judgment from `ops-desk` chooses the move within the caps; it never widens them.
Spend caps tracked in the projection are the v1 path; routing spend through `spend`
and runx-pay reservations is the stronger enforcement.

## Contention

Two drivers must not double-fire a member act. Each turn appends a single event keyed
`case_id:turn:driver_id` at the folded `expected_version`. Two drivers racing the same
turn carry different keys, so the loser hits a hard version conflict rather than
replaying the winner, and stops before any dispatch. The append is the lease, and it
lands before the named member runs.

## Edge cases and stop conditions

- No case at `case_id`: `advance` returns `needs_input`; open the case first.
- A cumulative cap is reached: the turn is `failed` with the breached predicate named.
- The best move is consequential and unapproved: `awaiting_approval` with the prompt.
- No roster member can act and nothing is escalatable: escalate to the configured
  human with the missing input named.

## Output schema

`advance` returns one `agency_turn`:

```yaml
agency_turn:
  schema: runx.agency.turn.v1
  status: advanced | awaiting_approval | resolved | needs_input | failed
  case_id: string
  turn: number
  dispatch:                 # present when status == advanced
    member: string
    skill: string
    task: string
    needed_scope: [string]
  approval_prompt: string | null
  resolution: object | null
  predicates: object        # the measurable over_limits booleans
  reason: string | null
  next: string
```

## Inputs

- `open`: `data_source_ref`, `case_id`, `agency_ref`, `mandate`, `roster`, `limits`,
  optional `signal`.
- `advance`: `data_source_ref`, `case_id`, `driver_id`, optional `member_result`.
- `status`: `data_source_ref`, `case_id`.

## Worked example

Open a docs case with a researcher, writer, and reviewer and a 50-turn limit.
`advance` folds an empty-but-opened case, ops-desk picks the researcher, and the turn
returns `advanced` naming the researcher. The driver runs the researcher and calls
`advance` again with its result; ops-desk now picks the writer to draft. When the
reviewer approves and the projection shows the docs current, `advance` returns
`resolved`.

## Turn rules

- Fold every turn from the sealed stream; never infer state the events do not show.
- Enforce the measurable gate before the model's judgment; never widen a cap.
- Name the member and the verification expectation on every dispatch; never claim
  work settled, sent, paid, or done without a receipt.
- Compose ops-desk, data-store, and the members; never reimplement them, and never
  invent the roster or the mandate.
- Stop cleanly with needs_input, awaiting_approval, refused, or failed; never a fake
  ready.

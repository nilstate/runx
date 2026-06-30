---
name: mandate-planner
description: Validate a proposed agency charter against an authority grant and emit a bounded recommended charter only when the charter stays inside the grant.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 10
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  objective:
    type: string
    required: true
    description: "Operator objective for the proposed agency charter."
  proposed_charter:
    type: json
    required: true
    description: "Proposed charter shaped as {candidate_roster:[{role,skill,scope}],requested_limits:{max_turns,spend},done_check}."
  authority_grant:
    type: json
    required: true
    description: "Authority grant shaped as {granted_spend,granted_roles,max_turns}."
runx:
  input_resolution:
    required:
      - objective
      - proposed_charter
      - authority_grant
  artifacts:
    wrap_as: mandate_planner_verdict
    packet: runx.agency.mandate_planner.v1
---

# Mandate Planner

`mandate-planner` is a pure read-only validator for agency charters. It reads an
operator-supplied objective, a proposed charter, and an authority grant, then
fails closed unless every role and limit in the charter is traceable to the
grant.

The skill never opens an agency case, never calls `agency.open`, never mints
authority, never holds state, and never enforces limits itself. If the charter
is eligible, it carries a bounded `recommended_charter` as data only. A
downstream driver or operator may then separately invoke `agency.open` by
naming it and mapping this recommended charter onto `agency.open`'s own roster
and limits inputs.

## Inputs

- `objective`: the agency objective supplied by the operator.
- `proposed_charter`:
  - `candidate_roster`: array of `{ role, skill, scope }`
  - `requested_limits`: `{ max_turns, spend }`
  - `done_check`: measurable completion predicate
- `authority_grant`:
  - `granted_spend`
  - `granted_roles`
  - `max_turns`

## Output

The default runner emits a typed `runx.agency.mandate_planner.v1` packet:

- `decision`: `{ eligible, reason }`
- `recommended_charter`: only when eligible, containing bounded `scopes`,
  `spend`, `max_turns`, `counterparty`, and `done_check`
- `escalation`: human approval lane guidance when not eligible
- `dispatch_target`: dispatch-by-naming metadata for the separate
  `agency.open` run, only when eligible
- `evidence`: role trace, requested limits, authority limits, done-check, and
  blockers

## Decision rules

1. Every roster role must be present in `authority_grant.granted_roles`.
2. Requested spend must be at or below `authority_grant.granted_spend`.
3. Requested turns must be at or below `authority_grant.max_turns`.
4. The proposed charter must include a measurable `done_check`.
5. The skill never invents a roster member, spend cap, turn cap, or done-check.
6. Ambiguous or out-of-grant charters escalate to a human approval lane and do
   not emit a recommended charter.

## Harness

The inline harness declares two cases:

- `in_grant_charter`: eligible charter; the default runner seals a verdict with
  `decision.eligible = true`, a bounded recommended charter, and dispatch
  metadata for a separate `agency.open` run.
- `out_of_grant_charter`: ungranted `deployer` role, excessive turns/spend, and
  no measurable done-check; the human approval lane blocks as `needs_agent`
  with no recommended charter emitted by that lane.

## Example local run

```bash
runx harness ./skills/mandate-planner
runx skill ./skills/mandate-planner --json \
  -i objective="Validate an in-grant release support charter" \
  --input-json proposed_charter='{"candidate_roster":[{"role":"release-analyst","skill":"flaky-test-judge","scope":"read test receipts"}],"requested_limits":{"max_turns":4,"spend":20},"done_check":"Verify a sealed review receipt exists."}' \
  --input-json authority_grant='{"granted_spend":50,"granted_roles":["release-analyst"],"max_turns":6}'
```

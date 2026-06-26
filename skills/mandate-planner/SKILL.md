---
name: mandate-planner
description: Validate a proposed agency charter against an explicit authority grant before any agency.open run is issued.
runx:
  category: agency
---

# Mandate Planner

Validate a proposed agency charter against the authority an operator actually
holds. This skill is a read-only judgment step. It never opens an agency case,
never mints authority, never stores state, and never calls `agency.open`.

Use it when an operator or downstream driver has:

- an `objective`
- a `proposed_charter` containing candidate roles, requested limits, and a
  measurable done-check
- an `authority_grant` containing granted roles, spend cap, and turn cap

The skill emits an eligible decision plus a bounded `recommended_charter` only
when every requested role and limit fits inside the grant. Ambiguous,
over-limit, or under-specified charters stop for the human approval lane.

## Inputs

`objective` is a short string naming the work the charter is meant to govern.

`proposed_charter` must contain:

- `candidate_roster`: array of `{ role, skill, scope }`
- `requested_limits`: `{ max_turns, spend }`
- `done_check`: measurable completion predicate

`authority_grant` must contain:

- `granted_spend`
- `granted_roles`
- `max_turns`

## Output

When eligible, emit:

- `decision.eligible: true`
- `decision.reason`
- `recommended_charter.scopes`
- `recommended_charter.spend`
- `recommended_charter.max_turns`
- `recommended_charter.counterparty`
- evidence tying every roster role and every limit back to the grant

When refused, emit:

- `decision.eligible: false`
- `decision.route: needs_agent`
- `decision.reason`
- no `recommended_charter`

## Guardrails

- Refuse roster roles not present in `authority_grant.granted_roles`.
- Refuse requested spend above `authority_grant.granted_spend`.
- Refuse requested turns above `authority_grant.max_turns`.
- Refuse missing or non-measurable done-checks.
- Never invent a role, roster member, spend cap, turn cap, counterparty, or
  done-check.
- Treat `agency.open` as a downstream dispatch-by-naming step. This skill only
  emits data for a separate governed run.

## Verification

A reviewer should be able to inspect the returned decision and see:

- each roster role is copied from `candidate_roster`
- each role is present in `authority_grant.granted_roles`
- spend and turn limits are at or under the grant
- refused charters name the exact failing constraint
- no effectful agency action occurred

---
name: mandate-planner
description: Validate a proposed agency charter against an explicit authority grant, then emit a bounded recommended charter only when it fits inside that grant.
runx:
  category: ops
---

# Mandate Planner

Validate an agency charter before a downstream driver opens a governed agency case.

Agency work is safest when the operator's mandate, roster, limits, and done-check
are explicit. This skill reads a proposed charter and an authority grant, proves
whether the charter stays inside that grant, and emits one typed
`runx.agency.mandate_plan.v1` verdict. It is read-only: it does not call
`agency.open`, does not mint a case, does not hold state, and does not enforce
limits as an effect. A downstream driver or operator may later issue a separate
governed `agency.open` run by naming this verdict and mapping the recommended
charter onto agency's own inputs.

## What this skill does

1. Reads `objective`, `proposed_charter`, and `authority_grant`.
2. Confirms every candidate roster role is explicitly present in
   `authority_grant.granted_roles`.
3. Confirms requested spend and turn caps are at or below the grant.
4. Requires a measurable `done_check`; ambiguous charters stop before dispatch.
5. Emits `decision.eligible=true` plus `recommended_charter` only when every
   check passes.
6. Emits `decision.eligible=false` with a named reason and human approval lane
   when a charter is missing, ambiguous, or outside the grant.

## When to use this skill

- Before opening an agency case from a proposed mandate.
- When a human or driver needs a receipt-backed proof that a charter is bounded.
- When an operator wants a fail-closed review of roster roles, spend, turns, and
  completion criteria before any downstream dispatch can happen.

## When not to use this skill

- To open or advance an agency case. Use `agency.open` or `agency.advance` as
  separate governed runs after this verdict.
- To invent a roster, spend cap, turn cap, counterparty, or done-check.
- To approve ambiguous authority. Ambiguity routes to a human approval lane.
- To claim that a downstream effect happened. This skill emits a verdict only.

## Procedure

1. Validate inputs.
   - `objective` must name the mandate being checked.
   - `proposed_charter.candidate_roster` must be a non-empty array of
     `{role, skill, scope}` objects.
   - `proposed_charter.requested_limits` must include numeric `max_turns` and
     `spend`.
   - `proposed_charter.done_check` must be a measurable predicate string.
   - `authority_grant` must include `granted_roles`, `max_turns`, and
     `granted_spend`.

2. Trace every roster role.
   - Each proposed role must appear exactly in `authority_grant.granted_roles`.
   - Every accepted role is copied from `candidate_roster`; no roster member is
     invented or renamed.
   - A missing role blocks with `reason_code=role_outside_grant`.

3. Bound every limit.
   - `requested_limits.max_turns` must be at or below
     `authority_grant.max_turns`.
   - `requested_limits.spend` must be at or below
     `authority_grant.granted_spend`.
   - Above-grant requests block with `reason_code=limit_exceeds_grant`.

4. Require measurable completion.
   - `done_check` must contain a concrete predicate such as `when`, `until`,
     `metric`, `receipt`, `merged`, `published`, `delivered`, `verified`, or an
     explicit comparison.
   - Missing or vague checks block with `reason_code=missing_done_check`.

5. Emit the verdict and stop.
   - Eligible verdicts carry `recommended_charter` with scopes, spend,
     max_turns, counterparty, roster, and done_check as data.
   - Blocked verdicts carry no `recommended_charter`.
   - Every verdict describes the dispatch-by-naming seam and the human approval
     lane for ambiguous or out-of-grant cases.

## Output schema

Return a structured object:

```yaml
mandate_plan:
  schema: runx.agency.mandate_plan.v1
  objective: string
  decision:
    eligible: boolean
    reason: string
    reason_code: eligible | role_outside_grant | limit_exceeds_grant | missing_done_check | invalid_input
  recommended_charter: object | null
  escalation:
    lane: none | human_approval
    reason: string | null
    needs_agent: boolean
  trace:
    role_checks: array
    limit_checks: array
    done_check: string | null
  dispatch_by_naming:
    downstream_run: agency.open
    effect_status: not_called
    mapping: object
```

The runner also emits a top-level `decision`, `recommended_charter`, and
`verdict` for simple clients.

## Example

Given a charter with a researcher and reviewer, a requested spend of `120`, a
turn cap of `12`, and an authority grant allowing those roles with `150` spend
and `20` turns, the skill returns `eligible=true` and a recommended charter
copied from the proposed inputs. If the proposed charter adds an ungranted
`buyer` role or asks for `250` spend, it returns `eligible=false`, routes to
`human_approval`, and emits no recommended charter.

## Quality bar

- Never recommend a roster role absent from `authority_grant.granted_roles`.
- Never recommend spend or turns above the grant.
- Never fill in missing done-checks or invented roster members.
- Always name the exact blocked predicate for refusals.
- Always state that `agency.open` is a separate governed run issued by a
  downstream driver or operator.

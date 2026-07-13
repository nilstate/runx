---
name: incident-commander
description: Advance a declared incident over the runx agency spine with a fixed commander, responder, and communications roster, approval-bound send handoffs, and receipt-backed resolution.
runx:
  category: ops
---

# Incident commander

Advance one command decision for a declared incident whose durable case is owned
by the runx `agency` spine. The skill consumes the already-folded case state and
fixed incident roster, asks `ops-desk` for one bounded move, reviews that move,
and applies deterministic roster and evidence guards before returning one typed
`incident_turn`.

The skill does not open or persist a case, append events, send messages, mint
authority, or resolve approvals. An agency driver owns those actions. In
particular, a communication decision is dispatch-by-naming: this skill may name a
separate governed `slack-notify` or `send-as` run after approval, but it never
executes that run.

## What this skill does

- asks a package-local binding of the pinned official `ops-desk` advance
  contract for one roster-constrained move;
- applies a reviewer act and deterministic enforcement to that move;
- returns one typed, audit-friendly incident turn;
- names a plan-only communication handoff while leaving execution to a separate
  governed run.

## When to use this skill

Use this skill when an existing agency case represents a declared incident and
the next command decision must stay within its fixed roster, approval lane, and
receipt trail.

## When not to use this skill

Do not use it to declare or persist a case, send a message, authenticate an
approval, mint authority, bypass the agency lease, or substitute an unverified
string for a receipt. Those responsibilities remain with the agency driver and
the named governed skill.

## Incident lifecycle

Use `incident_objective` with exactly one of these values:

- `begin`: advance declaration and initial command work.
- `assign`: dispatch work only when folded state names a roster owner.
- `send`: gate and name a digest-bound communications handoff.
- `resolve`: require linked resolution evidence before closure.
- `postmortem`: dispatch follow-up work within the fixed roster.

Inputs are `case_id`, `driver_id`, `incident_objective`, folded `case_state`, and
the fixed `roster`. `approval` is optional and carries `{ principal, reason }`.
`member_result` is optional and carries `{ outcome, receipt_ref }` from a
previously dispatched member.

The roster contains exactly `commander`, `responder_lead`, and `comms_lead`.
Every entry names its principal, skill, and scope ceiling. The enforcement stage
rejects missing or duplicate roles, mismatched skills, excess scopes, invented
principals, and incomplete entries.

## Communication gate

A pending send is represented in folded state as a non-actionable
`pending_escalation.proposed_handoff`. It binds:

- `skill`: `slack-notify` for an internal post or `send-as` for a stakeholder send.
- `principal`: the exact `comms_lead` principal.
- `channel` and `audience`.
- `content_digest`: a SHA-256 digest of the reviewed content.

Without an approval whose principal exactly matches `comms_lead`, the turn stays
`awaiting_approval` in the human incident-reviewer lane. `named_run` describes
the bound plan with `executable: false`; it carries no dispatch authority.
After a match, the turn may become `advanced` and name the bounded handoff. That
is still not proof of delivery. Delivery requires a later `member_result` linked
to the receipt emitted by the named communications skill.

## Agency ownership

Durable state and contention remain in `agency`. Its runner folds the event
stream, plans one turn, and appends at `expected_version`. The logical
idempotency key is `case_id:turn:driver_id`; the current agency serialization is
`<case_id>:turn:<turn>:<driver_id>`. The ungated compare-and-swap append is the
per-turn lease, so a racing driver conflicts before any dispatch. This package
does not compose `data-store` and cannot bypass that lease.

## Output

The runner emits one `incident_turn` with status, case id, turn, dispatch or
escalation, optional named run, and reason. It also records severity and approval
principal for audit. Expected statuses are `advanced`, `awaiting_approval`,
`resolved`, `needs_agent`, or `refused`.

## Output schema

```yaml
incident_turn:
  status: advanced | awaiting_approval | resolved | needs_agent | refused
  case_id: string
  turn: number
  dispatch: object | null
  escalation: object | null
  named_run:
    skill: slack-notify | send-as
    runner: plan
    executable: boolean
    data:
      principal: string
      channel: string
      audience: object
      content_digest: sha256:<hex>
  reason: string
```

## Procedure

1. Receive a folded, declared incident state and its fixed roster from the
   agency driver.
2. Ask the package-local `ops-desk-advance` binding for exactly one move. The
   binding carries the official advance task and typed decision contract without
   importing the agency loop or persistence graph.
3. Review the move against the incident objective and existing evidence.
4. Enforce roster role, principal, skill, scope, approval, handoff, owner, and
   receipt invariants deterministically.
5. Return one incident turn. The agency driver appends it under the folded
   version before issuing any named dispatch.

The judgment stops rather than guessing when:

- an assignment has no named owner in folded state;
- a send lacks a valid roster-bound handoff or matched approval;
- a dispatch names a role, skill, or scope outside the roster;
- a delivered communication lacks a `slack-notify` or `send-as` receipt;
- resolution lacks linked evidence;
- the incident is undeclared or lacks severity or scope.

## Edge cases and stop conditions

- An unknown ops-desk decision is refused rather than treated as a dispatch.
- Missing or malformed `needed_scope` is refused.
- A named assignment owner must resolve to one roster role or principal, and
  the dispatch must select that role.
- A communication handoff is always hard-coded to runner `plan`; caller input
  cannot select a live execution runner.
- Only the `resolve` objective can close the incident, and its receipt reference
  must have runx receipt shape.

## Inputs

- `case_id` and `driver_id`: current agency case and driver identifiers.
- `incident_objective`: `begin`, `assign`, `send`, `resolve`, or `postmortem`.
- `case_state`: folded declared incident state, including severity, scope, turn,
  pending escalation, and linked evidence.
- `roster`: exactly commander, responder lead, and communications lead with
  principal, skill, and nonempty scope ceiling.
- `approval`: optional `{ principal, reason }` supplied by the agency approval
  path; this skill matches it but does not authenticate it.
- `member_result`: optional `{ outcome, receipt_ref }` already verified and
  carried back by the agency driver.

## Worked example

A SEV-2 checkout incident has a pending `send-as` stakeholder update bound to
an audience and content digest. The prior turn names that plan as non-executable
and waits in `human:incident-reviewer`. On the follow-up turn, approval principal
`incident:comms:morgan` matches the `comms_lead` roster entry. The output advances
and names `send-as` runner `plan` with the same audience and digest. It does not
claim delivery; a later member result must link the send receipt.

## Run

Run the local harness before publication:

```text
runx harness ./skills/incident-commander --json
```

After publication, install and run the immutable registry version, then verify
the dogfood receipt:

```text
runx add <owner>/incident-commander@0.1.0
runx skill <owner>/incident-commander@0.1.0 --json
runx verify --receipt <receipt.json> --json
```

The package is self-contained. Its internal `ops-desk-advance` binding is scoped
to this graph and returns only the typed judgment; it does not vendor or compose
the agency state loop, `data-store`, or any execution lane.

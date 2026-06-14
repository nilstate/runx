---
name: agent-handoff
description: Package a bounded task for another agent under scoped authority, with explicit acceptance criteria and a deadline.
runx:
  category: ops
---

# Agent Handoff

Delegation has a default failure mode: the second agent inherits the goal but
not the limits. It picks up "ship the migration" with whatever scope the caller
happened to hold, no clear definition of done, and no clock. This skill turns
that loose pass into a delegation contract. It states the bounded task, the
scopes the receiver is allowed to use, the criteria that count as done, and the
deadline the work is judged against.

It produces an explicit delegation contract; the runtime's implicit handoff
carries no acceptance criteria or scoped grant.

The skill refuses to widen authority. The receiver's grant is bounded to what
the caller already holds. When the requested grants exceed the caller's own
scope, the handoff stops for approval instead of inventing authority. It also
refuses to put secret values into a grant; a grant names a scope, never a key.

## What this skill does

1. Pin the task to one bounded deliverable, not a standing role.
2. Bind the receiver: which agent gets the work.
3. Scope the grant: the exact authority the receiver may exercise, by scope
   string, nothing wider than the caller holds.
4. Fix the acceptance criteria: the checklist that decides accepted or rejected.
5. Set a deadline the work is measured against.
6. Carry context by reference, never by inlining secrets or raw payloads.
7. Decide the gate: approval when the grant escalates past the caller's scope.

## When to use this skill

- One agent needs to delegate a discrete unit of work to another and wants the
  result to be acceptable on first return, not renegotiated.
- A supervisor agent fans work out to specialists and needs each branch bounded
  by scope and a clock.
- A run must record what authority a sub-agent was given before it acts, so a
  later receipt audit can compare granted against used.
- A human wants to review the delegation contract (task, grant, criteria,
  deadline) before the receiver starts.

## When not to use this skill

- To run the delegated task yourself. This skill packages the handoff; it does
  not execute the work.
- To grant authority the caller does not already hold. Escalation is a human
  decision and routes through the approval gate.
- To pass a secret to the receiver. Hand off a bound credential reference or a
  vault handle; never the secret value.
- To define a standing role or open-ended mandate. The unit of handoff is one
  bounded task with a deadline.
- To deliver a payload to an external orchestrator over a webhook. That is the
  `zapier-handoff` and `n8n-handoff` job; this skill targets another agent under
  runx authority.

## Procedure

1. State the task as one bounded deliverable.
   - Name the concrete outcome and its boundary. "Refactor the auth module to
     remove the deprecated token path" is bounded; "improve auth" is not.
   - Gate: if the task is a standing role or has no completion boundary, stop
     with `needs_agent`.

2. Bind the receiver.
   - Name the agent the work goes to. A handoff has exactly one receiver.
   - Gate: if no receiver is named, stop with `needs_agent`.

3. Scope the grant.
   - List the exact scopes the receiver may exercise, in canonical policy
     syntax: for example `repo:write:auth/*`, `net:allowlist:api.internal`,
     `wallet:spend<=$50`.
   - Compare each requested scope against the caller's own grant. A scope the
     caller does not hold cannot be passed; mark it `escalates`.
   - Gate: if any requested scope escalates past the caller, set
     `gates.approval_required: true` and do not treat the grant as authorized
     until an approval ref is present.
   - Never place a secret value in a grant. A grant is a scope, not a key.

4. Fix the acceptance criteria.
   - Write a checklist a reviewer (human or agent) can run to decide accepted or
     rejected. Each item is a verifiable condition, not a vibe.
   - Gate: if no success criteria are provided, stop with `needs_agent`. A
     handoff without a definition of done is not a contract.

5. Set the deadline.
   - Bind a deadline the work is judged against. When the caller gives one, carry
     it. When the caller gives none, derive a bounded default from the task and
     mark it `derived` so the receiver knows it was not explicit.

6. Carry context by reference.
   - Reference prior receipts, files, threads, or specs by stable ref or digest.
   - Do not inline raw fetched content, customer data, or secret material into
     `context_refs`. If a needed reference would expose a secret, replace it with
     a handle and note the substitution.

7. Emit the handoff packet.
   - The packet carries the task, receiver, bounded grant, acceptance checklist,
     deadline, context refs, and gate decision. It is the contract the receiver
     accepts and the artifact a reviewer signs off.

## Edge cases and stop conditions

- **Missing task, receiver, grants, or success criteria:** return `needs_agent`.
  These four are the contract; without any one of them there is nothing to hand
  off.
- **Grant exceeds caller scope:** set `gates.approval_required: true` and hold
  the escalating scopes as unauthorized until an approval ref lands. Do not drop
  the escalation silently and do not widen.
- **Secret in a grant or context ref:** refuse to carry the value. Substitute a
  bound handle or reference and record the substitution. If the handoff cannot
  be expressed without the raw secret, return `needs_agent`.
- **Unbounded task:** return `needs_agent`; a role is not a handoff.
- **Empty acceptance criteria:** return `needs_agent`; an unmeasurable handoff
  cannot be accepted or rejected.
- **No deadline given:** derive a bounded default and mark it `derived`; never
  leave the work open-ended.
- **Self-handoff:** if the named receiver is the caller, return `needs_agent`;
  delegation requires a distinct receiver.

## Governance

- **Scopes the packet declares:** only the scopes the receiver is granted, each
  bounded and named in canonical syntax. The packet itself exercises no runtime
  authority beyond preparing the contract.
- **Gate:** approval is required when any requested grant escalates past the
  caller's own scope. Non-escalating handoffs proceed without an approval gate;
  the bounded grant is still recorded.
- **Receipt:** the sealed `runx.receipt.v1` carries the task ref, receiver,
  granted scope set, acceptance-criteria digest, deadline, the approval ref when
  one was required, and any escalation that was refused. It carries no secret
  values and no raw context, only refs and digests.

## Output

Return one `handoff_packet` object with these fields:

- `handoff_packet.task`: the bounded deliverable, with its completion boundary.
- `handoff_packet.to_agent`: the single receiver of the work.
- `handoff_packet.grants`: array of scope strings the receiver may exercise,
  each marked `held` or `escalates`. Scope strings only, never secret values.
- `handoff_packet.success_criteria`: the acceptance checklist that decides
  accepted or rejected.
- `handoff_packet.deadline`: the deadline the work is judged against, with a
  `source` of `caller` or `derived`.
- `handoff_packet.context_refs`: array of references (receipt ids, file paths,
  digests, handles). By ref only; no inlined secrets or raw content.
- `handoff_packet.gates`: gate decision, with `approval_required` true when any
  grant escalates, plus the `approval_ref` when present.
- `handoff_packet.acceptance`: the normalized `checklist` a reviewer runs to
  accept or reject the returned work.
- `handoff_packet.status`: `ready`, `needs_agent`, or `needs_approval`.

## Inputs

- `task` (required): the bounded deliverable to delegate.
- `to_agent` (required): the agent that receives the work.
- `grants` (required): the scopes the receiver gets, in canonical policy syntax.
  Scopes only; no secret values.
- `success_criteria` (required): the acceptance checklist that decides done.
- `context_refs` (optional): references to receipts, files, threads, or specs.
  By ref or digest only.

## Quality Profile

- Purpose: turn a loose delegation into a reviewable contract that bounds one
  task, one receiver, one grant, one definition of done, and one deadline.
- Audience: the receiving agent that accepts the work, a supervisor agent that
  fans work out, and a human or reviewer who approves the grant before the
  receiver starts.
- Artifact contract: a `handoff_packet` object whose load-bearing fields are
  `task`, `to_agent`, `grants` (each scope marked `held` or `escalates`),
  `success_criteria`, `deadline` (with `source`), `context_refs` (by ref),
  `gates.approval_required`, and `acceptance.checklist`. Grants carry scope
  strings only, never secret values.
- Evidence bar: every grant is a named scope checked against the caller's own
  authority; every acceptance item is verifiable; every context entry is a ref
  or digest, not inlined content. An escalating grant is named as such, not
  smoothed over.
- Voice bar: direct operator language addressed to the receiving agent. State
  the contract; do not narrate the delegation or pad with coordination filler.
- Strategic bar: a bounded grant plus an explicit definition of done is what
  lets a multi-agent run be audited and accepted on first return instead of
  renegotiated mid-flight.
- Stop conditions: return `needs_agent` when task, receiver, grants, or success
  criteria is missing, when the task is unbounded, or when the handoff cannot be
  expressed without a raw secret; return `needs_approval` when a requested grant
  escalates past the caller's scope and no approval ref is present.

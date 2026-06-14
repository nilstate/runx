---
name: agent-handoff
description: Package a bounded task for another agent under scoped authority, with explicit acceptance criteria and a deadline.
runx:
  category: ops
---

# Agent Handoff

Govern the delegation of one bounded task from one agent to another.

Delegation has a default failure mode: the second agent inherits the goal but
not the limits. It picks up "ship the migration" with whatever scope the caller
happened to hold, no clear definition of done, and no clock. This skill turns
that loose pass into a delegation contract. It states the bounded task, the
scopes the receiver is allowed to use, the criteria that count as done, and the
deadline the work is judged against.

## What this skill does

This skill produces an explicit delegation contract: a `handoff_packet` that
binds the bounded task, the single receiver, the scoped grant, the acceptance
criteria, the deadline, and the gate decision. It refuses to widen authority;
the receiver's grant is bounded to what the caller already holds, and a grant
names a scope, never a secret value.

It differs from the runtime's implicit handoff, which carries no acceptance
criteria and no scoped grant. The implicit pass hands over the goal; this skill
hands over the contract.

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
- To compose several catalog skills into a multi-hop run-graph with a receipt
  per step. That is the `orchestrator` job; this skill packages one bounded
  delegation to a single receiver, not a graph.
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

The sealed `runx.receipt.v1` carries the task ref, receiver, granted scope set,
acceptance-criteria digest, deadline, the approval ref when one was required,
and any escalation that was refused. It carries no secret values and no raw
context, only refs and digests.

## Output schema

```yaml
handoff_packet:
  status: ready | needs_agent | needs_approval
  task:
    deliverable: string
    boundary: string
  to_agent: string
  grants:
    - scope: string        # canonical policy syntax; never a secret value
      state: held | escalates
  success_criteria: array  # verifiable acceptance conditions
  deadline:
    value: string
    source: caller | derived
  context_refs: array      # receipt ids, file paths, digests, handles; by ref only
  gates:
    approval_required: boolean
    approval_ref: string | null
  acceptance:
    checklist:
      - id: string
        condition: string
```

## Worked example

Input: "Refactor the auth module to remove the deprecated token path and update
its tests," handed to the `builder` agent, with grants `repo:write:auth/*` and
`repo:read:auth/*` (both held by the caller), three verifiable success criteria,
and context refs to a prior review receipt and the token file.

Output: `status: ready`; the task is bounded to the auth module with a stated
boundary; both grants are marked `held`, so no escalation and
`gates.approval_required: false`; the deadline is `derived` because the caller
gave none; the acceptance checklist is normalized to three runnable conditions.
Had a grant exceeded the caller's scope, the packet would mark it `escalates`,
set `approval_required: true`, and return `needs_approval` until an approval ref
landed.

## Inputs

- `task` (required): the bounded deliverable to delegate, with a completion
  boundary; not a standing role.
- `to_agent` (required): the single agent that receives the work.
- `grants` (required): the scopes the receiver gets, in canonical policy syntax.
  Scopes only; no secret values.
- `success_criteria` (required): the acceptance checklist that decides done.
- `context_refs` (optional): references to receipts, files, threads, or specs.
  By ref or digest only.

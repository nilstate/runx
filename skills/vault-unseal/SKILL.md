---
name: vault-unseal
description: Plan a scoped, time-bounded unseal of a secret under explicit approval and full audit, returning a bound handle and never the secret value.
runx:
  category: security
---

# Vault Unseal

Turn a request for a secret into a reviewable, time-bounded access plan that
hands back a bound handle instead of the secret.

An agent rarely needs a secret. It needs the thing the secret unlocks: one API
call, one signed request, one decrypt for a stated window. This skill plans that
access. It binds the secret reference, the purpose, a TTL, the scope the secret
covers, and the principal asking, then routes the request through a human
approval gate and an audit append. The output is an unseal plan carrying an
opaque handle. The secret value is never read into the plan, the receipt, or the
agent's context.

It governs explicit secret access with a TTL and approval; least-privilege-auditor
only analyzes scopes, it never touches secrets.

## What this skill does

1. Resolve the request: which secret, for what, for how long, covering what,
   on behalf of whom.
2. Check the purpose and scope against policy before any unseal is contemplated.
3. Set the gate: human approval is always required for a live unseal.
4. Bind the access to a single secret reference for one TTL window.
5. Return a bound handle the caller can use within the window, plus the audit
   binding that records the access.

## When to use this skill

- An agent or workflow needs a credential, key, or token to complete one bounded
  task and the access must be approved and audited.
- A break-glass or just-in-time access request needs a plan a reviewer can read
  and a window that expires on its own.
- A downstream action skill needs a handle to a secret, not the secret, so the
  value never enters its context or its receipt.
- An operator wants the access decision (`ready`, `needs_review`, `denied`) and
  the audit trail separated from the secret material itself.

## When not to use this skill

- To read, print, copy, or return a secret value. This skill returns a handle;
  it never reveals the value.
- To grant standing or unbounded access. Every unseal is scoped to one secret
  for one TTL.
- To review or narrow scopes that a subject already holds. Use
  least-privilege-auditor for scope analysis against receipts.
- To rotate, store, or mint new secrets. That is a separate vault operation with
  its own gate.
- To bypass the approval gate, widen the scope past the stated purpose, or
  extend a TTL that has already lapsed.

## Procedure

1. Resolve the request.
   - Confirm `secret_ref`, `purpose`, `ttl`, `scope`, and `principal` are
     present.
   - Gate: if any required input is missing, stop with `needs_agent` and name
     what is missing. Do not guess a default TTL or scope.

2. Check purpose and scope against policy.
   - Confirm the stated purpose is a permitted reason to access this secret, and
     that the scope does not exceed what the purpose needs.
   - Gate: if the purpose or scope is not permitted, stop with `policy_denied`
     and set `decision: denied`. Name the policy that refused, not the secret.

3. Set the TTL window.
   - Parse `ttl` into a duration. The window starts at approval, not at request.
   - Gate: if the TTL is unparseable, absent, or unbounded, return `needs_agent`.
     There is no open-ended unseal.

4. Set the approval gate.
   - A live unseal always requires human approval. Set
     `gates.human_approval_required: true`.
   - Until approval is recorded, `decision` is `needs_review`, never `ready`.

5. Bind the access.
   - Bind the plan to exactly one `secret_ref` for one TTL window under the
     `scope vault:unseal` limited to that reference.
   - Reserve the audit append: the access is recorded via `ledger:append` and the
     receipt reference is carried in `audit_binding.receipt_ref`.

6. Return the handle, not the value.
   - On approval, the plan carries an opaque, bound `handle` the caller uses
     within the window. The secret value never appears in the plan, the handle,
     the audit entry, or the receipt.
   - Set `decision: ready` only when policy passed, the TTL is bound, and human
     approval is recorded.

## Edge cases and stop conditions

- **Missing required input:** `secret_ref`, `purpose`, `ttl`, or `scope` absent
  returns `needs_agent`. The principal is also required to attribute the access.
- **Purpose not permitted:** return `policy_denied` with `decision: denied`;
  name the refusing policy, never the secret.
- **Scope exceeds purpose:** narrow to what the purpose needs, or return
  `policy_denied` if it cannot be narrowed safely.
- **Unbounded or lapsed TTL:** refuse. There is no standing unseal and no revival
  of an expired window.
- **Approval absent or denied:** `decision` stays `needs_review` or moves to
  `denied`; the handle is not issued.
- **Caller asks for the raw value:** refuse that part and return the bound handle.
  If the workflow genuinely cannot use a handle, return `needs_agent` with the
  constraint named, never the value.
- **Audit append unavailable:** do not issue a `ready` plan; an unauditable
  unseal is a denied unseal.

## Output

The artifact is the `unseal_plan` object, wrapped as `runx.unseal.v1`. The
secret value never appears in any field.

- `unseal_plan.decision`: `ready`, `needs_review`, or `denied`.
- `unseal_plan.secret_ref`: the reference to the secret, not its value.
- `unseal_plan.handle`: an opaque, bound handle valid only within the TTL window.
  Never the secret value.
- `unseal_plan.ttl`: the bound duration; the window starts at approval.
- `unseal_plan.scope`: what the secret unlocks, as stated and as bound.
- `unseal_plan.principal`: who the access is attributed to.
- `unseal_plan.gates`: `{ human_approval_required }`; always true for a live
  unseal.
- `unseal_plan.audit_binding`: `{ receipt_ref }`; the ledger append that records
  the access.
- `unseal_plan.blockers` (optional): named reasons the plan is not `ready`.

## Worked example

Input: principal `svc/report-exporter` requests `vault://drive/service-account`
for the purpose "sign one Drive export request", `ttl: 10m`, scope
`{ resource: drive.files, action: export, path: /reports/* }`.

Output: `decision: needs_review` until approval; policy permits the purpose and
the scope matches it; `gates.human_approval_required: true`; once approval is
recorded, `decision: ready` with an opaque `handle` valid for ten minutes from
approval and `audit_binding.receipt_ref` set to the ledger append. The service
account key never enters the plan or the receipt.

## Quality Profile

- Purpose: plan one scoped, time-bounded secret unseal under explicit approval
  and audit, returning a bound handle that downstream work can use without ever
  reading the secret value.
- Audience: the operator who approves the access, the reviewer who audits it
  later, and the action skill that will use the handle within the window.
- Artifact contract: `unseal_plan` with `decision`, `secret_ref`, `handle`,
  `ttl`, `scope`, `principal`, `gates.human_approval_required`, and
  `audit_binding.receipt_ref`. The secret value appears in no field.
- Evidence bar: every `decision` cites the policy check on purpose and scope, the
  parsed TTL window, and the approval state. A `ready` plan names the approval
  reference and the audit append; a `denied` plan names the refusing policy, not
  the secret.
- Voice bar: terse operator-to-operator security prose. State the decision and
  the gate plainly. Interface fields stay factual. Do not soften refusals and do
  not narrate the secret's contents, which the skill never sees.
- Strategic bar: a secret should be unsealed for one purpose, for one window,
  with one approval, leaving one audit entry. The plan exists so access is
  reviewable and self-expiring rather than standing and invisible.
- Stop conditions: return `needs_agent` when `secret_ref`, `purpose`, `ttl`, or
  `scope` is missing or the TTL is unbounded; return `policy_denied` with
  `decision: denied` when the purpose or scope is not permitted; hold at
  `needs_review` until human approval is recorded.

## Inputs

- `secret_ref` (required): reference to the secret to unseal, never its value.
- `purpose` (required): the bounded reason the secret is needed.
- `ttl` (required): the access window duration; the window starts at approval.
- `scope` (required): structured statement of what the secret unlocks.
- `principal` (required): who the access is attributed to.
- `policy_notes` (optional): reserved purposes, break-glass conditions, or
  constraints that affect the decision.
- `operator_context` (optional): approval posture or extra guardrails.

---
name: purchase-approval
description: "Decide a purchase request before any spend is committed. Reads the procurement policy and the current budget balance, then decides approve-in-full, scope-down, or deny. On approval it emits a typed approval decision plus a bounded AttenuationRequest ceiling (amount, currency, counterparty, scopes) as data. It is the forward counterpart to settle-invoice and is distinct from expense-policy-check (post-hoc)."
runx:
  category: finance
---

# Purchase Approval

Decide a purchase request before any spend is committed.

A purchase request arrives with amount, vendor, and purpose. The dangerous part is
the approval call, not the payment itself — once money moves, the only remaining
levers are post-hoc (settle-invoice, expense-policy-check). This skill is the
forward gate: it reads the procurement policy and the current budget balance,
decides **approve-in-full**, **scope-down**, or **deny** against that policy, and on
approval emits a typed approval decision plus a bounded `AttenuationRequest` ceiling
(amount, currency, counterparty, scopes) as data. It never spends; it only decides
and emits the ceiling that a later spend step must stay inside.

## What this skill does

- Reads the procurement `policy` (spend caps per scope, required approval tiers,
  vendor allow/deny lists, purpose categories) and the `budget` balance for the
  relevant cost center.
- Folds the incoming request (amount, vendor, purpose, requested_scopes) against the
  policy and the remaining budget.
- Decides one of three outcomes:
  - `approve_in_full` — request is within policy and budget.
  - `scope_down` — request exceeds a cap or scope but a bounded subset is approvable;
    emits a reduced `AttenuationRequest` ceiling.
  - `deny` — request violates policy or overruns budget with no safe subset.
- On approve/scope_down, emits a typed `approval_decision` plus a bounded
  `AttenuationRequest` (amount, currency, counterparty, scopes, expires_at) as data
  — never a payment, never a send.
- Is strictly a decision gate: it appends nothing, spends nothing, sends nothing.

## When to use this skill

- A purchase request needs a pre-spend approval decision with a bounded ceiling.
- A downstream spend step needs a typed, attestable approval before it commits funds.
- An agent wants to scope-down an over-budget request to the largest policy-compliant
  amount instead of a hard deny.

## When not to use this skill

- To settle an invoice already approved. Use `settle-invoice`.
- To judge post-hoc reimbursement after money moved. Use `expense-policy-check`.
- To actually execute the payment. This skill decides and emits; it never spends.

## Procedure

1. Resolve inputs: `policy_ref`, `budget_ref`, `request` (amount, vendor, purpose,
   requested_scopes, currency).
2. Read policy + budget (read-only; no mutation).
3. Fold request against policy caps, vendor lists, and remaining budget.
4. Decide approve_in_full / scope_down / deny.
5. On approve/scope_down emit `approval_decision` + bounded `AttenuationRequest`.
6. Return the packet.

## Declared default policy (if `policy` omitted)

```yaml
policy:
  max_per_request: 5000          # hard cap per single request (currency units)
  scope_caps:                    # per-scope soft caps
    software: 2000
    hardware: 3000
    services: 1500
  vendor_deny: []                # vendor ids never approvable
  require_purpose: true
  budget_floor: 0                # deny if remaining < this after request
```

## Output schema

```yaml
approval_packet:
  schema: runx.purchase.approval.v1
  request_id: string
  decision: approve_in_full | scope_down | deny
  reason: string
  approval_decision:
    decision: approve_in_full | scope_down | deny
    approver: policy-engine
    at: iso
  attenuation_request:           # present only on approve/scope_down
    amount: number
    currency: string
    counterparty: string         # vendor
    scopes: [string]
    expires_at: iso
  budget_after: number
```

## Inputs

- `policy_ref` (optional): registry-pinned ref to a procurement policy; omitted uses
  the declared default above.
- `budget_ref` (optional): registry-pinned ref to a budget balance; omitted uses a
  caller-supplied `budget` object (harness seeds it).
- `request` (required): `{ request_id, amount, currency, vendor, purpose, requested_scopes }`.

## Invocation

```bash
runx skill purchase-approval \
  -i policy_ref=tenant://acme/procurement \
  -i budget_ref=tenant://acme/budget-ops \
  -i request='{"request_id":"po-1","amount":1200,"currency":"USD","vendor":"v-endpoint","purpose":"api","requested_scopes":["software"]}' \
  --json
```

OSS dogfood seeds `policy` + `budget` via the harness fixture so the skill can prove
a decision without standing up hosted policy/budget infra.

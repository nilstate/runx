---
name: purchase-approval
description: Decide one purchase request against a typed procurement policy and the current budget balance, emitting a typed approval decision plus, only on approval, exactly one bounded AttenuationRequest ceiling as data before any spend is committed.
runx:
  category: business
---

# Purchase Approval

`purchase-approval` is a finance review skill. It reads one purchase request, the
active procurement policy, the remaining budget balance, and the requested
budget-bounded scope, then decides **approve-in-full**, **scope-down**, or
**deny** *before* any money moves. The dangerous part of a purchase is the
approval call, not the payment.

The output is a typed decision plus, only when approved, exactly one bounded
`runx.attenuation_request.v1` ceiling carried as **data**. The skill is a
judgment, not an executor: it never mints authority, never reserves, never
settles, never moves money, and never emits a `runx.operational_proposal.v1`.

It is the forward counterpart to `settle-invoice`, which settles an invoice
already approved against a grant, and is distinct from `expense-policy-check`,
which judges post-hoc reimbursement after money has already moved.
`budget-sentry` watches cumulative burn; this skill approves one purchase and
emits the bounded spend ceiling for it.

## What This Skill Does

1. Checks `purchase_request.vendor` against `procurement_policy.approved_vendors`.
2. Checks `purchase_request.amount` against `procurement_policy.max_single_purchase`.
3. Checks the amount against `current_budget_balance.amount` — remaining budget authority.
4. Checks `purchase_request.currency` against `current_budget_balance.currency`.
5. Checks the amount against `procurement_policy.requires_approval_above` to route
   the human approval lane.
6. Clamps any emitted ceiling inside `requested_scope` (the requested
   budget-bounded scope) and never above the requested amount.
7. Emits exactly one bounded ceiling as data on approval, and zero ceilings otherwise.

The graph review boundary is a single `agent-task` step (`review-purchase`). The
decision is sealed into a `runx.receipt.v1` review receipt. When the human
approval sub-step has no answer, the run blocks at `needs_agent` rather than
guessing.

## Inputs

```yaml
purchase_request:
  amount: number
  currency: string
  vendor: string
  purpose: string
procurement_policy:
  approved_vendors: [string]
  max_single_purchase: number
  requires_approval_above: number
current_budget_balance:
  amount: number
  currency: string
requested_scope:            # the requested budget-bounded scope
  scopes: [string]
  max_amount: {amount: number, currency: string}
  expires_at: string
```

`current_budget_balance` carries its own currency so that a currency mismatch
against `purchase_request.currency` escalates to the human lane instead of being
silently assumed. `procurement_policy` is a typed input; a durable `policy_ref`
with an expiry window arrives with the C6 policy-store family.

## Output

One `runx.purchase.approval.v1` packet:

```yaml
decision:
  approved: boolean
  mode: approve_in_full | scope_down | deny
  reason: string           # names the exact policy violation or budget overage
ceilings:                  # exactly one when approved; empty otherwise
  - schema: runx.attenuation_request.v1
    form: data
    amount: {amount: number, currency: string}
    currency: string
    counterparty: string   # the approved vendor
    scopes: [string]
    clamp: {parent_bound_ref, max_amount, result}
escalation:
  required: boolean
  lane: human_approval | null
  reason: string | null
observations: {...}
```

## Decision Table

| Condition | Decision | Ceiling |
|---|---|---|
| Vendor listed, amount at or below every cap, the balance, and the scope bound | `approved: true`, `approve_in_full` | Exactly one, at the requested amount |
| Vendor listed, in policy, but a clamp lowers the amount | `approved: true`, `scope_down` | Exactly one, at the clamped amount |
| Amount above `requires_approval_above`, otherwise in policy | Escalates, blocks | None |
| Vendor not in `approved_vendors` | `approved: false`, `deny` | None |
| Amount above `current_budget_balance.amount` | `approved: false`, `deny` | None |
| Amount above `max_single_purchase` | `approved: false`, `deny` | None |
| `purchase_request.currency` differs from `current_budget_balance.currency` | Escalates, blocks | None |
| Budget authority unclear | Escalates, blocks | None |

The judgment never invents an approved vendor, a single-purchase cap, or an
approval threshold that is absent from `procurement_policy`, and never assumes a
budget balance.

## Handoff Seam (C3)

The bounded ceiling **is** the handoff seam. A downstream driver hands the
emitted `runx.attenuation_request.v1` to the core spend/refund accepting runner
(C3), which alone mints, reserves, settles, and seals the attenuated subset —
capped at that ceiling. This skill emits the ceiling itself, never an attenuated
subset.

Because a denial or a blocked approval emits **no ceiling**, there is nothing for
C3 to consume and **the spend cannot fire**. Out-of-policy spend, a currency
mismatch, or unclear budget authority routes to a human approval lane that
**blocks rather than guesses**.

## Harness Cases

- `purchase-approval-in-policy-ceiling` — in-policy USD 75 to a listed vendor
  within a USD 1000 balance. Yields `decision.approved: true`, exactly one bounded
  ceiling, and a **sealed** review receipt.
- `purchase-approval-stop-over-budget-needs-agent` — USD 1500 against a USD 400
  balance (a USD 1100 overage) from a vendor outside `approved_vendors`. It
  intentionally omits `caller.answers`, so the human approval sub-step blocks to
  **`needs_agent`**, emits **no ceiling**, and the refusal names the budget overage
  and the unlisted vendor.

## Install, Run, Verify

```bash
runx add <owner>/purchase-approval@<version>
runx skill <owner>/purchase-approval@<version> --json \
  --input-json purchase_request="$(jq -c .purchase_request fixtures/in-policy-input.json)" \
  --input-json procurement_policy="$(jq -c .procurement_policy fixtures/in-policy-input.json)" \
  --input-json current_budget_balance="$(jq -c .current_budget_balance fixtures/in-policy-input.json)" \
  --input-json requested_scope="$(jq -c .requested_scope fixtures/in-policy-input.json)"
runx resume <run-id> fixtures/in-policy-answers.json --json
runx verify --receipt <receipt.json> --json
```

See `DELIVERY.md` for the exact start/resume dogfood commands and the fixtures in
`fixtures/`.

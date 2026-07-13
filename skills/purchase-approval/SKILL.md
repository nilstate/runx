---
name: purchase-approval
description: Judge a proposed purchase against an explicit procurement policy and remaining budget, then emit a bounded approval ceiling only after human review.
links:
  source: https://github.com/runxhq/runx/pull/307
runx:
  category: payments
---

# Purchase Approval

Use this skill before a purchase is committed. It decides whether a single
request is within an explicitly supplied procurement policy and current budget,
then asks a person to confirm the decision. It is a judgment skill, not a payment
executor: it never mints authority, reserves funds, settles a rail, or moves
money.

## Inputs

- `purchase_request`: `{ amount, currency, vendor, purpose }`.
- `procurement_policy`: `{ approved_vendors, max_single_purchase,
  requires_approval_above }`.
- `current_budget_balance`: remaining budget in the request currency.
- `requested_scope`: the caller's budget-bounded authority request containing
  `{ amount, currency, counterparty, scopes }`.

All policy fields are required. Missing vendors, limits, thresholds, currencies,
or budget authority are not inferred.

## Procedure

1. Validate that every typed input and policy field is present.
2. Require the request currency to match the requested scope. Do not convert
   currencies or guess an exchange rate.
3. Require the vendor to appear exactly in `approved_vendors`.
4. Compare the amount with `max_single_purchase`,
   `current_budget_balance`, and the requested scope amount.
5. Verify that the requested scope counterparty matches the vendor and that its
   scopes are limited to the stated purchase purpose.
6. Return `decision.approved: false` with a precise reason when any bound fails.
   A denied decision carries no `attenuation_request`.
7. When every bound passes, return `decision.approved: true` and one bounded
   `attenuation_request` containing the exact amount, currency, counterparty,
   and scopes. It must be no broader than `requested_scope`.
8. Send both approval and denial decisions to the human review gate. Until a
   person confirms the decision, the graph remains `needs_agent` and nothing is
   available to a downstream spend driver.

## Output

```yaml
decision:
  approved: boolean
  reason: string
attenuation_request:
  amount: number
  currency: string
  counterparty: string
  scopes: array
escalation:
  lane: human-approval
  reason: string
```

`attenuation_request` is present only for an approved decision. It is the
bounded ceiling a downstream C3 spend/refund accepting runner may consume. That
runner remains responsible for minting, reserving, settling, and sealing an
attenuated subset; this skill only emits data.

## Stop and escalation rules

- Reject vendors outside `approved_vendors`.
- Reject amounts above the remaining budget, the single-purchase cap, or the
  requested scope.
- Escalate currency mismatches and unclear budget authority instead of guessing.
- Never invent a vendor, cap, approval threshold, currency, scope, or budget.
- Never emit a ceiling for a denied or unconfirmed request.
- Never describe the output as `runx.operational_proposal.v1`; it is a bounded
  `AttenuationRequest` carried as data.

## Handoff seam

After human confirmation, a downstream driver may hand the approved bounded
ceiling to the core spend/refund accepting runner. That runner can attenuate the
ceiling further, but cannot widen it. If this skill denies the request or the
human gate remains unresolved, there is no ceiling to consume and spending
cannot fire.

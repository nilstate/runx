---
name: purchase-approval
description: Evaluate one bounded purchase request against explicit policy and emit a downstream ceiling only after policy and human approval pass.
runx:
  category: payments
---

# Purchase Approval

`purchase-approval` evaluates one proposed purchase without paying for it. It
checks a vendor allowlist, typed purchase limits, approval threshold, current
budget, currency, and a proposed downstream `AttenuationRequest`. The graph
then stops at the resumable `purchase-approval-review` human review task.

Only a request that passes deterministic policy and has a positive human
decision emits one bounded downstream `AttenuationRequest` as data. The output
is a proposal for a downstream payment runner to validate independently; it is
not a grant, payment, reservation, or settlement instruction.

The skill never mints authority, reserves funds, moves money, calls a payment
rail, or emits an operational proposal. A downstream payment runner must
independently validate authority, reservation, and settlement before any funds
can move.

## Decision Flow

1. **Evaluate policy.** The deterministic evaluator rejects missing data,
   currency mismatches, unapproved vendors, over-limit or over-budget requests,
   and malformed authority requests. It records the exact reason.
2. **Ask for approval.** The graph gives the policy review to the resumable
   `purchase-approval-review` task. With no decision, the run returns
   `needs_agent`; no ceiling is emitted.
3. **Emit or refuse.** Two graph guards require both `policy_review.allowed`
   and `approval_decision.approved`. The finalizer then emits exactly one
   bounded `AttenuationRequest`. A human cannot override a failed policy review.

## Inputs

- `purchase_request`: `{amount, currency, vendor, purpose}`. `amount` is a
  positive number in the stated policy unit.
- `procurement_policy`: `{approved_vendors, max_single_purchase,
  requires_approval_above}`. Both limits are typed money objects:
  `{amount, currency}`.
- `current_budget_balance`: `{amount, currency}` for available budget.
- `requested_budget_bounded_scope`: `{ceiling, counterparty, scopes,
  allow_scope_down, attenuation_request}`. `ceiling` is `{amount, currency}`
  and `attenuation_request` is the exact bounded downstream request.

`allow_scope_down` is explicit consent. When true, a request over a monetary
limit may emit the strictly lower minimum of the single-purchase limit and
current budget, but only after both gates pass. Without it, the request is
denied or escalated; the skill never silently reduces a requested purchase.

## Output

The evaluator emits a `policy_review_packet`:

```yaml
kind: purchase_approval_policy_review
allowed: boolean
decision_mode: approve_in_full | scope_down | deny
approval_reason: string
violations: [string]
ceiling:
  amount: number
  currency: string
```

The final step emits a `purchase_approval_packet`:

```yaml
kind: purchase_approval_result
decision:
  approved: boolean
  mode: approve_in_full | scope_down | deny
  reason: string
attenuation_request: object | null
ceiling:
  amount: number
  currency: string
  counterparty: string
  scopes: [string]
escalation: object | null
```

`ceiling` and `attenuation_request` are present only after both the deterministic
policy review and human review pass. They are bounded data for a downstream
runner, not a payment authorization.

## Stop Conditions

- Vendor absent from `approved_vendors`.
- Request exceeds the typed purchase cap or available budget without explicit
  scope-down consent.
- Currency mismatch across request, policy, budget, or proposed scope.
- Missing amount, purpose, scopes, or a complete `AttenuationRequest`.
- Scope counterparty, ceiling, or effect limits differ from the approved result.
- Human review withheld or unavailable.

Every stop condition returns no ceiling. A pending human review returns
`needs_agent`; a declined or failed policy review is sealed without authority
output.

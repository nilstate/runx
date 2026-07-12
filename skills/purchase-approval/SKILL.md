---
name: purchase-approval
description: Decide whether a proposed purchase is allowed under a procurement policy, refusing budget overages and unapproved vendors instead of guessing.
runx:
  category: operations
---

# Purchase Approval

This skill makes a bounded procurement decision from explicit input. It approves only when the requested vendor, amount, currency, and budget authority are present in the supplied `procurement_policy`.

## What it does

1. Reads `purchase_request.vendor`, `amount`, `currency`, and `purpose`.
2. Reads `procurement_policy.approved_vendors`, `remaining_budget`, `single_purchase_cap`, and `currency`.
3. Emits a `purchase_approval` packet with a decision, reason, ceiling amount, policy references, and any human lane required.
4. Refuses out-of-policy purchases instead of inventing missing vendors, thresholds, or budget authority.

## Approval rules

- Approve only if the vendor is in `approved_vendors`.
- Approve only if request currency matches the policy currency.
- Approve only if amount is less than or equal to both `remaining_budget` and `single_purchase_cap`.
- If the amount reaches or exceeds an approval threshold that requires human review, return `needs_human` with the named lane.
- If any required policy field is missing, refuse with `missing_policy_authority`.

## Output shape

```yaml
purchase_approval:
  decision: approved | refused | needs_human
  reason: string
  ceiling_amount: number
  currency: string
  vendor: string
  human_lane: string | null
  refused_reason: string | null
  policy_refs: [string]
```

## Harness cases

- `approved-vendor-under-budget`: sourcey purchase under the available cap is approved.
- `refused-vendor-over-budget`: unknown vendor and over-budget request is refused and routed to a human review lane.

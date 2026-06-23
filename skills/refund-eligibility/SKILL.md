---
name: refund-eligibility
version: 0.1.0
description: Decide whether a refund request is in policy from a sealed charge receipt, a refund request, and a refund policy, emitting only a bounded refund proposal.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/zdfgu113/runx/tree/codex/refund-eligibility/skills/refund-eligibility
runx:
  category: payments
  input_resolution:
    required:
      - charge_receipt
      - refund_request
      - policy
---

# Refund Eligibility

Decide whether a requested refund is allowed by a sealed charge receipt and a
simple policy. The skill reads a charge receipt summary, a refund request, and a
policy, then emits a bounded `refund_proposal` only when the request is clearly
eligible. It never performs the reversal, calls a payment rail, signs a money
movement, or mutates external state.

## When to use this skill

Use it before invoking a refund execution skill when support or finance needs a
checkable decision packet. The packet explains the eligibility verdict, the
remaining refundable amount, the idempotency key that a refund catalog skill can
consume, and the exact reason when the request is refused.

## When not to use this skill

Do not use it to move money, repair a receipt, override a policy, or invent a
charge. If the receipt is unsealed, ambiguous, missing currency or amount, or
outside the supported policy shape, the skill escalates instead of guessing.

## Procedure

1. Require `charge_receipt`, `refund_request`, and `policy`.
2. Accept only charge receipts that expose `schema: runx.receipt.v1` and
   `state: sealed`.
3. Extract a charge reference from `id`, `receipt_ref`, or `charge_ref`.
4. Extract the original amount, already refunded amount, currency, and charge
   timestamp from explicit fields.
5. Require `refund_request.amount` to be positive and in the same units as the
   charge.
6. Compute the policy cap as `amount * policy.max_pct / 100`, then subtract any
   already refunded amount.
7. Require the request to be inside `policy.window_days`, measured from the
   charge timestamp to `refund_request.requested_at`, `policy.now`, or the
   current time.
8. Return `decision.eligible: true` plus `refund_proposal` only when every gate
   passes.
9. Return `decision.eligible: false` plus `escalation` and no proposal when a
   gate fails or the evidence is ambiguous.

## Output

The runner emits `runx.refund_eligibility.v1` with:

- `summary`: short human-readable decision summary.
- `decision`: `{ eligible, reason }`.
- `refund_proposal`: `{ amount, currency, charge_ref, idempotency_key, effect }`
  only when eligible.
- `refundable`: original amount, already refunded amount, policy cap, and
  remaining refundable amount.
- `escalation`: human review lane and evidence gaps when not eligible or
  ambiguous.

## Example

```bash
runx skill ./skills/refund-eligibility \
  --input-json charge_receipt='{"schema":"runx.receipt.v1","id":"runx:receipt:charge-demo","state":"sealed","amount":10000,"currency":"USD","charged_at":"2026-06-01T00:00:00Z","refunded_amount":1000}' \
  --input-json refund_request='{"amount":2500,"reason":"duplicate charge","requested_at":"2026-06-10T00:00:00Z"}' \
  --input-json policy='{"max_pct":50,"window_days":30}' \
  --json
```

## Inputs

- `charge_receipt` (required): sealed `runx.receipt.v1` charge receipt or
  receipt summary with amount, currency, and charge time.
- `refund_request` (required): object with `amount`, `reason`, and optional
  `requested_at`.
- `policy` (required): object with `max_pct`, `window_days`, and optional `now`.

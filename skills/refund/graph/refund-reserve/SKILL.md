---
name: refund-reserve
description: Reserve a profile-level refund decision against a linked charge receipt.
runx:
  category: payments
---

# Refund Reserve

Select or decline a refund intent after a refund quote.

This skill produces a Decision-shaped reservation packet with linked receipt
id, refundable bounds, idempotency key, approval state, and a child payment
authority term using the existing `refund` verb. It does not call a rail or
repair receipt state.

Carry the original receipt link, settlement family, amount, currency, and
idempotency key unchanged from the quote. The child authority may be no broader
than the linked charge and refundable bounds. Return `policy_denied`—without a
reservation—when the bounds, family, dispute state, required approval, parent
authority, or idempotency evidence is missing.

## Output

- `payment_decision`: selected, declined, blocked, or approval-required refund.
- `reserved_payment_authority`: the narrowed child refund authority.
- `reservation`: original receipt, family, amount, and currency binding.
- `idempotency`: stable refund key and recovery lookup fields.
- `approval`: required and observed approval state.
- `open_questions`: unresolved blockers.

## Inputs

- `refund_quote_packet` (required): output from `refund-quote`.
- `parent_payment_authority` (required): parent payment authority term or ref.
- `approval_context` (optional): prior approval evidence.
- `idempotency_seed` (optional): stable seed for refund idempotency.

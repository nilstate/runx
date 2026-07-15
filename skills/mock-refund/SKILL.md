---
name: mock-refund
description: Model a same-family mock refund against a sealed charge receipt.
runx:
  category: payments
---

# Mock Refund

Compose refund quote, refund reserve, optional approval, and deterministic mock
refund settlement against a linked sealed charge receipt.

This graph profile is for local harnesses, demos, and contract tests. It does
not perform a live rail mutation or claim runtime refund enforcement.

Every stage must preserve the original receipt reference, mock settlement
family, amount, currency, and idempotency key. Stop before deterministic
settlement when the original receipt link, reservation, required approval, or
idempotency evidence is missing; never use the fixture to imply cross-family
refund authority.

## Output

- `refund_quote_packet`: refundable bounds tied to the original receipt.
- `refund_reservation_packet`: the narrowed refund decision and authority.
- `refund_approval`: approval evidence when policy requires it.
- `refund_rail_packet`: deterministic mock settlement evidence.

## Inputs

- `original_receipt_ref` (required): linked sealed charge receipt reference.
- `original_receipt` (required): redacted original charge receipt summary.
- `refund_request` (required): requested amount and reason.
- `parent_payment_authority` (required): parent payment authority term or ref.
- `approval_context` (optional): prior approval evidence.
- `idempotency_seed` (optional): stable refund idempotency seed.

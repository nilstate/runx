---
name: mpp-refund
description: Model a same-family MPP refund against a sealed charge receipt.
runx:
  category: payments
---

# MPP Refund

Compose refund quote, refund reserve, optional approval, and MPP-family refund
settlement against a linked sealed charge receipt.

This graph profile records registry and harness shape only. It does not call a
live MPP rail, read rail credentials, or claim runtime refund enforcement.

Every stage must preserve the original receipt reference, MPP settlement
family, amount, currency, and idempotency key. Credential material remains
behind references. Stop before modeled settlement when the original receipt
link, reservation, required approval, or idempotency evidence is missing.

## Output

- `refund_quote_packet`: refundable bounds tied to the original receipt.
- `refund_reservation_packet`: the narrowed refund decision and authority.
- `refund_approval`: approval evidence when policy requires it.
- `refund_rail_packet`: modeled MPP-family settlement evidence.

## Inputs

- `original_receipt_ref` (required): linked sealed charge receipt reference.
- `original_receipt` (required): redacted original charge receipt summary.
- `refund_request` (required): requested amount and reason.
- `parent_payment_authority` (required): parent payment authority term or ref.
- `approval_context` (optional): prior approval evidence.
- `idempotency_seed` (optional): stable refund idempotency seed.

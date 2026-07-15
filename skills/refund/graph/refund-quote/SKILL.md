---
name: refund-quote
description: Quote refundable bounds from a linked sealed charge receipt.
runx:
  category: payments
---

# Refund Quote

Inspect a sealed charge receipt and compute profile-level refundable bounds.

This skill is non-mutating. It links the refund request to exactly one
original charge receipt, reports remaining amount, settlement family, refund
window, and prior refund references, and leaves authorization to reservation
and future runtime enforcement.

Trace the refundable amount and family to the linked charge receipt and every
known prior refund receipt. Never infer permission to cross settlement
families. If the original receipt, family, requested amount, or prior-refund set
is ambiguous, return `needs_agent` with open questions and reserve nothing.

## Output

- `refund_quote`: normalized requested and eligible refund amounts.
- `refundable_bounds`: remaining amount, window, and policy limits.
- `original_receipt_link`: the sealed charge receipt and supporting refs.
- `settlement_family`: the only family eligible for downstream settlement.
- `open_questions`: ambiguity that blocks reservation.

## Inputs

- `original_receipt_ref` (required): linked sealed charge receipt reference.
- `original_receipt` (optional): redacted receipt summary.
- `refund_request` (optional): requested amount, reason, and operator note.
- `prior_refund_receipt_refs` (optional): prior refund receipts.
- `policy` (optional): provider refund window and limit policy.

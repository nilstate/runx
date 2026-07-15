---
name: pay-reserve
description: Select a payment decision and reserve attenuated runx payment authority.
runx:
  category: payments
---

# Pay Reserve

Turn a quote packet into a reservation decision.

This skill presents the human-readable decision record around a payment: what
will be paid, why, under which cap, with which idempotency key, and which child
authority term may reach a rail skill. It does not call a payment rail and does
not store payment truth outside the harness.

Core remains the authority. The reservation is valid only when runx proves that
the child payment term is a subset of the parent grant and records the selected
Decision. This skill names that decision surface and prepares the packet that
the runtime can enforce.

Carry the quote id, source references, parent authority reference, amount cap,
and approval state into the reservation. Reserve exactly the quoted amount or a
narrower cap; never broaden the counterparty, rail, realm, operation, period, or
currency. Return `needs_agent` without a child term when the quote evidence,
parent authority, required approval, or stable idempotency key is missing.

## Output

- `payment_decision`: selected/deferred/declined payment decision summary.
- `reserved_payment_authority`: child `payment` authority term for the rail
  harness.
- `spend_capability_ref`: scoped single-use spend capability reference when
  the selected child term includes `spend`.
- `idempotency`: reservation key and recovery lookup fields.
- `approval`: approval status and threshold explanation.
- `core_requirements`: enforcement requirements core must verify.
- `open_questions`: unresolved blockers.

## Inputs

- `payment_quote_packet` (required): output from `pay-quote`.
- `parent_payment_authority` (required): parent authority term or reference.
- `spend_policy` (optional): caller policy limits and approval thresholds.
- `approval_context` (optional): operator, system, or prior approval evidence.
- `idempotency_seed` (optional): stable seed if not already in the quote.

---
name: mock-pay
description: Run the deterministic mock payment graph from quote to sealed proof.
runx:
  category: payments
---

# Mock Pay

Run the deterministic local payment graph.

The graph turns a payment-required signal into a quote, selects and reserves a
payment decision, routes approval when required, fulfills the mock rail under
attenuated authority, and leaves recovery evidence if the rail result is
ambiguous.

This is the settlement-pinned mock marquee. It exists for local harnesses,
demos, and contract tests. It does not claim live provider behavior or accept
raw funding material.

Treat the result as an operator-grade execution record, not as proof of a live
wallet or provider. A successful case still has to bind the quote, selected
decision, attenuated child authority, stable idempotency key, deterministic
rail proof, and receipt-seal requirement. Stop before mock fulfillment when the
quote, required approval, parent authority, reservation, idempotency material,
or spend capability is missing; route ambiguous results through recovery under
the same key.

## Output

- `payment_execution`: overall status and receipt/proof refs.
- `payment_quote_packet`: normalized quote output.
- `payment_reservation_packet`: selected reservation decision and child
  authority term.
- `effect_evidence_packet`: rail proof and credential envelope.
- `recovery_packet`: recovery assessment when a rail result is ambiguous.

## Inputs

- `payment_signal` (required): payment-required signal or challenge.
- `parent_payment_authority` (required): parent payment authority term or ref.
- `rail_profile_ref` (required): configured rail profile reference.
- `realm` (optional): authority realm.
- `spend_policy` (optional): policy limits and approval thresholds.
- `approval_context` (optional): prior approval evidence.
- `idempotency_seed` (optional): stable idempotency material.

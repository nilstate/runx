---
name: mpp-pay
description: Run the MPP payment graph from quote to sealed settlement proof.
runx:
  category: payments
---

# MPP Pay

Run the multi-party payment settlement graph.

The graph turns a payment-required signal into a quote, selects and reserves a
payment decision, routes approval when required, fulfills the MPP rail under
attenuated authority, and leaves recovery evidence if the rail result is
ambiguous.

This is the settlement-pinned MPP marquee. It keeps provider adaptation below
the authority gate and returns only proof refs or redacted proof payloads for
receipt sealing.

Use it from an agent host or operator workflow that needs the whole governed
payment path, including the approval and receipt evidence a reviewer can inspect.
It is an execution record, not wallet copy: report what was quoted, selected,
reserved, fulfilled, recovered, or blocked without turning the rail into the
authority model.

Successful execution must bind the normalized quote, selected decision,
attenuated child authority, stable idempotency key, MPP proof reference, and
receipt-seal requirement. The rail remains replaceable; those governance facts
do not. Stop before touching the rail when the quote, required approval, parent
authority, reservation, idempotency material, or spend capability is missing.
An ambiguous rail result goes to recovery under the same idempotency key; it is
never reported as success.

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

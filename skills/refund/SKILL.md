---
name: refund
description: Prepare a sealed-receipt-linked refund handoff under bounded authority without claiming money moved.
runx:
  category: payments
---

# Refund

Prepare one refund against a real, sealed provider charge without losing the
lineage that makes a reversal auditable. A refund is not a negative spend and it
is not justified by an order id alone: the plan must link the original money
movement, provider proof, prior refunds, selected rail, payer, amount, and
single-use refund authority.

The current public skill plans only. It does not approve, reserve, execute, or
recover a provider refund and always reports `money_moved: false`. A matching
provider adapter must perform the reversal and return stable readback before a
receipt can say the refund settled.

## When to use it

Use `refund` after a charge or payment receipt has sealed provider evidence and
the caller has a bounded refund `AuthorityTerm`. Use `dispute-respond` for a
provider dispute packet and `spend` for a new outbound payment. Do not use a
refund to compensate for missing original settlement proof.

## How it works

1. Resolve the opaque original receipt reference through Runx's configured,
   proof-verifying receipt store.
2. Verify the original amount, currency, payer, rail, provider proof refs, and
   money-movement status.
3. Discover and verify every receipt linked to that charge, then account for
   prior refunds so the request cannot exceed the remaining refundable ceiling.
4. Validate a complete typed, single-use refund authority for the same payer,
   currency, rail, realm, and operation.
5. Produce the exact adapter handoff and idempotency binding for the selected
   `mock`, `mpp`, or `stripe` path.

References and redacted evidence are deliberately separate: the reference
finds the receipt, while the verified receipt content proves what may be
reversed. Caller-authored booleans such as `verified: true` have no authority.

## Inputs and result

The caller supplies only the opaque original receipt ref, requested amount and
reason, selected rail, requested counterparty, and full parent refund
authority. Runx resolves the original receipt and refund history itself and
derives idempotency from those verified receipts plus the exact authority and
request. Caller-supplied receipt bodies, refunded totals, sealing flags, and
idempotency seeds are not accepted.

The result is a provider-refund plan and exact adapter handoff with original
receipt binding, remaining ceiling, authority validation, redactions, and
`provider_status: not_called`. It is not a settled-refund receipt.

## Stop conditions

- Refuse an unsealed, reference-only, proofless, wrong-payer, wrong-rail, or
  wrong-currency original charge.
- Refuse a refund above the original amount or remaining amount after prior
  reversals.
- Refuse incomplete, expired, wildcard, reference-only, or reusable authority.
- Stop on amount, payer, counterparty, rail, operation, or idempotency drift.
- Do not expose raw provider credentials or claim money moved without provider
  execution and readback.

## Example

A sealed Stripe charge proves `5000 AUD` moved and prior refund evidence shows
`1000 AUD` already reversed. A bounded authority permits one additional refund
to the original payer. The skill may prepare a `2000 AUD` Stripe handoff; it
must block `4500 AUD`, a different payer, or a receipt with no settlement proof.
The successful plan still says no money moved until the Stripe adapter proves
the reversal.

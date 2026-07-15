---
name: pay-quote
description: Normalize a paid-tool challenge into a quote and requested runx payment authority.
runx:
  category: payments
---

# Pay Quote

Turn a payment-required signal into a decision-ready quote packet.

This skill is the read side of agent payments. It normalizes the challenge,
identifies the requested rail, amount, counterparty, realm, operation, and
idempotency seed, then proposes the narrowest payment authority bounds that
could satisfy the request.

It does not authorize spend, reserve budget, call a rail, or receive funding
credentials. Its output is evidence for a later Decision, not a payment.

Source every amount, currency, counterparty, operation, rail, and expiry from
the challenge or explicit operator intent; label any permitted inference. Ask
for the narrowest authority that can work. Return `needs_agent` when a required
payment fact or stable idempotency seed is missing rather than widening the
rail, realm, counterparty, cap, or operation for convenience.

## Output

- `payment_quote`: normalized quote with amount in minor units, currency, rail
  candidates, counterparty, operation, quote expiry, and source refs.
- `requested_payment_authority`: requested `payment` authority bounds for the
  later reservation decision.
- `challenge_evidence`: source refs and redacted challenge details.
- `risk_notes`: policy, fraud, replay, or ambiguity notes.
- `open_questions`: missing data that blocks reservation.

## Inputs

- `payment_signal` (required): payment-required signal, MCP challenge, invoice,
  checkout request, or operator intent.
- `realm` (optional): authority realm such as `local`, `test`, or `prod`.
- `rail_preferences` (optional): ordered rail preference list.
- `max_per_call_units` (optional): caller cap in minor currency units.
- `currency` (optional): caller-expected ISO 4217 currency.
- `operation` (optional): stable operation name for the paid action.
- `counterparty` (optional): expected merchant or payee reference.
- `idempotency_seed` (optional): stable caller-provided idempotency material.

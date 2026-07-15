---
name: charge-challenge
description: Emit a provider-side payment-required challenge from a priced tool call.
runx:
  category: payments
---

# Charge Challenge

Turn a priced provider-side operation into a typed `effect_required` signal.

This skill formats the challenge that a caller must satisfy before a paid tool
operation can proceed. It carries the priced bounds, idempotency key, accepted
settlement families, and provider hints. It does not price the operation,
verify returned credentials, collect funds, or forward the upstream tool call.

Amounts, currencies, authority bounds, and accepted families must agree with
the supplied price packet and provider policy. Return `needs_agent` instead of
emitting a challenge when priced authority, a stable idempotency key, or the
accepted settlement-family set is missing. Credential verification must never
start from an incomplete or widened challenge.

## Output

- `effect_required_signal`: typed challenge signal for the caller.
- `charge_challenge`: provider charge challenge details.
- `idempotency`: challenge key and replay policy.
- `accepted_settlement_families`: settlement families the provider will verify.
- `open_questions`: missing data that blocks safe challenge emission.

## Inputs

- `charge_price_packet` (required): output from `charge-price`.
- `provider_policy` (optional): challenge formatting hints.
- `idempotency_seed` (optional): stable seed if the price packet lacks one.

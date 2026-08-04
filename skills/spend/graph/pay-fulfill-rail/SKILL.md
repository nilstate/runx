---
name: pay-fulfill-rail
description: Fulfill a reserved payment challenge through one rail under attenuated runx authority.
runx:
  category: payments
---

# Pay Fulfill Rail

Execute one rail operation below the runx spend gate.

This skill adapts a protocol or provider challenge to the credential/proof
shape needed by the paid tool. It can spend only when the parent harness has
already selected a Decision, reserved budget by idempotency key, and passed an
attenuated `payment` authority term into the child harness.

The skill must receive a scoped spend capability or provider session reference,
never raw funding material. It returns rail proof for the receipt; it
does not decide policy, approval, retry, or success.

Bind the provider response, challenge id, idempotency key, amount, currency,
counterparty, and proof hash or reference into the rail evidence while
redacting sensitive fields. Report only operational states—fulfilled, declined,
retryable, recovered, or ambiguous. Return `needs_agent` or `ambiguous` when the
response cannot be tied to both the reserved authority and idempotency key.

There is intentionally no x402 fulfillment runner here. The public `x402-pay`
facade is plan-only until a trusted buyer adapter implements the standard paid
resource retry and returns independent settlement readback. Do not substitute
agent-authored evidence or caller-supplied signer/facilitator endpoints.

## Output

- `rail_result`: rail status, amount, currency, counterparty, and operation.
- `rail_proof`: redacted proof payload or proof ref for the child harness
  receipt.
- `credential_envelope`: credential or token returned to the paid tool, with
  sensitive fields redacted or referenced.
- `redactions`: fields withheld from receipts and logs.
- `recovery_hint`: idempotency/retry guidance for `pay-recover`.

## Inputs

- `payment_challenge` (required): protocol/provider challenge to fulfill.
- `reserved_payment_authority` (required): child payment authority term.
- `spend_capability_ref` (required): scoped single-use spend capability ref.
- `rail_profile_ref` (required): configured rail profile reference.
- `payment_admission` (optional): hosted payment admission token and settlement
  identity. When present, it is bound into supervisor settlement evidence.
- `idempotency` (required): reservation key and recovery fields.
- `quote_packet` (optional): source quote packet for evidence continuity.

## Agent task contracts

### `pay-fulfill-rail-mock`

Produce deterministic mock rail evidence only for an explicitly configured test
profile. Bind the challenge, reserved authority, capability reference, rail
profile, and idempotency key. Return `rail_result`, `rail_proof`, a redacted
`credential_envelope`, `redactions`, and `recovery_hint`. Never claim a live
provider call or real money movement, and never accept raw funding material.

### `pay-fulfill-rail-mpp`

Interpret only bounded MPP provider evidence supplied through the authorized
rail context. The same five outputs must bind amount, currency, counterparty,
operation, admission/capability, and idempotency. Report `fulfilled` only when
terminal provider evidence matches the reservation; otherwise return declined,
retryable, recovered, ambiguous, or `needs_agent`. Never expose credentials or
turn acknowledgement alone into settlement finality.

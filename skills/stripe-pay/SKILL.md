---
name: stripe-pay
description: Execute a governed stripe-spt payment by delegating to the canonical spend authority and finality lane.
runx:
  category: payments
---

# Stripe Pay

This is the discoverable stripe-spt facade over `spend`. It selects the
`stripe-spt` runner and forwards the original bounded inputs. It does not
define another quote, reservation, approval, effect, recovery, or receipt model.

Use this name when the operator has already selected Stripe Shared Payment
Tokens as the rail and wants the canonical spend workflow without also choosing
a runner. Use `spend` directly when rail selection is still part of the job, or
when one workflow must compare several rails. Do not use this facade to create
Stripe customers, collect card details, manage subscriptions, or process an
unbounded charge.

## Composes

<!-- Generated from the native execution closure; run pnpm core-skills:composes:generate. -->

- `spend#stripe-spt`

## Contract

The caller supplies a structured payment signal, a complete typed parent
payment `AuthorityTerm`, a configured rail profile, and a stable idempotency
seed. A reference alone is not authority. The payment signal and parent term
must agree on amount ceiling, currency, rail, realm, counterparty, and operation.

`payment_admission` is optional at this facade and is passed unchanged
to the canonical rail boundary when present. Local execution is limited to explicit test profiles. Live Stripe credential custody and bounded provider admission remain outside the skill input; raw API keys, webhook secrets, PANs, and unrestricted tokens are refused.

## Execution

1. Delegate to `spend:stripe-spt`.
2. Let native `payment.quote` derive the exact requested authority from the
   real parent term.
3. Let native `payment.reserve` mint and prove one digest-bound child
   capability for `act_fulfill`.
4. Stop at the canonical approval gate until the decision is approved.
5. Execute the stripe-spt provider path under the payment effect boundary.
6. Seal provider evidence and recovery state before reporting success.

The facade never chooses another rail, retries under a new key, accepts raw
funding credentials, or treats HTTP/provider acceptance as final settlement.
Missing authority, profile, admission identity when required, approval, subset
proof, supervisor evidence, or terminal rail proof stops before success.

### Recovery

Retry with the same `idempotency_seed` and unchanged payment signal. The
canonical spend lane uses the reservation and provider evidence to distinguish
an unattempted payment from an acknowledged or fulfilled one; never invent a
new seed merely because the caller timed out. If provider finality cannot be
read back, the result remains recoverable or indeterminate rather than
`fulfilled`.

An explicit `:test` rail profile exercises deterministic local Stripe-SPT
semantics without claiming a live Stripe charge. A live profile must cross the
configured provider boundary and return stable provider evidence before this
skill can report provider finality.

## Inputs

- `payment_signal` (required): stripe-spt challenge with positive minor-unit
  amount, currency, counterparty, and operation.
- `parent_payment_authority` (required): complete bounded payment AuthorityTerm.
- `rail_profile_ref` (required): configured stripe-spt profile reference.
- `idempotency_seed` (required): stable caller-owned reservation seed.
- `payment_admission`: bounded hosted admission and settlement identity.
- `realm`: optional narrowing that must match the signal and parent term.

The result is the canonical `spend` receipt chain, including quote,
reservation, approval, rail evidence, and payment-effect finality proof.

## Example

A paid search endpoint returns a USD 1.25 Stripe-SPT challenge. The caller
provides a parent authority term capped at USD 1.25 for that merchant and
operation, plus `idempotency_seed: search-request-4821`. This facade delegates
the exact signal to `spend:stripe-spt`, pauses at the spend approval, and only
returns fulfilled after the rail evidence matches the admitted amount,
currency, counterparty, and movement id.

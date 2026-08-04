---
name: spend
description: Execute one governed outbound payment through deterministic quote, authority reservation, approval, rail fulfillment, and provider evidence.
runx:
  category: payments
---

# Spend

`spend` is the canonical buyer-side payment operation. Its `plan` runner turns
one structured payment-required signal into a bounded quote. Executable runners
then turn that quote into one approved rail effect and will not report success
until provider evidence is sealed. All executable rails share the same
authority, idempotency, approval, recovery, and finality story.

Use this skill when a caller has a real parent payment authority and needs to
pay a known counterparty for a known operation. Do not call a rail directly
because credentials happen to be available. Use `charge` for seller-side paid
calls, `refund` for a receipt-linked reversal, and `settle-invoice` when an
invoice must first be validated into an exact spend handoff.

## The payment model

A payment signal is intent, not authority. The caller must supply a complete
typed parent `AuthorityTerm` with currency, per-call and aggregate ceilings,
allowed rails, realm, counterparty, operation, period, and single-use capability
authority. A grant id or prose claim that permission exists is refused.

Native `payment.quote` validates the signal against that parent term and derives
the exact requested child authority. Native `payment.reserve` re-mints and
proves the child as a subset, binds it to `act_fulfill`, holds budget, and
derives stable capability and idempotency material. Neither step moves money or
constitutes approval.

## Planning and execution

1. Validate and quote the positive minor-unit amount, currency, rail,
   counterparty, operation, realm, and challenge binding.
2. For `plan`, stop here with `runx.payment.quote.v1`; no budget is reserved and
   no approval or rail call occurs.
3. For an executable runner, reserve one digest-bound child authority beneath
   the real parent term.
4. Pause at the explicit spend approval gate. Missing or denied approval
   prevents the rail step.
5. Execute exactly one configured rail through `pay-fulfill-rail`.
6. Require rail-specific effect evidence and seal the payment receipt before
   reporting success.
7. If the outcome is ambiguous, recover under the same reservation and
   idempotency binding. Never retry with a new key and risk a double charge.

## Runtime paths

- `mock` is a deterministic local and test rail.
- `mpp` executes through a configured MPP provider path.
- `stripe-spt` uses a Stripe Shared Payment Token path. Live credential custody
  stays outside skill inputs.
- `plan` performs authority-bound quoting without a rail effect.

`stripe-pay` is a discoverable facade over its executable runner. `x402-pay`
uses `spend:plan` until a trusted x402 buyer adapter exists; it does not
misrepresent quote evidence as settlement. Neither facade introduces a second
authority model.

## Inputs and result

- `payment_signal` carries positive `amount_minor`, uppercase currency, rail,
  counterparty, operation, and optional challenge and realm.
- `parent_payment_authority` is the complete bounded payment term.
- `rail_profile_ref` identifies configured rail policy without exposing its
  secret material.
- `idempotency_seed` is stable caller-owned material used across quote,
  reservation, capability, and provider execution.
- Hosted paths may require an opaque `payment_admission`. Provider endpoints,
  wallet material, and bearer secrets are never public skill inputs.

The result is the sealed receipt chain containing quote, subset reservation,
approval, effect evidence, provider proof, redactions, and recovery state. HTTP
acceptance alone is not finality; the selected rail must provide its required
terminal evidence.

## Stop conditions

- Refuse malformed, reference-only, expired, wildcard, wrong-currency,
  wrong-counterparty, wrong-operation, wrong-rail, or over-ceiling authority.
- Refuse raw card data, API keys, wallet keys, seed phrases, webhook secrets, or
  bearer tokens on the public input surface.
- Stop on quote drift, target-binding drift, failed subset proof, missing
  admission identity, or absent approval.
- Do not switch rails opportunistically or silently widen the parent term.
- Do not label an ambiguous provider response successful. Enter recovery under
  the same idempotency key.

## Example

An x402 endpoint requests `125` minor units of `USD` for `search.paid` from a
known merchant. The parent term permits that exact counterparty, operation,
currency, rail, and ceiling. `spend:plan` emits the bounded quote and stops;
there is no x402 execution adapter to reserve or move funds. An executable rail
continues only through its declared adapter, approval, and terminal readback.

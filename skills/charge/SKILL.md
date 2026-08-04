---
name: charge
description: Prepare a provider-side paid-call challenge and exact credential-verification handoff; forwarding requires a real settlement adapter.
runx:
  category: payments
---

# Charge

`charge` is the canonical seller-side planner for a paid tool call. It binds one
requested operation to provider pricing policy, emits a replay-safe payment
challenge, validates an opaque returned credential reference against that exact
challenge, and prepares the verifier and forwarding handoff.

The current public skill stops before provider settlement. It does not verify a
rail credential itself, seal provider settlement evidence, or forward the paid
operation. Its truthful result is `provider_status: not_called`,
`receipt_status: not_sealed`, and `forwarding_status: not_forwarded`. A real
settlement-family adapter must complete those actions before the service can be
released.

## When to use it

Use `charge` when Runx is acting as the provider of a paid operation and needs a
deterministic price/challenge/verifier plan. Use `spend` on the buyer side and
`refund` to reverse a previously sealed provider charge. Do not use this skill
as evidence that a caller paid merely because it returned a credential ref.

## How it works

1. `charge-price` validates the structured tool call and provider policy, then
   binds amount, currency, counterparty, operation, accepted settlement family,
   expiry, and requested authority.
2. `charge-challenge` turns that price into a deterministic, replay-safe
   challenge whose idempotency binding requires receipt-before-forward.
3. `charge-verify` validates the *reference and handoff shape* for the returned
   credential and a single-use verifier capability. It does not manufacture a
   successful provider verification.
4. Native `payment.charge_plan` assembles the exact price, challenge, and
   verifier request into the adapter handoff.
5. A future or configured provider rail must verify settlement, seal evidence,
   and authorize forwarding under the same bindings.

The public runners select `mock`, `mpp`, or `stripe` policy families. There is
no seller-side x402 runner here; buyer-side x402 support in `spend` does not
implicitly create a provider charge contract.

## Inputs and result

- `mcp_tool_call` identifies the exact paid operation and bounded arguments.
- `provider_policy` supplies the price and accepted family; there is no default
  price.
- `returned_credential` names the settlement family and one opaque reference,
  never raw rail material.
- `verify_capability_ref` is the bounded single-use verification capability.
- `idempotency_seed` stabilizes the challenge and replay decision.

The plan contains price, requested authority, challenge, idempotency packet,
credential binding, and exact provider-verifier handoff. It explicitly records
that settlement, receipt sealing, and forwarding remain outstanding.

## Stop conditions

- Stop when provider policy, price, operation, counterparty, family, or stable
  idempotency material is missing or ambiguous.
- Refuse family, amount, currency, challenge, or counterparty drift.
- Refuse raw credentials, unrestricted verifier tokens, or caller-authored
  “verified” flags.
- Treat replay as unresolved unless the same sealed provider result can be
  proven under the same idempotency binding.
- Never forward the paid call or report settlement from a local plan.

## Example

A provider prices `search.paid` at `125 USD` minor units and accepts Stripe. The
skill can produce the exact Stripe challenge and verifier request bound to that
operation. If the caller returns an MPP reference or a different amount, the
plan stops. Even a matching Stripe reference remains unpaid until the Stripe
adapter verifies it, seals evidence, and releases the call.

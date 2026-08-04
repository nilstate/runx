---
name: x402-pay
description: Validate an x402 payment challenge against bounded Runx payment authority and prepare the canonical spend quote without pretending a wallet adapter or settlement exists.
runx:
  category: payments
---

# X402 Pay

`x402-pay` is the discoverable x402 planning facade over the canonical `spend`
authority model. It answers a narrow but important question: does this exact
payment challenge fit the authority the operator actually granted?

It does not currently move money. That is deliberate. Runx does not yet bundle
a trusted x402 buyer adapter, so the skill will not ask an agent to improvise
wallet signing, accept a signer or facilitator URL in public input, or label a
synthetic transaction as settlement.

## Composes

<!-- Generated from the native execution closure; run pnpm core-skills:composes:generate. -->

- `spend#plan`

## When to use it

Use this skill after a paid resource has returned structured x402 payment
requirements and before any wallet receives a signing request. It is useful for
preflight, policy review, adapter integration, and diagnosing why an x402
challenge falls outside a grant.

Use `spend` when choosing among supported executable rails. Do not use this
facade when you need a live x402 payment today: until a trusted rail adapter is
installed and wired into `spend`, the correct result is a bounded quote plus an
explicit adapter requirement, not a supposed payment receipt.

## What happens

1. The facade delegates to `spend:plan`; it does not define a second payment
   policy or authority model.
2. Native `payment.quote` validates the amount, currency, `x402` rail, realm,
   counterparty, operation, limits, and idempotency seed against the complete
   parent `AuthorityTerm`.
3. Runx emits the canonical `runx.payment.quote.v1` packet. It does not reserve
   funds, request approval, call a wallet, retry the paid resource, or claim
   provider finality.

A grant id or prose assertion is not authority. The parent term must contain
the actual bounded effect limits and must authorize the same counterparty,
operation, currency, realm, and x402 channel as the challenge.

## The adapter boundary

An eventual execution adapter must implement the standard buyer flow: consume
the server's payment requirements, ask a trusted wallet to create the protocol
payment payload, retry that same paid resource with the signed payment header,
and return resource response plus payment readback bound to the reservation and
idempotency key.

That adapter may run locally with operator-owned credential custody, or through
an explicitly selected hosted Connect grant. In either case:

- the skill and payment workflow remain in OSS;
- the adapter is selected by an opaque profile, never caller-supplied endpoints;
- wallet keys, seed phrases, bearer tokens, and admission material never enter
  skill input or agent context;
- Cloud, when opted into, may resolve the grant and execute one bounded provider
  call but does not own the skill, queue, approval policy, or local state;
- success requires independent paid-resource/payment readback, not an HTTP 2xx
  from a signer or facilitator.

The existing upstream x402 conformance tooling is evidence for the wire
protocol, not an executable adapter for this public skill.

## Inputs and result

- `payment_signal` is the structured x402 challenge with positive minor-unit
  amount, uppercase currency, counterparty, operation, and optional realm.
- `parent_payment_authority` is the complete typed parent `AuthorityTerm`.
- `idempotency_seed` is stable caller-owned material for this intent.
- `realm` optionally narrows the expected authority realm.

The result is a canonical payment quote packet. It never contains a wallet
credential, signature, payment admission token, provider endpoint, or a claim
that funds moved.

## Stop conditions

Stop before output when the challenge is malformed, not x402, over a ceiling,
outside aggregate limits, expired, or mismatched on currency, realm,
counterparty, or operation. Refuse raw credentials and endpoint configuration.
Do not silently select another rail or convert a quote into approval.

For example, if a resource requests USD 1.25 for `search.paid` from
`merchant:demo`, and the supplied parent term authorizes that exact x402 action
up to USD 2.00, the skill emits the bounded quote. It still says nothing was
paid; execution remains blocked on the missing trusted adapter.

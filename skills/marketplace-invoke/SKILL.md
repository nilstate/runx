---
name: marketplace-invoke
description: Invoke one exact marketplace-listed vendor resource through an approved settlement adapter and return receipt-backed provider readback.
runx:
  category: payments
---

# Marketplace Invoke

The body sent to the vendor is the complete current V1 invocation envelope.
The listing signal supplies immutable offer revision and schema digests,
canonicalizer, and product input. The hosted x402 buyer derives the stable
idempotency key from the admitted operation and adds the current outer
`parent_binding`; neither callers nor listing facades may forge either field.

`marketplace-invoke` is the buyer-facing marketplace skill called through the
existing `runx skill` surface. Paid listing
admission injects the immutable listing, vendor, exact endpoint, vendor price,
demand-side fee, settlement family, and expected receipt class into one Runx
run before its quote is fingerprinted. Callers supply only the live settlement
signal, the matching bounded authority, and a stable retry identity. Hosted
receipt custody verifies the returned inner receipt and seals the outer
execution as a mediated composite receipt.

The skill is rail-neutral at its boundary. `settlement_family` selects an
explicit adapter branch; x402 is the first implementation. Stripe and future
rails add sibling branches while preserving the listing, vendor, authority,
result, and composite-receipt semantics. Provider SDKs, wallets, credentials,
settlement recovery, and database state remain in Runx Hosted.

## Composes

<!-- Generated from the native execution closure; run pnpm core-skills:composes:generate. -->

- `x402-pay#pay`

## Operator guide

Use this skill through a paid endpoint listing after marketplace discovery.
Supply the exact settlement signal returned for that resource, a complete
parent maximum equal to the listing's vendor price, and an idempotency seed
stable across every retry. `marketplace_offer` is reserved for hosted admission;
a caller-supplied value is refused. Keep large inputs behind artifact references.

The x402 branch delegates to `x402-pay`, which owns the single provider-effect
approval, exact external V2 validation, durable signed-payload retry, transaction
finality, and vendor receipt readback. This skill adds no wrapper approval: the
delegated provider-effect request is returned as the one waiting-resolution gate
for vendor spend. The skill never interprets wallet material.

Stop if the family is unsupported, the endpoint differs from the authority or
signal, terms drift, provider readback is incomplete, or the inner receipt is not
available in hosted custody. A refusal or uncertain effect remains visible in the
receipt and must be retried only with the same idempotency seed.

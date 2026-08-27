---
name: marketplace-invoke
description: Invoke one exact marketplace-listed vendor resource through an approved settlement adapter and return receipt-backed provider readback.
runx:
  category: payments
---

# Marketplace Invoke

The caller supplies only the provider-neutral vendor request body and bounded
transport preferences. Paid-listing admission injects the immutable offer and
the run idempotency identity. The selected settlement adapter derives its own
protocol envelope, authority attenuation, endpoint, amount, and parent binding;
neither callers nor product facades may forge those fields.

`marketplace-invoke` is the buyer-facing marketplace skill called through the
existing `runx skill` surface. Paid listing
admission injects the immutable listing, vendor, exact endpoint, vendor price,
demand-side fee, settlement family, and expected receipt class into one Runx
run before its quote is fingerprinted. Hosted receipt custody verifies the
returned inner receipt and seals the outer execution as a mediated composite
receipt.

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
Supply the exact vendor invocation body and optional bounded transport limits.
`marketplace_offer` and `idempotency_seed` are reserved for hosted admission;
caller-supplied values are refused. Keep large inputs behind artifact references.

The x402 branch delegates to `x402-pay`, which owns the single provider-effect
approval, exact external V2 validation, durable signed-payload retry, transaction
finality, and vendor receipt readback. This skill adds no wrapper approval: the
delegated provider-effect request is returned as the one waiting-resolution gate
for vendor spend. The skill never interprets wallet material.

Stop if the family is unsupported, terms drift, provider readback is incomplete,
or the inner receipt is not available in hosted custody. A refusal or uncertain
effect remains visible in the receipt and must be retried with the same hosted
run idempotency identity.

---
name: marketplace-invoke
description: Invoke one exact marketplace-listed vendor resource through an approved settlement adapter and return receipt-backed provider readback.
runx:
  category: payments
---

# Marketplace Invoke

`marketplace-invoke` is the buyer-facing marketplace command. It binds a listing,
vendor, exact vendor resource, maximum spend, and stable retry identity into one
Runx run. The public result is the selected settlement adapter's provider and
paid-resource readback. When this command itself is sold as a paid Runx skill,
Hosted receipt custody verifies the returned inner receipt and seals the outer
execution as a mediated composite receipt.

The command is rail-neutral at its boundary. `settlement_family` selects an
explicit adapter branch; x402 is the first implementation. Stripe and future
rails add sibling branches while preserving the listing, vendor, authority,
result, and composite-receipt semantics. Provider SDKs, wallets, credentials,
settlement recovery, and database state remain in Runx Hosted.

## Composes

<!-- Generated from the native execution closure; run pnpm core-skills:composes:generate. -->

- `x402-pay#pay`

## Operator guide

Use this skill after marketplace discovery has selected one immutable listing
and vendor endpoint. Supply the exact settlement signal returned for that
resource, a complete parent maximum, and an idempotency seed stable across every
retry. Keep large inputs behind artifact references.

The x402 branch delegates to `x402-pay`, which owns the single provider-effect
approval, exact external V2 validation, durable signed-payload retry, transaction
finality, and vendor receipt readback. This skill never asks for a second approval
and never interprets wallet material.

Stop if the family is unsupported, the endpoint differs from the authority or
signal, terms drift, provider readback is incomplete, or the inner receipt is not
available in hosted custody. A refusal or uncertain effect remains visible in the
receipt and must be retried only with the same idempotency seed.

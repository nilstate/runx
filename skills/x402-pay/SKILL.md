---
name: x402-pay
description: Pay one x402 challenge through Runx Hosted with approval and paid-resource readback.
runx:
  category: payments
---

# X402 Pay

`x402-pay` is the public x402 buyer contract. Its OSS graph submits the exact
x402 payment signal, complete parent authority, and stable idempotency seed to
the hosted `payment.x402` operation, then requires readback through
`payment.x402.read`.

Runx Hosted owns challenge validation, authority attenuation and reservation,
wallet or facilitator credentials, payload signing, paid-resource retry,
settlement recovery, finality, and the private ledger. OSS contains the public
v1 Runx contract and generic provider-effect gate only. References to x402
protocol version 2 in upstream conformance material describe the external
standard, not a Runx v2 contract.

## Operator guide

Use this skill after a resource returns structured x402 requirements and a
compatible hosted buyer grant is configured. Stop on malformed or expired
requirements, amount/currency/counterparty/operation drift, incomplete
authority, missing approval, or inconsistent paid-resource readback. Never pass
wallet keys, seed phrases, bearer tokens, facilitator credentials, or arbitrary
endpoints in skill input, and never treat a quote or HTTP acknowledgement as
settlement.

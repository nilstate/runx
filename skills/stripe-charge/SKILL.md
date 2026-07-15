---
name: stripe-charge
description: Model provider-side charge verification through the Stripe settlement family.
runx:
  category: payments
---

# Stripe Charge

Compose provider-side charge pricing, challenge emission, credential
verification, receipt sealing, and modeled forwarding for Stripe-style
credential verification.

This graph profile is registry documentation and harness shape. It does not
perform live Stripe calls, read merchant credentials, or enable runtime
forwarding.

The modeled path is complete only when priced bounds become an idempotent
challenge, verification returns a Stripe-family proof reference, and a sealed
receipt gates the upstream result. Merchant credential material stays behind
references. Stop before modeled forwarding when verification cannot name both
its proof and sealed receipt.

## Output

- `charge_price_packet`: priced bounds and requested provider authority.
- `charge_challenge_packet`: the idempotent payment-required challenge.
- `charge_verification_packet`: Stripe-family verification evidence and proof ref.
- `charge_seal`: the modeled child receipt seal.
- `forwarded_result`: the modeled upstream result, present only after the seal.

## Inputs

- `mcp_tool_call` (required): inbound MCP operation request.
- `provider_policy` (required): provider price and family policy.
- `returned_credential` (required): Stripe credential envelope or reference.
- `parent_payment_authority` (optional): parent payment authority term or ref.
- `verify_capability_ref` (required): single-use verification capability ref.
- `idempotency_seed` (optional): stable challenge idempotency seed.

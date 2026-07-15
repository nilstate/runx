---
name: mock-charge
description: Model provider-side charge verification through the deterministic mock settlement family.
runx:
  category: payments
---

# Mock Charge

Compose provider-side charge pricing, challenge emission, credential
verification, receipt sealing, and modeled forwarding for the deterministic
mock settlement family.

This graph profile is for local harnesses, demos, and contract tests. It makes
the authority transition visible without claiming executable provider-side
runtime forwarding.

The deterministic path is complete only when priced bounds become an
idempotent challenge, verification produces a mock proof reference, and a
sealed receipt gates the modeled upstream result. Keep raw rail and merchant
credentials out of every artifact. If verification cannot name its proof and
sealed receipt, stop before the forwarding step.

## Output

- `charge_price_packet`: provider-side price and requested authority.
- `charge_challenge_packet`: `effect_required` challenge and idempotency key.
- `charge_verification_packet`: mock settlement proof and receipt ref.
- `charge_seal`: modeled child receipt seal.
- `forwarded_result`: modeled upstream result gated by the seal.

## Inputs

- `mcp_tool_call` (required): inbound MCP operation request.
- `provider_policy` (required): provider price and family policy.
- `returned_credential` (required): mock credential envelope or reference.
- `parent_payment_authority` (optional): parent payment authority term or ref.
- `verify_capability_ref` (required): single-use verification capability ref.
- `idempotency_seed` (optional): stable challenge idempotency seed.

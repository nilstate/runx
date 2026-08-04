---
name: charge-verify
description: Prepare an exact provider-verifier request from an opaque credential reference natively.
runx:
  category: payments
---

# charge-verify

Internal graph stage for `charge`. It delegates deterministic validation,
digesting, and packet construction to the native `payment.charge_verification_request` tool.
Do not call it as an operator entrypoint; use `charge`.

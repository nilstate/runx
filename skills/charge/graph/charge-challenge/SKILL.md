---
name: charge-challenge
description: Bind a provider price to a deterministic replay-safe challenge natively.
runx:
  category: payments
---

# charge-challenge

Internal graph stage for `charge`. It delegates deterministic validation,
digesting, and packet construction to the native `payment.charge_challenge` tool.
Do not call it as an operator entrypoint; use `charge`.

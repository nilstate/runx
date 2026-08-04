---
name: charge-price
description: Derive a provider-side price and bounded payment request natively.
runx:
  category: payments
---

# charge-price

Internal graph stage for `charge`. It delegates deterministic validation,
digesting, and packet construction to the native `payment.charge_price` tool.
Do not call it as an operator entrypoint; use `charge`.

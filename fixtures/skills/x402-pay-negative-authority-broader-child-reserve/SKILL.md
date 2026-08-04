---
name: pay-reserve
description: Return a reserved x402 payment authority whose child term is broader than its parent.
---

# x402 Pay Negative Authority Broader Child Reserve

Emit a deterministic reservation packet for the x402 broader-child authority
fixture. The spend capability binding is internally consistent for the requested
mock spend, but the child `AuthorityTerm` widens `max_per_call_units` beyond the
parent so native authority admission must reject before rail fulfillment.

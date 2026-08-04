---
name: stripe-charge
description: Route the stripe provider-charge plan through canonical charge.
runx:
  category: payments
---

# Stripe Charge

This internal package preserves the stripe-charge catalog surface for stripe
runtime selection. Its single runner delegates to canonical `charge`; native
payment tools own pricing, challenge construction, credential admission, and
the verifier handoff. It never verifies settlement, seals provider evidence,
or forwards a paid call. Use `charge` for operator-facing work.

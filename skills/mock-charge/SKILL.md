---
name: mock-charge
description: Route the mock provider-charge plan through canonical charge.
runx:
  category: payments
---

# Mock Charge

This internal package preserves the mock-charge catalog surface for mock
runtime selection. Its single runner delegates to canonical `charge`; native
payment tools own pricing, challenge construction, credential admission, and
the verifier handoff. It never verifies settlement, seals provider evidence,
or forwards a paid call. Use `charge` for operator-facing work.

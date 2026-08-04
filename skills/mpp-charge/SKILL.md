---
name: mpp-charge
description: Route the mpp provider-charge plan through canonical charge.
runx:
  category: payments
---

# Mpp Charge

This internal package preserves the mpp-charge catalog surface for mpp
runtime selection. Its single runner delegates to canonical `charge`; native
payment tools own pricing, challenge construction, credential admission, and
the verifier handoff. It never verifies settlement, seals provider evidence,
or forwards a paid call. Use `charge` for operator-facing work.

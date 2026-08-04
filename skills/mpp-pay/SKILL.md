---
name: mpp-pay
description: Route the mpp payment rail through canonical spend authority and finality.
runx:
  category: payments
---

# MPP Pay

This internal package preserves the mpp-pay catalog surface as the internal MPP runtime rail.
It does not implement payment policy. The single runner forwards a full payment
signal, parent AuthorityTerm, rail profile, and stable idempotency seed to the
canonical `spend` mpp runner. Quote construction, authority attenuation,
approval, rail execution, recovery, and receipt-before-success remain owned by
`spend`.

Use `spend` for operator-facing payment work. Use this package only when a
harness or runtime integration must select the mpp rail explicitly. Never
pass raw funding material.

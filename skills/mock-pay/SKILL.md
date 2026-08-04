---
name: mock-pay
description: Route the mock payment rail through canonical spend authority and finality.
runx:
  category: payments
---

# Mock Pay

This internal package preserves the mock-pay catalog surface as the deterministic harness and local-test rail.
It does not implement payment policy. The single runner forwards a full payment
signal, parent AuthorityTerm, rail profile, and stable idempotency seed to the
canonical `spend` mock runner. Quote construction, authority attenuation,
approval, rail execution, recovery, and receipt-before-success remain owned by
`spend`.

Use `spend` for operator-facing payment work. Use this package only when a
harness or runtime integration must select the mock rail explicitly. Never
pass raw funding material.

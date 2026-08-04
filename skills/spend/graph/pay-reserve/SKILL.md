---
name: pay-reserve
description: Deterministically mint and prove one single-use child payment authority from a native quote and the caller's real parent authority.
---

# Pay Reserve

Use this internal stage only through the canonical `spend` graph. The native
`payment.reserve` boundary re-mints the child from the full parent term,
computes the subset proof, and binds one idempotency key and capability to one
downstream harness and act.

The emitted approval state is pending. Reservation does not approve the spend,
contact a provider, move money, or claim settlement. Over-wide quotes, mismatched
authority data, authority references without terms, and invalid target bindings
fail before any rail is touched.

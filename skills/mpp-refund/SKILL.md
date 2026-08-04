---
name: mpp-refund
description: Route the mpp refund plan through canonical receipt- and authority-bound refund.
runx:
  category: payments
---

# Mpp Refund

This internal package preserves the mpp-refund catalog surface for mpp
runtime selection. Its single runner delegates to canonical `refund`; the
native payment tool owns sealed-charge admission, prior-refund accounting,
authority validation, and adapter-handoff construction. It never approves or
executes a refund and never claims money moved. Use `refund` for
operator-facing work.

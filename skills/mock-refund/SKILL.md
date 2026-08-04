---
name: mock-refund
description: Route the mock refund plan through canonical receipt- and authority-bound refund.
runx:
  category: payments
---

# Mock Refund

This internal package preserves the mock-refund catalog surface for mock
runtime selection. Its single runner delegates to canonical `refund`; the
native payment tool owns sealed-charge admission, prior-refund accounting,
authority validation, and adapter-handoff construction. It never approves or
executes a refund and never claims money moved. Use `refund` for
operator-facing work.

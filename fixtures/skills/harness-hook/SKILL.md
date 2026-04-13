---
name: harness-hook-review
description: Deterministic test-only receipt review hook.
source:
  type: harness-hook
  hook: review-receipt
  outputs:
    verdict: string
inputs:
  receipt_id:
    type: string
    required: true
    description: Receipt id to review in the deterministic harness.
runx:
  fixture_only: true
---

Use this fixture only for testing the explicit harness-hook boundary.

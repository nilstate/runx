---
name: agency-health-ledger-stubs
description: Project only receipt id-stubs already cited by ordered agency case events for a bounded ledger.read replay.
---

# Agency Health Ledger Stubs

Internal deterministic stage for `agency-health`. It extracts
`receipt_id`, `skill_ref`, `status`, and `created_at` only from member results
already sealed into the case event order. It never reads a receipt body,
fabricates a row, or writes state.

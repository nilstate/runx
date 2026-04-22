---
name: reflect-digest
description: Aggregate projected reflect facts into bounded skill improvement proposals.
---

# Reflect Digest

Read projected reflect facts from the local journal, group them by skill, and
draft bounded improvement proposals only when the grouped evidence clears the
configured floors.

This is the explicit cognition lane for reflection. It does not mutate a repo,
push a branch, or publish a pull request. It emits provider-agnostic PR draft
handoffs for later governed review and push.

## Output

- `proposals`: an array of grouped proposal packets. Each item includes:
  - `skill_ref`
  - `supporting_receipt_ids`
  - `draft_pull_request`
  - `outbox_entry`

## Inputs

- `reflect_facts` (optional): explicit reflect fact entries. Useful for harness
  replay and controlled evaluation.
- `skill_filter` (optional): only consider one skill ref.
- `since` (optional): only consider facts recorded at or after this ISO time.
- `min_support` (optional): minimum grouped fact count required to draft.
- `min_confidence` (optional): minimum per-fact confidence required to include
  a reflect fact in grouping.

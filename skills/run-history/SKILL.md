---
name: run-history
description: Read Runx's native receipt history and skill catalog, then return deterministic run outcomes, catalog test coverage, and governance follow-ups without model-authored metrics.
runx:
  category: data
---

# Run History

Read the local Runx ledger through the native `receipt.query` service and the
installed catalog through `runx.skill.inspect`. The runner computes the report
itself; it does not ask an agent to invent commands, launch subprocesses, or
transcribe counts.

Use it for operational questions about recent Runx activity, failed or blocked
runs, pending runs, frequently used receipt subjects, and skill entries without
fixtures or inline harness cases. Use `audit-receipt` or `review-receipt` to
inspect one suspicious run, and `least-privilege` when receipt-backed authority
usage is available for grant attenuation.

## Evidence boundary

- Live execution reads only the native receipt and catalog projections. These
  services share the same store resolution, signature policy, and catalog
  parser as the Runx CLI without routing back through the CLI as a subprocess.
- History reads are bounded to 1,000 rows by default and 10,000 at most.
- `history_receipts`, `pending_runs`, and `catalog_items` are replay inputs for
  harnesses and controlled analysis. `history_receipts` and `catalog_items`
  must be supplied together; replay never silently mixes caller data with live
  native state.
- Empty history returns `needs_more_evidence` rather than a healthy verdict.
- `closed_rate` is the share of terminal receipt rows whose status is `closed`.
- `refusal_rate` counts `blocked` and `declined` terminal rows. It is reported
  as an observation, not automatically treated as a defect.
- Catalog coverage is the number of native catalog entries declaring at least
  one fixture or inline harness case. It is not a maturity grade.

## Output

`history_report` contains:

- the exact resolved query and source labels (`native_receipt_store`,
  `native_skill_catalog`, or `supplied_replay`);
- terminal and pending counts, status counts, closed/refusal rates;
- the most frequent receipt subjects;
- catalog entry and test-coverage counts;
- bounded recommendations routed to `review-receipt`, `audit-receipt`, or
  `skill-lab harness`;
- limitations when native projections cannot support a stronger claim.

This skill never executes another skill, changes a grant, or mutates the
receipt store.

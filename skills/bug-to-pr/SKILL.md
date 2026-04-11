---
name: bug-to-pr
description: Govern a scafld-backed bug-to-PR lane with caller-mediated review.
---

# Bug to PR

Drive a bounded bugfix through the full scafld lifecycle under runx
governance — from spec creation through adversarial review to archived
completion.

The chain invokes the `scafld` skill at each lifecycle stage with explicit
scopes. The fix scope must be known before you start. If the bug needs
diagnosis first, use `receipt-review` or research skills upstream, then
feed the bounded fix into this chain.

The adversarial review is caller-mediated. runx opens the review round
via `scafld review --json`, which returns the review file path and
adversarial prompt. A reviewer (human, controlling agent, or peer agent)
fills the three adversarial sections — regression_hunt, convention_check,
dark_patterns — then sets a verdict. `scafld complete` validates the
filled review and archives the spec.

The chain does not control who reviews. It provides the handoff boundary.
The caller decides.

## Inputs

- `task_id`: scafld task id (default: `bug-to-pr-fixture`).
- `title`: bugfix title for the spec.
- `size`: `micro`, `small`, `medium`, or `large` (default: `micro`).
- `risk`: `low`, `medium`, or `high` (default: `low`).
- `phase`: optional scafld execution phase.
- `fixture`: workspace root containing `.ai/`.
- `scafld_bin`: explicit scafld executable path.

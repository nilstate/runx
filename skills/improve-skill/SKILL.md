---
name: improve-skill
description: Turn a failed receipt or harness outcome into a bounded skill improvement proposal.
---

# Improve Skill

Review a failed or suspicious run and draft the next bounded improvement.

This is a composite skill that chains `receipt-review` into `harness-author`.
It takes failure evidence — a receipt, harness output, or manual summary —
diagnoses the root cause, and produces an updated skill proposal with
replayable fixtures that cover the failure.

## What this skill does

1. **Review the failure** (via `receipt-review`). Analyzes the receipt or
   harness output to identify the root cause. Classifies the failure,
   distinguishes symptoms from root cause, and produces a verdict with
   bounded improvement proposals.

2. **Author updated fixtures** (via `harness-author`). Takes the review
   output and drafts an updated skill spec, execution plan if needed,
   and harness fixtures that specifically cover the diagnosed failure.
   The new fixtures serve as acceptance checks for the fix.

## When to use this skill

- A skill run failed and you need to understand why and what to fix.
- A harness test is failing and you need to update the skill or fixtures.
- A receipt shows suspicious behavior (partial success, unexpected output)
  and you want a structured improvement proposal.

## When not to use this skill

- For designing a new skill from scratch — use `objective-to-skill`.
- For general research — use `skill-research`.
- When you already know the fix — just make the change directly.

## Improvement philosophy

Prefer the smallest change that materially improves the skill. One
failure should produce one fix, not an architectural rewrite. If the
review reveals multiple independent issues, propose them as separate
improvements, not a bundled change.

## Inputs

All inputs are optional. Supply whichever evidence is available:

- `receipt_id`: receipt id to inspect. The receipt contains step statuses,
  inputs, outputs, scope decisions, and timing.
- `receipt_summary`: sanitized receipt or failure summary when the full
  receipt is not available.
- `harness_output`: sanitized harness output or assertion failure text.
- `skill_path`: path to the skill package being improved. The review
  step will read the SKILL.md and x.yaml to understand the contract.
- `objective`: operator intent for the improvement pass. Guides the
  review toward specific aspects of the failure.

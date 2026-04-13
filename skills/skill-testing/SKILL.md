---
name: skill-testing
description: Evaluate a skill, draft the trust report, and package the approved recommendation.
---

# Skill Testing

This chain is the public-facing trust-report lane.

It evaluates one skill, turns the findings into a concise report, and then
packages the approved output for publication or operator handoff.

## Inputs

- `skill_ref` (required): skill package or registry reference to assess.
- `objective` (optional): decision the report should support.
- `channel` (optional): final report channel; defaults to `trust-report`.
- `evidence_pack` (optional): receipts, docs, or source notes that should anchor
  the evaluation.
- `test_constraints` (optional): environment or safety limits for evaluation.

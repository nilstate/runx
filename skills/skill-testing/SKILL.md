---
name: skill-testing
description: Evaluate a skill, draft the trust audit, and package the approved recommendation.
---

# Skill Testing

This chain is the public-facing trust-audit lane.

It evaluates one skill, turns the findings into a concise report, and then
packages the approved output for publication or operator handoff.

## Inputs

- `skill_ref` (required): skill package or registry reference to assess.
- `objective` (optional): decision the audit should support.
- `channel` (optional): final report channel; defaults to `trust-audit`.
- `evidence_pack` (optional): receipts, docs, or source notes that should anchor
  the evaluation.
- `test_constraints` (optional): environment or safety limits for evaluation.

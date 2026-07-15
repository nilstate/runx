---
name: skill-testing
description: Evaluate a skill, draft the trust audit, and package the approved recommendation.
runx:
  category: authoring
---

# Skill Testing

This graph is the public-facing trust-audit lane.

It evaluates one skill, turns the findings into a concise report, and then
packages the approved output for publication or operator handoff.


## Trust Audit Checks

Before packaging a recommendation, confirm:

- The skill contract is bounded and matches the execution profile.
- The execution profile declares typed inputs and outputs, side-effect posture,
  allowed refs/tools, approval or authority posture, receipt mapping where
  relevant, and harness cases.
- Harness or receipt evidence covers a meaningful happy path and at least one
  stop or error path.
- Published artifacts are durable and public. Private previews, localhost,
  placeholder hosts, unrelated parent domains, or dead links block a publication
  recommendation.
- The audit names the concrete user-visible value: who would use, link, install,
  trust, or maintain the skill.
- The evidence pack contains no secrets, raw credentials, private customer data,
  private email bodies, wallet private keys, or provider response dumps.

Passing a harness is not enough if the package is a placeholder, duplicate, or
has no credible user, operator, maintainer, or catalog value. Base the result on
the skill contract, source notes, receipts, and harness output. Stop at review
when trust evidence is insufficient or the capability cannot be bounded; do not
turn missing evidence into optimistic audit language.

## Output

- `skill_assessment`: bounded capability and execution-profile findings.
- `trust_audit_draft`: risks, caveats, evidence, and test gaps.
- `approval_decision`: adopt, sandbox, reject, or request more evidence.
- `publish_or_handoff_packet`: approved recommendation for its declared audience.

## Inputs

- `skill_ref` (required): skill package or registry reference to assess.
- `objective` (optional): decision the audit should support.
- `channel` (optional): final report channel; defaults to `trust-audit`.
- `evidence_pack` (optional): receipts, docs, or source notes that should anchor
  the evaluation.
- `test_constraints` (optional): environment or safety limits for evaluation.

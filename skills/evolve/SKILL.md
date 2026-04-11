---
name: evolve
description: Governed repo evolution — diagnose, plan, approve, execute, verify, review, publish.
---

# Evolve

Evolve the current repository toward a bounded objective through governed
phases: preflight, planning, approval, execution, and publication.

This is not autonomous code generation. It governs the shape around
cognition — every phase produces a typed artifact, every mutation requires
approval, every step emits a receipt. A single evolve run ends in a bounded
artifact, not another loop.

## Phases

### Preflight

Deterministic. Inspects the target repo and produces a `repo_profile`:
repo root, git state, base branch, dirty worktree, `.ai/` presence
(scafld initialized), detected languages, test commands, risk signals.
No agent cognition, no mutation.

### Plan

Caller-mediated (agent-step). Given the objective and repo profile,
produces four artifacts in one pass:

- `objective_brief` — restatement with target kind, constraints,
  success criteria.
- `diagnosis_report` — current repo state relative to the objective.
- `change_plan` — ordered phases, acceptance checks, touchpoints, risk.
- `spec_document` — draft scafld spec when governance applies.

### Approve

Gate before mutation. Presents the plan for explicit approval. If denied,
the chain stops. The `approval_decision` records: approved, decision_by,
reason.

### Act

Executes the approved plan. Gated by the approval decision via policy
transition.

- If `terminate` is `spec`: no-op. Plan artifacts are the deliverable.
- If `terminate` is `patch` or `pr`: executes the change plan and
  produces `execution_report`, `verification_report`, `review_report`.

**Current status: skeleton.** The act step currently produces synthetic
output. Real execution (isolated branch, scafld integration, test
running) is not yet wired.

### Publish

Publishes if the review verdict permits.

- If `terminate` is `pr` and verdict is `approve`: produces a
  publishable artifact.
- Otherwise: no publication.

**Current status: skeleton.** Like act, this step produces synthetic
output. Real PR creation is not yet wired.

## Termination

- `spec` (default): stop after planning. No mutation.
- `patch`: execute and produce a local patch in an isolated branch.
- `pr`: execute, verify, review, and open a PR if review passes.

## Inputs

- `objective` (required): what to evolve toward.
- `repo_root` (optional): repository root. Defaults to cwd.
- `terminate` (optional): `spec`, `patch`, or `pr`. Defaults to `spec`.

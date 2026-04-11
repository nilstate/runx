---
name: evolve
description: Governed repo evolution — diagnose, plan, approve, execute, verify, review, publish.
---

# Evolve

Evolve the current repository toward a bounded objective through a governed
pipeline of diagnosis, planning, approval, execution, verification, review,
and publication.

This is the primary composite skill in runx. It is not a magic autonomy
button. It governs the shape around cognition — every phase produces a typed
artifact, every mutation requires approval, every step emits a receipt.

## Canonical phases

Every evolve run follows the same phase geometry, regardless of the target
domain. The concrete skills and adapters change; the shape does not.

### 1. Preflight

Inspect the target repo and produce a `repo_profile` artifact.

- Detect repo root, git state, base branch, dirty worktree status.
- Check for `.ai/` directory (scafld initialization).
- Identify languages, build tools, test commands.
- Flag risk signals: missing scafld, no test suite, dirty worktree,
  uncommitted changes.

This phase is deterministic. No agent cognition, no mutation.

### 2. Plan

Produce four artifacts from the objective and repo profile:

- `objective_brief`: concise restatement of the objective with target
  kind (repo, skill, receipt, runx), target ref, constraints, and
  success criteria.
- `diagnosis_report`: analysis of the current repo state relative to
  the objective. What exists, what is missing, what is broken.
- `change_plan`: ordered phases with acceptance checks, file touchpoints,
  and risk level. This is the concrete work plan.
- `spec_document`: if the objective requires scafld governance, a
  draft spec with task_id, title, summary, size, risk_level, phases,
  and rollback strategy.

This phase is caller-mediated (agent-step). The planning agent has
full context from preflight and produces all four artifacts in one pass.

### 3. Approve

Gate the plan before any mutation. Present the objective_brief,
change_plan, and spec_document for explicit approval.

- Approval is caller-mediated: the human, controlling agent, or
  policy engine decides.
- If denied, the chain stops here. No mutation occurs.
- The approval_decision artifact records: approved (boolean),
  decision_by, reason, and what it applies to.

### 4. Act

Execute the approved plan. This phase is where mutation happens.

- If `terminate` is `spec`: no-op. The plan artifacts are the
  deliverable.
- If `terminate` is `patch` or `pr`: execute the change plan against
  the repo, run verification checks, and produce:
  - `execution_report`: steps completed, files changed, commands run,
    base and head commits, branch, worktree.
  - `verification_report`: test results — checks passed, failed,
    skipped, summary.
  - `review_report`: verdict (approve/reject), blocking issues,
    non-blocking issues, review scope, confidence.

This phase requires explicit write scopes and is gated by the
approval decision.

### 5. Publish

Publish the outcome if the review verdict permits it.

- If `terminate` is `pr` and review verdict is `approve`: open a
  pull request or produce the publishable artifact.
- Otherwise: no publication. The artifacts remain local.
- Produces a `publish_report`: published (boolean), target
  (pull_request/none), artifact references.

This phase is gated by the review verdict via policy transition.

## Termination modes

The `terminate` input controls how far the chain runs:

- `spec` (default): stop after planning. No mutation, no execution.
  The plan artifacts are the deliverable. Use this for exploration,
  validation, and review before committing to changes.
- `patch`: execute the plan and produce a local patch. Mutation happens
  in an isolated branch or worktree. No PR is opened.
- `pr`: execute the plan, verify, review, and open a pull request if
  the review passes.

## Evolution targets

The objective string determines the target. The preflight phase
resolves the concrete target from the current repo context.

- **Repo evolution**: "add websocket adapter support" — improve the
  current codebase toward an objective.
- **Skill evolution**: use with `--skill ./skills/sourcey` — improve
  a specific skill package.
- **Receipt-driven repair**: use with `--receipt rx_8f3a` — fix
  something based on a failed or suspicious run.
- **Self-evolution**: run against the runx repo itself for dogfooding.

## Boundary rules

- Every mutating run uses an isolated branch or worktree.
- A single evolve run ends in a bounded artifact, not another loop.
- If a skill lacks X metadata, evolve falls back to the agent runner.
- Policy never evaluates prose directly — it evaluates structured fields.
- Approval gates are first-class steps, not hidden CLI behavior.

## Inputs

- `objective` (required): the objective to evolve toward. Be specific
  about the deliverable and success criteria.
- `repo_root` (optional): repository root to inspect and evolve.
  Defaults to the current working directory.
- `terminate` (optional): bounded termination target — `spec`, `patch`,
  or `pr`. Defaults to `spec`.

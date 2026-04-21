---
name: issue-to-pr
description: Govern a scafld-backed issue-to-PR lane with a visible reviewer boundary.
---

# Issue to PR

Drive a bounded issue remediation lane through the full scafld lifecycle under
runx governance, from spec creation through authored fix, explicit review, and
projection-ready PR surfaces.

The chain separates cognition from mutation. Agent phases author the scafld
spec, the bounded repo change bundle, and the review contents. Deterministic
`fs.write` and `fs.write_bundle` phases are the only places files are written
to disk. The `scafld` skill remains the workflow kernel: it creates the spec,
binds the branch, reports sync and status, opens the review, completes the
task, and renders the final summary and PR body surfaces.

The adversarial review is reviewer-mediated. runx opens the review round via
`scafld review --json`, which returns the native review file path, required
sections, and adversarial prompt. A reviewer (human, controlling agent, or
peer agent) fills the three adversarial sections, `regression_hunt`,
`convention_check`, and `dark_patterns`, then writes the completed review
markdown back through a deterministic file-write step before `scafld complete`
validates and archives the spec.

The chain does not control who authors the spec, the fix, or the review. It
provides the governed handoff boundaries. The caller decides. That is the point
of the lane: it should feel like the engineering system, not an extra system.
The branch, spec, review, receipt, and PR surfaces stay visible as first-class
artifacts instead of being collapsed into a shadow runx-only object model.

## Lifecycle

The chain runs: `scafld new` -> author spec -> write spec -> validate ->
approve -> start -> `scafld branch` -> author fix bundle -> write fix bundle ->
exec -> `scafld status` -> audit -> review-open -> reviewer boundary -> write
review -> complete -> `scafld summary` -> `scafld pr-body`. The branch step
records the origin binding and sync facts that later status/review/projection
surfaces keep visible; there is no separate runx-owned sync object. Each step
gets only the scopes it needs. See the execution profile (`X.yaml`) for the
full step graph.

The important contract shape is:

- scafld owns workflow state such as spec paths, branch binding, sync status,
  review file paths, and projection output.
- runx owns governance around those state transitions: explicit authoring
  boundaries, deterministic writes, approvals, and receipts.
- Agent steps author content, not shadow workflow objects. The lane consumes
  native scafld fields like `state.file`, `result.transition.to`,
  `result.review_file`, and projection markdown directly.
- runx runtime artifacts such as receipt directories and `RUNX_HOME` should
  live outside the governed repo, or under ignored paths, so scafld audit and
  review gates only reason about declared engineering changes.

## Spec authoring contract

The `issue-to-pr-author-spec` boundary must emit a full scafld `spec_version:
"1.1"` YAML document, not a reduced project brief.

That means the authored spec must include:

- `spec_version`, `task_id`, `created`, `updated`, `status`
- `task.title`, `task.summary`, `task.size`, `task.risk_level`
- `task.context` with grounded file impact and relevant invariants
- `task.objectives`
- `task.touchpoints`
- `task.acceptance.definition_of_done`
- `task.acceptance.validation`
- `planning_log`
- at least one `phases[]` entry with `objective`, `changes[]`,
  `acceptance_criteria[]`, and `status`
- `rollback.strategy` and `rollback.commands`

All changed-file declarations must use concrete repo-relative paths. The spec
must never use prose placeholders like "the relevant docs file" inside
`files_impacted`, `changes[].file`, or rollback commands.

Do not declare scafld-managed control-plane artifacts under `.ai/specs/`,
`.ai/reviews/`, or `.ai/logs/` as repo-change scope. The lane creates and
updates those lifecycle files, but scafld excludes them from scope auditing, so
declaring them in `phases[].changes[].file` produces false `missing` results.

The safest reference shape is the one already used by the passing
`tests/issue-to-pr-chain.test.ts` fixture: `task.summary`, `task.size`,
`task.risk_level`, `task.acceptance.validation`, and phase-level
`acceptance_criteria` should be present explicitly, while the declared change
set stays limited to the real repo files under test.

Acceptance criteria must be executable in the current workspace state produced
by the lane before any commit exists. Do not depend on git history or revision
ranges such as `HEAD~1`, merge-base comparisons, or prior commits being
available. Prefer checks against the working tree or directly against the
declared changed files.

For file-scope assertions, prefer exact path filters or current-tree checks
such as `git diff --name-only -- <path>` or `git status --short -- <path>`
over history-dependent diffs. For content assertions, target the changed file
directly and anchor on the exact expected text so the check cannot accidentally
match issue titles, spec prose, or other unrelated strings elsewhere in the
repo.

## Inputs

- `task_id`: scafld task id (default: `issue-to-pr-fixture`).
- `issue_title`: canonical issue title passed into the lane.
- `title`: compatibility alias for callers that still send `title`.
- `issue_body`: full issue/support body when available.
- `source`: source system, for example `github_issue` or `support_request`.
- `source_id`: source record identifier.
- `source_url`: source URL when available.
- `target_repo`: intended repo slug for repo-local dispatchers.
- `repo_snapshot`: bounded structured snapshot of the target repo, when the
  supervisor or worker can inspect the real workspace before yielding the
  authoring boundary.
- `repo_snapshot_path`: optional path to a fuller repo snapshot artifact when
  the inline snapshot was intentionally compacted for prompt size.
- `repo_context`: optional textual summary of the target repo shape, notable
  files, and likely validation hooks.
- `size`: `micro`, `small`, `medium`, or `large` (default: `micro`).
- `risk`: `low`, `medium`, or `high` (default: `low`).
- `phase`: optional scafld execution phase.
- `name`: optional branch name forwarded to `scafld branch`.
- `base`: optional base ref forwarded to `scafld branch` and `scafld audit`.
- `bind_current`: when true, bind the current branch instead of creating or
  switching.
- `fixture`: workspace root containing `.ai/`.
- `scafld_bin`: explicit scafld executable path.

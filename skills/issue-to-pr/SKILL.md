---
name: issue-to-pr
description: Govern a scafld-backed issue-to-PR lane with a visible reviewer boundary.
---

# Issue to PR

Drive a bounded issue remediation lane through the full scafld lifecycle under
runx governance, from spec creation through authored fix and adversarial review
to archived completion.

The chain separates cognition from mutation. Agent phases author the scafld
spec, the bounded repo change bundle, and the review contents. Deterministic
`fs.write` and `fs.write_bundle` phases are the only places files are written
to disk. The `scafld` skill then
validates, advances, executes, audits, reviews, and archives the lane with
explicit scopes.

The adversarial review is reviewer-mediated. runx opens the review round via
`scafld review --json`, which returns the review file path and adversarial
prompt. A reviewer (human, controlling agent, or peer agent) fills the three
adversarial sections, `regression_hunt`, `convention_check`, and
`dark_patterns`, then sets a verdict. The review markdown is written via a
deterministic file-write step before `scafld complete` validates it and
archives the spec.

The chain does not control who authors the spec, the fix, or the review. It
provides the governed handoff boundaries. The caller decides.

## Lifecycle

The chain runs: `scafld new` -> author spec -> write spec -> validate ->
approve -> start -> author fix bundle -> write fix bundle -> exec -> audit ->
review-open -> reviewer boundary -> write review -> complete. Each step gets
only the scopes it needs. See `x.yaml` for the full step graph.

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

The safest reference shape is the one already used by the passing
`tests/issue-to-pr-chain.test.ts` fixture: `task.summary`, `task.size`,
`task.risk_level`, `task.acceptance.validation`, and phase-level
`acceptance_criteria` should be present explicitly.

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
- `fixture`: workspace root containing `.ai/`.
- `scafld_bin`: explicit scafld executable path.

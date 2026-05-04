---
name: issue-to-pr
description: Govern a scafld-backed issue-to-PR lane with native scafld review and handoff surfaces.
---

# Issue to PR

Drive one bounded thread-driven change through the scafld 2.1 lifecycle and
package the result as a provider-agnostic draft pull-request packet.

The graph separates cognition from mutation. Agent phases author the scafld
markdown spec and the bounded repo change bundle. Deterministic `fs.write` and
`fs.write_bundle` phases are the only places files are written to disk. scafld
owns the workflow kernel: `plan`, `validate`, `approve`, `build`, `status`,
`review`, `complete`, and `handoff`. runx owns the explicit authoring
boundaries, deterministic writes, receipts, and final outbox packaging.

Branch creation and provider PR mutation are outside scafld. The caller or
adapter prepares the branch, then this lane reads the current branch and uses it
when packaging the draft PR. The final `thread.push_outbox` step is the only
provider push boundary.

## Lifecycle

The graph runs:

`scafld plan` -> author markdown spec -> write spec -> read spec -> validate ->
approve -> read approved spec -> read declared files -> author fix bundle ->
write fix bundle -> build -> status -> read current branch -> review ->
complete -> final status -> handoff -> package draft PR outbox -> adapter push.

There are no compatibility projection steps. `scafld handoff` is the human
handoff surface, `scafld build` is the validation/check surface, and
`scafld review` is the native review boundary.

## Quality Profile

- Purpose: turn one bounded thread-driven change into a visible, reviewable
  draft PR through native scafld 2.1 surfaces.
- Audience: maintainers reviewing the issue, spec, code change, native review,
  handoff, and draft PR.
- Artifact contract: markdown scafld spec, authored change bundle, build
  result, review result, completed status, handoff markdown, draft PR packet,
  outbox entry, and receipt trail.
- Evidence bar: every spec objective, file impact, validation command, and PR
  claim must trace to the thread, repo snapshot, scafld state, or actual
  working-tree change.
- Stop conditions: return `needs_resolution` when authoring evidence is
  missing; return a blocked fix bundle when declared file context is
  insufficient.

## Spec Authoring Contract

The `issue-to-pr-author-spec` boundary must emit a full scafld 2.0 markdown
document, not YAML and not a reduced project brief.

The document must preserve front matter with:

- `spec_version: '2.0'`
- `task_id`
- `created`
- `updated`
- `status`
- `harden_status`
- `size`
- `risk_level`

The body must include the standard scafld 2 sections: Current State, Summary,
Context, Objectives, Scope, Dependencies, Assumptions, Touchpoints, Risks,
Acceptance, at least one Phase section, Rollback, Review, Self Eval,
Deviations, Metadata, Origin, Harden Rounds, and Planning Log.

All changed-file declarations must use concrete repo-relative paths in
backticks under Context / Files impacted and Phase / Changes. Do not declare
scafld-managed control-plane artifacts under `.scafld/specs`,
`.scafld/reviews`, `.scafld/runs`, or old `.ai` governance paths as repo-change
scope.

Validation commands must run against the current workspace state after the fix
bundle is written. Do not depend on git history ranges such as `HEAD~1` or
merge-base comparisons.

## Inputs

- `task_id`: scafld task id.
- `thread_title`: canonical title and default spec title.
- `thread_body`: full thread body or request text when available.
- `thread_locator`: canonical locator for the bounded thread.
- `thread`: portable thread for the current work item.
- `outbox_entry`: existing pull-request outbox entry when refreshing a draft.
- `target_repo`: intended repository slug for PR packaging.
- `repo_snapshot`: compact structured snapshot of the target repo.
- `repo_snapshot_path`: optional path to a fuller repo snapshot artifact.
- `repo_context`: textual summary of repo shape and validation hooks.
- `size`: scafld size, default `micro`.
- `risk`: scafld risk, default `low`.
- `base`: base ref for PR packaging, default `main`.
- `fixture`: workspace root containing `.scafld`.
- `scafld_bin`: explicit scafld executable path.
- `provider`, `provider_command`, `provider_binary`, `model`: optional native
  scafld review provider overrides.

## Structured Output

On success, the lane emits:

- `draft_pull_request`: provider-agnostic PR draft state derived from scafld
  handoff, build, review, completion, status, and current git branch.
- `outbox_entry`: a `pull_request` outbox entry suitable for adapter push.
- `push`: adapter push result plus refreshed `thread` when the adapter supports
  push.

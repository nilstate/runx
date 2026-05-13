---
name: issue-to-pr
description: Govern a scafld-backed issue-to-PR lane with native scafld review and handoff surfaces.
---

# Issue to PR

Drive one bounded thread-driven change through the scafld 2.4 lifecycle and
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

## Source Thread Story

The source thread is the work journal for issue-to-PR, but reviewers should see
the story as projections, not as a transcript. Keep the durable run record in
runx receipts and scafld state, then publish only the projection that fits the
surface:

- Issue status ledger: one managed status comment updated in place with the
  current state, source/issue/PR links, triage result, validation summary, risks,
  and next human action.
- PR reviewer packet: the PR body is the handoff surface for code review. It
  should be comprehensive but bounded: source context, AI/scafld reasoning,
  target repo/branch/base, scope, checks, validation, review verdict/findings,
  risks, rollback, retained handoff evidence, and final human merge gate.
- Notification stream: Slack, chat, email, or ticket updates should be concise
  milestone notifications only: triaging, PR ready for human review,
  merged/closed, or human-action-required blockers/errors.

Core knowledge helpers provide the generic markdown/text shapes:
`buildThreadStatusMarkdown`, `buildThreadMilestoneNotificationText`,
`buildThreadPullRequestReviewerPacketMarkdown`, and
`buildThreadStoryMessageOutboxEntry`. Product wrappers decide where to publish
those projections and which provider-specific managed key to use.

Do not put machine control state, receipt IDs, raw logs, or exact PR body dumps
in visible prose. Do include the meaty reasoning a reviewer needs, but pull it
into named sections and cap extracted snippets. User-controlled issue, Sentry,
Slack, or review snippets must be bounded and sanitized before inclusion.
Provider mutation still goes through `thread.push_outbox`, which adds the
provider-specific managed control envelope. The envelope is a correlation
receipt, not authorization; human merge permissions and provider identity remain
the security boundary.

## Lifecycle

The graph runs:

`scafld plan` -> author markdown spec -> write spec -> read spec -> validate ->
approve -> read approved spec -> read declared files -> author fix bundle ->
write fix bundle -> build to review -> status -> read current branch -> review
-> complete -> final status -> handoff -> package draft PR outbox -> adapter
push.

There are no translation projection steps. `scafld handoff` is the human handoff
surface, `scafld build` is the validation/check surface, and `scafld review` is
the native review boundary.

## Quality Profile

- Purpose: turn one bounded thread-driven change into a visible, reviewable
  draft PR through native scafld 2.4 surfaces.
- Audience: maintainers reviewing the issue, spec, code change, native review,
  handoff, and draft PR.
- Artifact contract: markdown scafld spec, authored change bundle, build
  build-to-review result, review result, completed status, handoff markdown,
  draft PR packet, outbox entry, and receipt trail.
- Evidence bar: every spec objective, file impact, validation command, and PR
  claim must trace to the thread, repo snapshot, scafld state, or actual
  working-tree change.
- Stop conditions: return `needs_resolution` when authoring evidence is
  missing; return a blocked fix bundle only when no concrete repo-relative
  target is declared, a required existing file cannot be read, or the requested
  behavior cannot be inferred without inventing requirements.

## Spec Authoring Contract

The `issue-to-pr-author-spec` boundary must emit a full scafld 2.0 markdown
document, not YAML and not a reduced project brief.

The document must preserve front matter with:

- `spec_version: '2.0'`
- `task_id`
- `created`: ISO-8601 timestamp
- `updated`: ISO-8601 timestamp
- `title`: non-empty task title, normally `thread_title`
- `status: draft`
- `harden_status: not_run`
- `size`: one of `small`, `medium`, or `large`
- `risk_level`

The body must include the standard scafld 2 sections: Current State, Summary,
Context, Objectives, Scope, Dependencies, Assumptions, Touchpoints, Risks,
Acceptance, at least one Phase section, Rollback, Review, Self Eval,
Deviations, Metadata, Origin, Harden Rounds, and Planning Log.

The graph normalizes the front matter before writing the spec so current scafld
schema fields such as `title` and size stay deterministic even if the authoring
boundary omits or stales them.

All changed-file declarations must use concrete repo-relative paths in
backticks under Context / Files impacted and Phase / Changes. Do not declare
scafld-managed control-plane artifacts under `.scafld/specs`,
`.scafld/reviews`, `.scafld/runs`, or old `.ai` governance paths as repo-change
scope.

Documentation and process requests still need a concrete repo file. Prefer
existing docs surfaces supplied by `repo_snapshot.existing_files` or
`repo_context`, and declare at least one non-governance repo file for an
approved `issue-to-pr` lane. Do not leave the repo-change scope empty after the
triage layer has approved a PR.

Validation commands must run against the current workspace state after the fix
bundle is written. Do not depend on git history ranges such as `HEAD~1` or
merge-base comparisons. Validation commands, when present, must be direct
repo-local checks such as test, lint, build, or file-content commands. Never use
runx skill runner internals or `skills/scafld/run.mjs` as a validation command;
scafld is already the lifecycle runner around the task.

## Fix Authoring Contract

The `issue-to-pr-apply-fix` boundary must emit a bounded `fix_bundle` with
`files: [{ path, contents }]` for every repo file needed to satisfy the approved
spec. For documentation or process changes, the approved spec, source thread,
repo snapshot, repo context, and declared file contents are sufficient when they
identify a narrow edit.

If a declared file has `exists: false` and the approved spec intentionally
creates it, write the new file when the desired contents are inferable from the
spec and thread. Do not block solely because the file has no prior contents.

Return `fix_bundle.status: blocked` with `files: []` only when no concrete
repo-relative target is declared, a required existing file cannot be read, or
the requested behavior cannot be inferred. The blocked reason must name the
missing evidence and path because an empty file bundle is a terminal policy
denial before `write-fix`.

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
- `size`: scafld size, default `small`.
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

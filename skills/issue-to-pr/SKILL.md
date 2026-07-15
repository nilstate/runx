---
name: issue-to-pr
description: Govern a scafld-backed issue-to-PR lane with native scafld review and handoff surfaces.
runx:
  category: code
---

# Issue to PR

Drive one bounded thread-driven change through the scafld 2.4-compatible
lifecycle and package the result as a provider-agnostic draft pull-request
packet.

The graph separates cognition from mutation. Agent phases author the scafld
markdown spec and the bounded repo change bundle. Deterministic `fs.write` and
`fs.write_bundle` phases are the only places files are written to disk. scafld
owns the workflow kernel: `plan`, `validate`, `approve`, `build_to_review`,
`status`, `review`, `complete`, and `handoff`. runx owns the explicit authoring
boundaries, deterministic writes, receipts, and final outbox packaging.

Branch creation and provider PR mutation are outside scafld. The caller or
adapter prepares the branch, then passes the intended branch into this lane.
The lane records that branch in the draft PR packet, and the GitHub adapter
fails closed if the workspace checkout does not match it. The final
`issue-to-pr-push-outbox` step is the only provider push boundary.

## Lifecycle

The graph runs:

`scafld plan` -> author markdown spec -> write spec -> read spec -> validate ->
approve -> read approved spec -> read declared files -> author fix bundle ->
write fix bundle -> build to review -> status -> read current branch -> review
-> complete -> final status -> handoff -> package draft PR outbox -> adapter
push.

There are no translation projection steps. `scafld handoff` is the human handoff
surface, `build_to_review` drives bounded native `scafld build` advances until
the task is review-ready, and `scafld review` is the native review boundary.

## Thread Story

The lane should leave one coherent source-thread story, not a stream of every
internal event. The durable milestones are:

- source signal and the bounded request
- accountable decision that a PR is justified
- scafld spec approval and declared scope
- build and validation result
- adversarial review result
- draft PR publication
- human merge gate
- final provider outcome when observed

Comments and PR bodies should summarize those gates with enough evidence for a
reviewer to act. They must not publish raw local paths, secrets, full command
dumps, or duplicate retry comments. User-facing labels should use plain terms
such as spec authoring, fix authoring, review, and human merge gate.


## Spec Authoring Contract

The `issue-to-pr-author-spec` boundary must emit a full scafld
2.4-compatible markdown document, not YAML and not a reduced project brief.

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
decision layer has approved a PR.

Validation commands must run against the current workspace state after the fix
bundle is written. Do not depend on git history ranges such as `HEAD~1` or
merge-base comparisons. Validation commands, when present, must be direct
repo-local checks such as test, lint, build, or file-content commands. Never use
runx runtime internals or `graph/scafld/run.mjs` as a validation command;
scafld is already the lifecycle runner around the task.

For any code change, the approved spec must declare at least one targeted
test/spec file in the changed-file scope and include at least one executable
validation command that exercises that target. This applies even when the source
thread does not explicitly request coverage; code PRs are not publishable from
this lane without targeted test/spec scope or grounded scafld validation
evidence. If the source thread asks for tests, specs, regression coverage,
focused coverage, or request/service coverage, the targeted coverage requirement
cannot be softened to a generic smoke check. If no existing test/spec path is
declared but the repository layout makes a conventional path inferable, declare
that new test/spec file. If no grounded test/spec path or command can be
inferred from the repo snapshot, stop with a missing-evidence reason instead of
publishing a code-only PR.

Preserve source-thread context in the spec's Summary, Origin, and Planning Log
so later PR packaging can explain why the lane ran and what evidence justified
the mutation.

## Fix Authoring Contract

The `issue-to-pr-apply-fix` boundary must emit a bounded `fix_bundle` with
`files: [{ path, contents }]` for every repo file needed to satisfy the approved
spec. For documentation or process changes, the approved spec, source thread,
repo snapshot, repo context, and declared file contents are sufficient when they
identify a narrow edit.

When `repo_snapshot.recommended_files` contains concrete repo-relative files,
treat those files as actionable target evidence even if the generated spec is
worded conservatively. Read the recommended file and the nearest relevant test
or spec before blocking. If the source thread includes a runtime exception,
backtrace, failing command, or named behavior and the recommended file exists,
prefer the smallest conventional fix plus targeted regression coverage over an
empty bundle.

For any production code change, `fix_bundle.files` must include the smallest
production fix and a targeted test/spec file, even when the source request does
not explicitly ask for coverage. Do not publish a code-only fix bundle from this
lane. If the approved spec, source thread, or acceptance criteria asks for
tests, specs, regression coverage, focused coverage, or request/service
coverage, the targeted test/spec file must directly cover that requested
behavior. If no test file exists, create the narrow conventional test file when
the repository structure makes that path inferable; otherwise block with the
missing path and evidence reason.

If a declared file has `exists: false` and the approved spec intentionally
creates it, write the new file when the desired contents are inferable from the
spec and thread. Do not block solely because the file has no prior contents.

Return `fix_bundle.status: blocked` with `files: []` only when no concrete
repo-relative target is declared, a required existing file cannot be read, or
the requested behavior cannot be inferred after inspecting the supplied target
files. The blocked reason must name the missing evidence and path because an
empty file bundle is a terminal policy denial before `write-fix`.

## Inputs

- `task_id`: scafld task id.
- `thread_title`: canonical title and default spec title.
- `thread_body`: full thread body or request text when available.
- `thread_locator`: canonical locator for the bounded thread.
- `thread`: portable thread for the current signal surface.
- `outbox_entry`: existing pull-request outbox entry when refreshing a draft.
- `harness`: optional `runx.harness.v1` packet for the governed run boundary.
- `signal`: optional `runx.signal.v1` packet. Preserve source references,
  fingerprint, authenticity, and evidence references as stateful context
  instead of reparsing source-thread prose.
- `decision`: optional `runx.decision.v1` packet. Preserve the accountable
  selection rationale, selected act, and closure when the caller already made
  the lane decision.
- `target_repo`: intended repository slug for PR packaging.
- `operational_policy`: optional `runx.operational_policy.v1` packet used to
  admit the source, target repo, runner, and source-thread route before PR
  packaging.
- `source_id`: optional operational policy source id.
- `runner_id`: optional operational policy runner id.
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
- Story metadata suitable for one source-thread reviewer update that summarizes
  the lifecycle gates and points at the human merge decision.

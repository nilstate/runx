---
spec_version: '2.0'
task_id: issue-to-pr-review-diagnostics
created: '2026-05-13T02:28:53Z'
updated: '2026-05-13T02:34:10Z'
status: completed
harden_status: passed
size: small
risk_level: low
---

# Surface issue-to-PR review gate diagnostics

## Current State

Status: completed
Current phase: final
Next: done
Reason: task completed
Blockers: none
Allowed follow-up command: `none`
Latest runner update: 2026-05-13T02:34:10Z
Review gate: pass

## Summary

When `scafld review --json` exits nonzero or emits provider progress without a
JSON payload, the runx scafld runner currently lets the graph failure collapse
to opaque provider log lines such as `scafld review[command] started...`. That
hides the native review verdict and findings from the issue-to-PR source thread.

Update the scafld runner so review commands recover the native review state from
`scafld status <task-id> --json` whenever the review stdout is not parseable,
including nonzero review exits. The runner must still fail closed on nonzero
review exit codes, but its failure stderr must summarize the recovered verdict
and blocking findings so upstream workflows can post actionable gate state to
GitHub, Slack, Sentry, or any other source thread.

## Objectives

- Preserve the existing successful review fallback for scafld 2.4 command
  reviewers that exit zero but omit native JSON.
- Add failed review recovery for nonzero `scafld review` exits that still leave
  native review state available through `scafld status --json`.
- Keep security fail-closed: a failed review must still return a nonzero process
  exit and must not allow `issue-to-pr` to continue to PR creation.
- Replace opaque provider-progress failure text with a bounded, human-actionable
  summary including verdict and finding ids/summaries.
- Keep the packaged `packages/cli/skills/scafld/run.mjs` mirror in sync with the
  canonical `skills/scafld/run.mjs` runner.

## Scope

- `skills/scafld/run.mjs`
- `packages/cli/skills/scafld/run.mjs`
- `tests/scafld-skill.test.ts`

## Dependencies

- scafld 2.4 review/status JSON contract.
- Existing runx local skill runtime tests for the scafld skill.

## Assumptions

- `scafld status --json` is the source of truth for recovered review state after
  a provider command runs.
- The runner may write a concise synthetic failure summary to stderr when the
  review failed but status recovery succeeded.
- No compatibility aliases or legacy contracts are introduced.

## Touchpoints

- scafld runner subprocess exit behavior.
- issue-to-PR graph failure diagnostics consumed by repo-local wrappers such as
  Nitrosend issue intake.

## Risks

- Incorrectly treating a failed review as successful would violate the human
  merge gate. Mitigation: preserve the original nonzero exit code.
- Overly verbose stderr could leak excess provider text into source threads.
  Mitigation: summarize only verdict and bounded findings from native status.

## Acceptance

Profile: standard

Validation:
- `pnpm exec vitest run --config vitest.config.ts tests/scafld-skill.test.ts`
- `pnpm build`
- `git diff --check`

## Phase 1: Implementation

Status: completed
Dependencies: none

Objective: Complete the requested change.

Changes:
- Update review JSON fallback to attempt status recovery for all unparseable `review` stdout cases.
- Preserve exit code semantics while emitting recovered JSON to stdout and a concise review-gate failure summary to stderr when the review failed.
- Add regression coverage for a fake scafld review that exits nonzero, emits only provider progress, and exposes review findings through status.

Acceptance:
- [x] `ac1` command - targeted scafld skill regression
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/scafld-skill.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-6
- [x] `ac2` command - package build
  - Command: `pnpm build`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-7
- [x] `ac3` command - whitespace validation
  - Command: `git diff --check`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-8

## Rollback

- Revert the scafld runner and targeted test changes.

## Review

Status: completed
Verdict: pass
Mode: discover
Provider: codex
Output: codex.output_file
Summary: No completion-blocking findings found. The runner now recovers review state from `status --json` for unparseable review output even on nonzero review exits, preserves fail-closed exit semantics, emits bounded actionable failure diagnostics, and the packaged runner mirror matches the canonical runner. Acceptance evidence was treated as already executed per the read-only review instruction.

Attack log:
- `workspace task scope`: Scope and diff audit -> clean (Compared the declared task scope with `git diff` and `git status --short`. Tracked task changes are limited to `skills/scafld/run.mjs` and `tests/scafld-skill.test.ts`; `.scafld/specs/active/` is governance state, and the packaged runner was byte-identical to the canonical runner.)
- `packages/cli/skills/scafld/run.mjs`: Canonical/package parity -> clean (Ran `cmp -s skills/scafld/run.mjs packages/cli/skills/scafld/run.mjs`; exit code was 0, satisfying the explicit mirror requirement even though the package copy did not appear separately in `git diff`.)
- `skills/scafld/run.mjs:175`: Fallback trigger correctness -> clean (Reviewed `skills/scafld/run.mjs` parse path: fallback runs only after JSON parsing fails and only for `command === "review"`, so native JSON forwarding for successful review output remains first path.)
- `skills/scafld/run.mjs:179`: Failed-review recovery behavior -> clean (Reviewed the new nonzero path: when review stdout is unparseable and `status --json` recovery succeeds, the runner emits the recovered structured review envelope while preserving the original nonzero exit code.)
- `skills/scafld/run.mjs:382`: Failure diagnostic quality -> clean (Reviewed `summarizeRecoveredReviewFailure`; it includes exit code, recovered verdict, and up to three bounded finding id/summary entries, and suppresses opaque provider progress stderr when a recovered summary exists.)
- `skills/issue-to-pr/X.yaml:523`: Status payload shape and downstream contract -> clean (Traced recovered output into `issue-to-pr` and PR packaging. The fallback places `verdict` and `findings` at `scafld-review.result`, which is what `skills/issue-to-pr/X.yaml` passes to `outbox.build_pull_request` and what that tool reads for review gate metadata.)
- `tests/scafld-skill.test.ts:364`: Regression coverage -> clean (Reviewed the added Vitest case. The fake scafld exits nonzero from `review`, emits only command-review progress, exposes a failing review via `status`, and asserts failure status, recovered stdout, actionable stderr, and no provider progress leakage.)
- `acceptance evidence`: Recorded acceptance evidence -> skipped (Per provider instruction, did not rerun build/test/mutation commands. The packet records passing targeted Vitest, `pnpm build`, and `git diff --check` evidence. Attempted read-only `./bin/scafld status issue-to-pr-review-diagnostics --json`, but this checkout has no `./bin/scafld` wrapper.)

Findings:
- none

## Self Eval

- none

## Deviations

- none

## Metadata

- created_by: scafld

## Origin

Created by: scafld
Source: plan

## Harden Rounds

### round-1

Status: passed
Started: 2026-05-13T02:29:28Z
Ended: 2026-05-13T02:30:13Z

Checks:
- path audit
  - Grounded in: code:skills/scafld/run.mjs:171
  - Result: passed
  - Evidence: Scope is limited to the scafld skill runner mirror and targeted
- command audit
  - Grounded in: code:tests/scafld-skill.test.ts:284
  - Result: passed
  - Evidence: Acceptance uses the targeted scafld skill test, full package
- scope/migration audit
  - Grounded in: code:skills/scafld/run.mjs:169
  - Result: passed
  - Evidence: No legacy aliases, compatibility names, schema migration, or
- acceptance timing audit
  - Grounded in: code:skills/scafld/run.mjs:179
  - Result: passed
  - Evidence: Validation runs after code and test edits, before scafld review
- rollback/repair audit
  - Grounded in: code:skills/scafld/run.mjs:336
  - Result: passed
  - Evidence: Reverting the two runner files and the regression test restores
- design challenge
  - Grounded in: spec_gap:assumptions
  - Result: passed
  - Evidence: A failed review must remain a failed runx step. The change only

Questions:
- Should nonzero review recovery ever exit zero when the recovered status has a
  - Grounded in: code:skills/scafld/run.mjs:179
  - Recommended answer: No. Preserve the original scafld review exit code
  - Answered with: Preserve the original nonzero exit code.


## Planning Log

- none

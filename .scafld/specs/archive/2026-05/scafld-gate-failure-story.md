---
spec_version: '2.0'
task_id: scafld-gate-failure-story
created: '2026-05-13T02:56:33Z'
updated: '2026-05-13T03:00:36Z'
status: completed
harden_status: passed
size: small
risk_level: low
---

# Expose scafld gate failure summaries

## Current State

Status: completed
Current phase: final
Next: done
Reason: task completed
Blockers: none
Allowed follow-up command: `none`
Latest runner update: 2026-05-13T03:00:36Z
Review gate: pass

## Summary

Make the runx scafld skill preserve actionable gate summaries when native
`scafld review` or `scafld complete` exits non-zero after emitting a parseable
JSON payload. The current wrapper only summarizes recovered status-fallback
failures; when scafld emits valid JSON and also exits non-zero, the wrapper
forwards stderr unchanged. In live issue-to-PR, that stderr can be command
review progress text, hiding the actual blocking finding from the source
thread.

## Objectives

- Summarize parseable non-zero `review` and `complete` JSON the same way the wrapper summarizes status-fallback failures.
- Keep stdout as the native scafld JSON payload so downstream graph artifact parsing remains unchanged.
- Keep existing status-fallback behavior and error wording stable where it is already tested.
- Add regression coverage for parseable `complete` failure JSON with stale provider-progress stderr.

## Scope

- `skills/scafld/run.mjs`
- `tests/scafld-skill.test.ts`

Out of scope:

- Changing scafld itself.
- Changing issue-to-PR graph topology.
- Changing public runx contracts or skill names.

## Dependencies

- Existing scafld skill tests and fake scafld harnesses.
- `pnpm exec vitest run --config vitest.config.ts tests/scafld-skill.test.ts`
- `pnpm build`

## Assumptions

- scafld may validly emit JSON to stdout while returning a non-zero exit code for a failed review or complete gate.
- Graph-level failure reporting uses the failed step stderr as the visible error summary.
- Replacing stale provider progress stderr with a bounded review/complete summary is safer than forwarding opaque logs.

## Touchpoints

- `skills/scafld/run.mjs`: failure-summary behavior for native scafld commands.
- `tests/scafld-skill.test.ts`: regression coverage for non-zero parseable complete JSON.

## Risks

- Overwriting useful stderr: bounded summaries should only replace stderr for non-zero `review`/`complete` failures that have structured scafld state.
- Hidden parse failures: status-fallback tests must remain in place to keep unparseable native output covered.

## Acceptance

Profile: standard

Validation:
- `pnpm exec vitest run --config vitest.config.ts tests/scafld-skill.test.ts`
- `pnpm build`
- `git diff --check`

Acceptance criteria:
- [ ] Non-zero `scafld complete --json` with parseable JSON and stale provider stderr exits non-zero and emits a bounded stderr summary containing status, review verdict, and finding id/summary.
- [ ] Existing recovered status-fallback review and complete tests continue to pass.
- [ ] Native stdout remains structured JSON for downstream graph artifacts.
- [ ] No legacy aliases, compatibility paths, or broad runtime changes are introduced.

## Phase 1: Implementation

Status: completed
Dependencies: none

Objective: Update the scafld wrapper and tests.

Changes:
- Add a summary path for parseable non-zero review/complete payloads.
- Keep recovered status-fallback wording for unparseable non-zero review/complete payloads.
- Add a focused regression test.

Acceptance:
- [x] `ac1` command - Targeted scafld wrapper tests
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/scafld-skill.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-6
- [x] `ac2` command - Package build
  - Command: `pnpm build`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-7
- [x] `ac3` command - Diff hygiene
  - Command: `git diff --check`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-8

## Rollback

- Revert `skills/scafld/run.mjs` and `tests/scafld-skill.test.ts` changes.
- Re-run the targeted scafld wrapper tests.

## Review

Status: completed
Verdict: pass
Mode: discover
Provider: codex
Output: codex.output_file
Summary: No completion-blocking issues found. The change satisfies the scoped objective: parseable nonzero `review`/`complete` JSON now produces a bounded actionable stderr summary while preserving native JSON stdout and existing recovered status-fallback wording.

Attack log:
- `task scope and workspace drift`: Scoped diff review -> clean (Reviewed `git diff -- skills/scafld/run.mjs tests/scafld-skill.test.ts`; implementation changes are confined to declared task scope. `git diff --name-only` lists only those two files. `git status --short` also shows the active scafld spec as untracked, but it is lifecycle context rather than task implementation drift.)
- `skills/scafld/run.mjs`: Parseable nonzero gate path -> clean (Reviewed `skills/scafld/run.mjs:173-220`. For parseable nonzero `review`/`complete` JSON, the wrapper now builds `scafldFailureSummary`, writes the parsed native JSON to stdout, writes the bounded summary to stderr, and exits with the native exit code.)
- `skills/scafld/run.mjs`: Status-fallback regression path -> clean (Reviewed `skills/scafld/run.mjs:178-198` and `391-418`. Unparseable `review`/`complete` output still uses `statusFallback` and preserves the `recovered status=...` wording only when `result.recovered_from_status` is present.)
- `skills/scafld/run.mjs`: Summary content extraction -> clean (Reviewed `skills/scafld/run.mjs:391-418`. The summary reports command, exit code, status, review verdict, and up to three finding id/summary entries, with `boundedLine` limiting output length.)
- `skills/scafld/run.mjs; tests/scafld-skill.test.ts`: Stdout contract preservation -> clean (Reviewed `skills/scafld/run.mjs:210-213` and the new test assertions at `tests/scafld-skill.test.ts:633-650`. Structured stdout remains the native scafld JSON envelope, reserialized as before, so downstream JSON parsing is unchanged.)
- `tests/scafld-skill.test.ts`: Regression coverage -> clean (Reviewed `tests/scafld-skill.test.ts:570-660`. The added regression covers parseable nonzero `complete` JSON with stale provider-progress stderr and verifies the actionable finding summary replaces stale stderr while preserving failure status and JSON stdout.)
- `skills/scafld/run.mjs; tests/scafld-skill.test.ts`: Review command symmetry -> clean (The implementation condition is shared for `command === "review" || command === "complete"` at `skills/scafld/run.mjs:202`, so the parseable nonzero path applies to both requested gates. Existing fallback review coverage remains at `tests/scafld-skill.test.ts:410-464`.)
- `acceptance evidence`: Acceptance evidence check -> clean (Per provider instruction, did not rerun tests or builds. Reviewed recorded acceptance evidence: targeted Vitest, `pnpm build`, and `git diff --check` all passed with exit code 0.)

Findings:
- none

## Self Eval

- pending

## Deviations

- none

## Metadata

- created_by: scafld
- source: live Nitrosend issue-to-PR dogfood

## Origin

Created by: scafld
Source: plan

## Harden Rounds

### round-1

Status: passed
Started: 2026-05-13T02:57:27Z
Ended: 2026-05-13T02:57:54Z

Checks:
- path audit
  - Grounded in: code:skills/scafld/run.mjs:173
  - Result: passed
  - Evidence: The behavior is isolated to the scafld skill wrapper where structured JSON parsing and stderr forwarding happen.
- command audit
  - Grounded in: code:tests/scafld-skill.test.ts:467
  - Result: passed
  - Evidence: Existing wrapper tests already model failed complete-gate recovery and can host the new parseable-nonzero regression.
- scope/migration audit
  - Grounded in: code:skills/issue-to-pr/X.yaml:485
  - Result: passed
  - Evidence: The issue-to-PR graph already delegates review and complete to the scafld skill; no graph contract, migration, alias, or public API change is required.
- acceptance timing audit
  - Grounded in: code:tests/scafld-skill.test.ts:457
  - Result: passed
  - Evidence: Acceptance can be verified before publish by asserting stderr contains the bounded gate summary and excludes stale provider-progress text.
- rollback/repair audit
  - Grounded in: code:skills/scafld/run.mjs:208
  - Result: passed
  - Evidence: Rollback is a single wrapper/test revert; the prior behavior is localized to the existing summary-or-stderr branch.
- design challenge
  - Grounded in: code:skills/scafld/run.mjs:202
  - Result: passed
  - Evidence: The design keeps stdout as the native scafld JSON payload and only changes the visible stderr summary on non-zero review/complete exits.

Questions:
- none


## Planning Log

- 2026-05-13: Live issue-to-PR source thread showed only command-review progress lines even though the failing gate needed actionable review findings.

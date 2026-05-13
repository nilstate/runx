---
spec_version: '2.0'
task_id: scafld-complete-gate-diagnostics
created: '2026-05-13T02:40:26Z'
updated: '2026-05-13T02:44:47Z'
status: completed
harden_status: passed
size: small
risk_level: low
---

# Surface scafld complete gate diagnostics

## Current State

Status: completed
Current phase: final
Next: done
Reason: task completed
Blockers: none
Allowed follow-up command: `none`
Latest runner update: 2026-05-13T02:44:47Z
Review gate: pass

## Summary

Extend the scafld runner status recovery added for review to the `complete`
gate. Live issue-to-PR runs can pass through `scafld review` with a recorded
failing verdict, then fail at `scafld complete`. When complete emits only prior
provider progress text, the source thread still sees opaque review log lines.
The complete gate should recover `scafld status --json`, preserve the nonzero
exit, and emit a bounded status/review finding summary.

## Objectives

- Recover status JSON for unparseable `complete` output.
- Preserve fail-closed nonzero complete exits.
- Surface current scafld status, review verdict, and top findings in stderr.
- Keep the existing successful review recovery behavior unchanged.

## Scope

- `skills/scafld/run.mjs`
- `packages/cli/skills/scafld/run.mjs`
- `tests/scafld-skill.test.ts`

## Dependencies

- Existing scafld runner status fallback helper.
- scafld 2.4 `status --json` review payload.

## Assumptions

- `complete` failures after review should not continue the graph.
- `status --json` is safe to read after a failed complete attempt.
- No public input schema or legacy alias is needed.

## Touchpoints

- scafld `complete` subprocess failure diagnostics in runx graph receipts.

## Risks

- Accidentally normalizing a blocked complete gate to success would bypass the
  human review gate. Mitigation: preserve the original exit code.

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
- Generalize review status fallback enough to recover complete failures too.
- Add complete-gate regression coverage using a fake scafld that exits nonzero, omits JSON, and exposes a failed review through status.

Acceptance:
- [x] `ac1` command - scafld skill tests
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/scafld-skill.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-6
- [x] `ac2` command - build
  - Command: `pnpm build`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-7
- [x] `ac3` command - diff check
  - Command: `git diff --check`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-8

## Rollback

- Revert the runner/test changes.

## Review

Status: completed
Verdict: pass
Mode: discover
Provider: codex
Output: codex.output_file
Summary: No completion-blocking issues found. The implementation recovers `complete` parse failures through `status --json`, preserves the failing exit, emits bounded review/status diagnostics, suppresses opaque provider-progress stderr on recovered failures, and keeps existing review recovery covered.

Attack log:
- `workspace classification`: Scope and workspace drift check -> clean (Inspected `git status --short`, scoped diff, and diff stat. Tracked task changes are limited to `skills/scafld/run.mjs` and `tests/scafld-skill.test.ts`; `.scafld/specs/active/` is present as governance state. Read-only sandbox caused macOS git cache warnings, but commands returned usable output.)
- `skills/scafld/run.mjs`: Complete fallback trigger path -> clean (Reviewed `skills/scafld/run.mjs:175-199`; fallback is only attempted when JSON parsing fails for `review` or `complete`, matching the requested complete-gate recovery without broadening unrelated commands.)
- `skills/scafld/run.mjs`: Fail-closed exit preservation -> clean (Reviewed `skills/scafld/run.mjs:171` and `skills/scafld/run.mjs:214`; recovered status output does not rewrite the subprocess exit code, so nonzero `complete` remains nonzero.)
- `skills/scafld/run.mjs`: Recovered diagnostics content -> clean (Reviewed `skills/scafld/run.mjs:383-407`; the stderr summary includes command, exit code, recovered status, review verdict, and up to three finding summaries, bounded through `boundedLine`.)
- `skills/scafld/run.mjs`: Opaque provider progress suppression -> clean (Reviewed `skills/scafld/run.mjs:202-211`; when a recovered failure summary exists, raw stderr is not replayed. This addresses the source-thread opacity case while leaving native stderr intact for non-recovered paths.)
- `tests/scafld-skill.test.ts`: Regression coverage for complete gate -> clean (Reviewed `tests/scafld-skill.test.ts:467-568`; the fake scafld exits nonzero for `complete`, emits no JSON, exposes failed review details through `status --json`, and assertions cover stdout recovery, failure status, diagnostic content, and provider-progress suppression.)
- `tests/scafld-skill.test.ts`: Existing review recovery regression -> clean (Reviewed the adjacent review-failure test updates at `tests/scafld-skill.test.ts:430-464`; the existing review fallback behavior remains covered with the new `recovered status=review` wording.)
- `packages/cli/skills/scafld/run.mjs`: Packaged skill copy consistency -> clean (Compared `skills/scafld/run.mjs` with `packages/cli/skills/scafld/run.mjs`; files are byte-identical in the workspace. `packages/cli/skills/scafld/run.mjs` is generated/untracked relative to HEAD, so the tracked source diff remains the primary review target.)
- `acceptance commands`: Acceptance rerun policy -> skipped (Provider instruction says review is read-only and not to run build, test, or mutation commands. Treated recorded `pnpm exec vitest`, `pnpm build`, and `git diff --check` evidence as already executed.)

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
Started: 2026-05-13T02:40:26Z
Ended: 2026-05-13T02:41:26Z

Checks:
- path audit
  - Grounded in: code:skills/scafld/run.mjs:175
  - Result: passed
  - Evidence: Scope remains inside the scafld runner and targeted test.
- command audit
  - Grounded in: code:tests/scafld-skill.test.ts:364
  - Result: passed
  - Evidence: The existing targeted scafld runner tests are the correct
- scope/migration audit
  - Grounded in: spec_gap:scope
  - Result: passed
  - Evidence: No contract rename, compatibility alias, or provider mutation is
- acceptance timing audit
  - Grounded in: spec_gap:acceptance
  - Result: passed
  - Evidence: Acceptance runs after implementation and before review/complete.
- rollback/repair audit
  - Grounded in: spec_gap:rollback
  - Result: passed
  - Evidence: Reverting the runner/test changes restores previous behavior.
- design challenge
  - Grounded in: spec_gap:assumptions
  - Result: passed
  - Evidence: Complete recovery must improve diagnostics only and keep nonzero

Questions:
- none


## Planning Log

- none

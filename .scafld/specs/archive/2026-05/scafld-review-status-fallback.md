---
spec_version: '2.0'
task_id: scafld-review-status-fallback
created: '2026-05-13T02:14:27Z'
updated: '2026-05-13T02:18:13Z'
status: completed
harden_status: passed
size: small
risk_level: medium
---

# Recover scafld review JSON from status

## Current State

Status: completed
Current phase: final
Next: done
Reason: task completed
Blockers: none
Allowed follow-up command: `none`
Latest runner update: 2026-05-13T02:18:13Z
Review gate: pass

## Summary

Make the runx scafld skill tolerate the scafld 2.4.0 command-review surface
seen in live Nitrosend issue intake: `scafld review --json` can complete a
provider command without emitting a parseable review JSON envelope. When the
native review command exits successfully but stdout is not JSON, recover the
review verdict from `scafld status --json` instead of failing the graph.

## Objectives

- Preserve native scafld JSON forwarding whenever `scafld review --json`
  already emits a JSON envelope.
- Add a narrow review-only fallback that calls `scafld status <task> --json`
  after a successful non-JSON review.
- Keep non-zero review failures failing closed.
- Cover the fallback with a regression test using a fake scafld 2.4.0-style
  command-review output.

## Scope

- `skills/scafld/run.mjs`
- `tests/scafld-skill.test.ts`

## Dependencies

- Nitrosend live issue #140 exposed the failure while running `issue-to-pr`
  through scafld 2.4.0 command review.

## Assumptions

- `status --json` is the source of truth for review verdict after a successful
  review command, consistent with the scafld contract.
- The fallback must not synthesize a pass when scafld review exits non-zero.

## Touchpoints

- scafld skill JSON parsing.
- issue-to-pr graph review step.
- PR packaging reads `scafld-review.result.verdict`.

## Risks

- Medium: over-broad fallback could mask failed review gates. Mitigation:
  only recover when command is `review` and native review exits zero.
- Low: status payload shape drift. Mitigation: keep the recovered envelope
  explicit and include the native `review` object.

## Acceptance

Profile: standard

Validation:
- [x] `v1` test - scafld and issue-to-pr targeted tests pass.
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/scafld-skill.test.ts tests/issue-to-pr-graph.test.ts tests/scafld-issue-to-pr-parser.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-6
- [x] `v2` build - package build succeeds.
  - Command: `pnpm build`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-7
- [x] `v3` command - syntax check passes.
  - Command: `node --check skills/scafld/run.mjs`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-8
- [x] `v4` command - whitespace diff check is clean.
  - Command: `git diff --check`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-9

## Phase 1: Implementation

Status: active
Dependencies: none

Objective: Add review status recovery to the scafld runner

Changes:
- Add a `reviewStatusFallback` helper in `skills/scafld/run.mjs`.
- Call the fallback only when `command === "review"`, stdout JSON parsing fails, and native scafld exits zero.
- Add a regression test for scafld 2.4.0 command-review logs with no JSON.

Acceptance:
- [x] `ac1` test - targeted regression suite passes.
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/scafld-skill.test.ts tests/issue-to-pr-graph.test.ts tests/scafld-issue-to-pr-parser.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0; 3 files and 12 tests passed.

## Rollback

- Revert `skills/scafld/run.mjs` and the regression test. The failure mode
  returns to failing issue-to-pr when scafld review omits JSON.

## Review

Status: completed
Verdict: pass
Mode: discover
Provider: codex
Output: codex.output_file
Summary: No completion-blocking findings found. The implementation preserves native review JSON forwarding, adds a review-only zero-exit fallback through status --json, keeps non-zero review failures fail-closed, and includes a targeted regression test for the scafld 2.4.0 command-review no-JSON output shape. Acceptance commands were not rerun because the review packet explicitly required read-only review and supplied passing evidence.

Attack log:
- `workspace scope`: scope_and_diff_audit -> clean (Inspected git diff for declared scope. Tracked implementation changes are limited to skills/scafld/run.mjs and tests/scafld-skill.test.ts; no unrelated tracked task drift found.)
- `skills/scafld/run.mjs:173`: native_json_preservation -> clean (Verified the existing parseJsonPayload path remains first: review stdout that contains a parseable JSON envelope is forwarded before fallback can run.)
- `skills/scafld/run.mjs:177`: fallback_gate_narrowness -> clean (Verified fallback is only attempted when command is review, stdout JSON parsing fails, and native review exitCode is 0.)
- `skills/scafld/run.mjs:178`: nonzero_failure_closed -> clean (Verified non-zero review failures with non-JSON stdout do not enter fallback and exit with the native non-zero code after stderr forwarding.)
- `skills/scafld/run.mjs:336`: status_fallback_contract -> clean (Reviewed reviewStatusFallback: it calls scafld status <task> --json, parses the status JSON through the same parser, unwraps result, and emits scafld-review.result.verdict from the native review object.)
- `tools/outbox/build_pull_request/src/index.ts:84`: downstream_verdict_path -> clean (Traced PR packaging consumer and confirmed it reads review_result.verdict, which the fallback places at scafld-review.result.verdict.)
- `tests/scafld-skill.test.ts:284`: regression_test_coverage -> clean (Reviewed the added fake scafld 2.4.0-style test. It exercises successful command-review logs with no JSON and asserts recovered result.verdict, findings, review object, and recovered_from_status marker.)
- `acceptance evidence`: acceptance_rerun_policy -> skipped (Per provider instruction, did not rerun build/test/mutation commands; treated recorded acceptance evidence as already executed. Attempted read-only ./bin/scafld status, but this checkout has no ./bin/scafld wrapper.)

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
Started: 2026-05-13T02:14:59Z
Ended: 2026-05-13T02:15:29Z

Checks:
- path audit
  - Grounded in: code:skills/scafld/run.mjs:171
  - Result: passed
  - Evidence: The change is limited to the scafld skill wrapper and its
- command audit
  - Grounded in: code:tests/scafld-skill.test.ts:284
  - Result: passed
  - Evidence: Validation covers the exact non-JSON review output shape plus
- scope/migration audit
  - Grounded in: code:skills/scafld/run.mjs:169
  - Result: passed
  - Evidence: No migration or public skill input change is required; this is a
- acceptance timing audit
  - Grounded in: code:skills/scafld/run.mjs:179
  - Result: passed
  - Evidence: The fallback runs after native review exits successfully and
- rollback/repair audit
  - Grounded in: code:skills/scafld/run.mjs:336
  - Result: passed
  - Evidence: Reverting the helper and test restores the previous fail-closed
- design challenge
  - Grounded in: spec_gap:assumptions
  - Result: passed
  - Evidence: The fallback uses `status --json`, the scafld source of truth,

Questions:
- none


## Planning Log

- 2026-05-13 - Live Nitrosend issue #140 failed before PR creation. The
  issue-intake error showed only scafld command-review progress logs even
  though the provider command exited 0, indicating a native review JSON
  envelope was unavailable to runx.

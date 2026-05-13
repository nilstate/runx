---
spec_version: '2.0'
task_id: richer-thread-context
created: '2026-05-13T14:05:38Z'
updated: '2026-05-13T14:52:37Z'
status: completed
harden_status: not_run
size: small
risk_level: low
---

# Richer thread context projections

## Current State

Status: completed
Current phase: final
Next: done
Reason: task completed
Blockers: none
Allowed follow-up command: `none`
Latest runner update: 2026-05-13T14:52:37Z
Review gate: pass

## Summary

Keep the clean three-projection model, but make the PR reviewer packet more comprehensive. The packet should show meaty source/context/reasoning data from the scafld handoff without returning to raw full-handoff dumps, receipt IDs, logs, or duplicated comments.

## Objectives

- Add bounded contextual sections to the generic PR reviewer packet helper.
- Extract useful sections from `scafld handoff` into the visible PR body: context, objectives/scope, validation, review findings, and rollback when available.
- Preserve full handoff in `engineering_summary_markdown`.
- Keep visible PR body concise enough to scan and free of machine receipts/log dumps.

## Scope

- `packages/core/src/knowledge/thread-story.ts`
- `packages/core/src/knowledge/index.test.ts`
- `tools/outbox/build_pull_request/src/index.ts`
- `tests/outbox-build-pull-request-tool.test.ts`
- `skills/issue-to-pr/SKILL.md`
- generated manifest/lock updates if verify requires them

## Dependencies

- Existing runx core projection helpers.
- Existing scafld handoff markdown input.

## Assumptions

- PR body should include bounded handoff-derived context, not the entire raw handoff.
- Receipt identifiers and full logs remain evidence, not visible reviewer prose.

## Touchpoints

- `buildThreadPullRequestReviewerPacketMarkdown`
- `outbox.build_pull_request`
- issue-to-pr docs/tests

## Risks

- Over-enriching the packet can recreate noise. Mitigation: cap extracted sections and use named sections only.
- Under-enriching the packet leaves reviewers without state. Mitigation: include source, reasoning, scope, validation, review/risk, rollback, and next action.

## Acceptance

Profile: standard

Validation:
- [x] `v1` command - runx focused tests.
  - Command: `pnpm test:fast -- tests/outbox-build-pull-request-tool.test.ts packages/core/src/knowledge/index.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-15
- [x] `v2` command - runx verify.
  - Command: `pnpm verify:fast`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-16
- [x] `v3` command - diff hygiene.
  - Command: `git diff --check`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-17

## Phase 1: Richer Reviewer Packet

Status: completed
Dependencies: none

Objective: Add bounded but useful context to the visible PR reviewer packet.

Changes:
- Extend the core reviewer packet helper with optional context/scope/validation/review/rollback sections.
- Have `outbox.build_pull_request` extract those sections from the handoff and review/build payloads.
- Update tests and docs to require a comprehensive but non-noisy reviewer packet.

Acceptance:
- none

## Rollback

Revert this task's helper/tool/test/doc changes. The prior clean but thinner reviewer packet remains.

## Review

Status: completed
Verdict: pass
Mode: verify
Provider: codex
Output: codex.output_file
Summary: Review passed. The known validation-section leakage blocker is fixed: fenced logs and machine ledger/receipt identifiers are filtered before handoff-derived lines are rendered into the visible reviewer packet. The richer PR packet surfaces the requested context/scope/validation/review/rollback sections while preserving the full handoff in engineering_summary_markdown, and caller/test coverage matches the new projection contract. No completion-blocking findings remain.

Attack log:
- `tools/outbox/build_pull_request/src/index.ts:320`: Known blocker verification: ledger/log leakage -> clean (Verified the previous blocker is repaired: sectionToVisibleLines now skips fenced code block contents, and isVisibleHandoffLine filters Source event, Last attempt, Checked at, entry-* ids, receipt ids, rx_* and gx_* markers before values reach the visible PR body.)
- `tools/outbox/build_pull_request/src/index.ts:255`: Validation extraction path -> clean (Traced buildReviewPacketValidation through buildHandoffSectionLines and extractMarkdownSection for Validation and Acceptance sections; extracted lines are bounded and then sanitized by the core reviewer packet helper.)
- `tools/outbox/build_pull_request/src/index.ts:395`: Review-result accounting -> clean (Verified prior native scafld review finding counting remains fixed: reviewFindingCount counts blocks_completion true/false as blocking/non-blocking when explicit counts are absent.)
- `packages/core/src/knowledge/thread-story.ts:215`: Core packet rendering -> clean (Reviewed buildThreadPullRequestReviewerPacketMarkdown and appendBullets; new source context, scope, validation, review context, risks, and rollback sections are optional, bounded through sanitizeThreadStoryText, and preserve the human merge gate/evidence sections.)
- `@runxhq/core/knowledge callers and tests/issue-to-pr-graph.test.ts`: Regression and caller surface -> clean (Searched direct callers/importers of buildThreadPullRequestReviewerPacketMarkdown and outbox.build_pull_request; no incompatible helper call sites were introduced, and issue-to-pr graph coverage already expects the compact reviewer packet plus engineering_summary_markdown retention.)
- `tests/outbox-build-pull-request-tool.test.ts:9`: Test coverage adequacy -> clean (Reviewed focused tool/core tests. The outbox tool test now covers source context, scope, validation, review context, rollback, full handoff retention, and negative assertions for receipt ids, source-event metadata, checked timestamps, entry ids, and fenced log contents.)
- `workspace status`: Scope and ambient drift -> clean (Compared git status/diff stat against declared task scope. Task changes are in the scoped files; manifest/lock drift matches the context packet's ambient/generated classification and was not treated as a finding by itself.)
- `validation commands`: Acceptance evidence policy -> skipped (Did not rerun tests, builds, or mutation commands per provider instruction; treated recorded pnpm test:fast, pnpm verify:fast, and git diff --check evidence as already executed.)

Findings:
- none

## Self Eval

- Preserves the clean surface model while addressing missing reviewer context.
- Adds no provider-specific posting behavior.

## Deviations

- none

## Metadata

- created_by: scafld
- repo: runxhq/runx
- branch: codex/clean-thread-story-projections

## Origin

Created by: scafld
Source: user requested comprehensive but non-noisy issue/PR context.

## Harden Rounds

- none

## Planning Log

- 2026-05-14T00:10:00Z: Drafted after reviewing current PR packet helper and outbox packaging.

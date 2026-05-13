---
spec_version: '2.0'
task_id: thread-story-projection-core
created: '2026-05-13T09:21:25Z'
updated: '2026-05-13T09:58:11Z'
status: completed
harden_status: in_progress
size: medium
risk_level: medium
---

# Thread story projection helpers

## Current State

Status: completed
Current phase: final
Next: done
Reason: task completed
Blockers: none
Allowed follow-up command: `none`
Latest runner update: 2026-05-13T09:58:11Z
Review gate: pass

## Summary

Move the clean issue-to-PR communication shape into runx core as reusable projection helpers and make the generic PR packaging surface produce a concise reviewer packet instead of dumping the full native scafld handoff into the visible PR body. The full scafld handoff remains available as machine evidence on the draft pull request packet.

## Context

Current runx already has `buildThreadStoryMessageOutboxEntry` in `packages/core/src/knowledge/thread-story.ts`, and `skills/issue-to-pr/SKILL.md` describes source-thread story gates. The missing core piece is a disciplined projection shape:

- Slack/chat notifications should be milestone signals, not transcripts.
- Issue threads should have one managed status ledger comment updated in place.
- PR bodies should be the reviewer packet and final human merge gate.
- Raw receipts and long issue snapshots should remain metadata/evidence, not visible prose.

The generic outbox PR tool currently sets `pull_request.body_markdown` to `scafld handoff` directly. That makes each downstream wrapper solve the same reviewer-packet problem itself.

Files impacted:
- `packages/core/src/knowledge/thread-story.ts`
- `packages/core/src/knowledge/index.ts`
- `packages/core/src/knowledge/index.test.ts`
- `tools/outbox/build_pull_request/src/index.ts`
- `tests/outbox-build-pull-request-tool.test.ts`
- `skills/issue-to-pr/SKILL.md`
- generated tool package mirrors under `packages/cli/tools/outbox/build_pull_request/` if the workspace build updates them

## Objectives

- Add core helpers for concise status-ledger markdown and milestone notification text.
- Keep `buildThreadStoryMessageOutboxEntry` provider-agnostic and compatible with the existing GitHub/file thread adapters.
- Change `outbox.build_pull_request` so visible PR body defaults to a reviewer packet with summary, source, validation, risk/review, changed branch/base, rollback/handoff reference, and explicit human merge gate.
- Preserve full scafld handoff text on `draft_pull_request.engineering_summary_markdown`.
- Update issue-to-PR skill docs to state the clean three-projection model.

## Scope

In scope:
- Core knowledge projection helpers and exports.
- PR body packaging in `outbox.build_pull_request`.
- Tests proving compact issue/notification projections and reviewer-packet PR body output.
- Issue-to-PR skill prose that tells consumers how to use the projections.

Out of scope:
- Provider-specific Slack or GitHub API behavior.
- Nitrosend wrapper scripts.
- Changing thread adapter marker/envelope security behavior.
- Changing issue-to-pr graph topology or scafld lifecycle semantics.

## Dependencies

- Existing `OutboxEntry` and thread-story helper contracts in `@runxhq/core/knowledge`.
- Existing `outbox.build_pull_request` inputs: handoff, build result, review result, completion result, status snapshot, branch, base, target repo, and thread locator.
- Nitrosend wrapper changes will consume the cleaner core semantics after this lands.

## Assumptions

- It is acceptable for the visible PR body to be shorter than the scafld handoff as long as the packet still carries the full handoff in `engineering_summary_markdown`.
- Existing downstream tests can be updated where they asserted raw handoff as the visible PR body.
- New helpers should be generic enough for GitHub Issues, Slack, Sentry, Linear, or file-backed threads.

## Touchpoints

- `packages/core/src/knowledge/thread-story.ts`: projection helpers.
- `tools/outbox/build_pull_request/src/index.ts`: PR reviewer packet body.
- `tests/outbox-build-pull-request-tool.test.ts` and `packages/core/src/knowledge/index.test.ts`: regression coverage.
- `skills/issue-to-pr/SKILL.md`: source-thread story guidance.

## Risks

- Too much PR body reduction could remove useful reviewer evidence. Mitigation: include validation, review verdict, branch/base, source, and explicit pointer to retained full handoff evidence.
- Helper names could be too issue-intake-specific. Mitigation: name helpers around thread status and milestone notifications, not Nitrosend.
- Build may regenerate mirrored `packages/cli/tools` files. Mitigation: inspect generated diffs and include only relevant mirrors.

## Acceptance

Profile: standard

Validation:
- [x] `v1` command - runx fast tests for changed surfaces.
  - Command: `pnpm test:fast -- tests/outbox-build-pull-request-tool.test.ts packages/core/src/knowledge/index.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-14
- [x] `v2` command - runx typecheck.
  - Command: `pnpm typecheck`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-15
- [x] `v3` command - runx build.
  - Command: `pnpm build`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-16
- [x] `v4` command - diff hygiene.
  - Command: `git diff --check`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-17

## Phase 1: Core Projections And PR Reviewer Packet

Status: completed
Dependencies: none

Objective: Add generic projection helpers and make PR packaging produce reviewer-focused visible bodies.

Changes:
- `packages/core/src/knowledge/thread-story.ts` - add concise status and notification projection helpers.
- `packages/core/src/knowledge/index.ts` - export the helpers/types.
- `tools/outbox/build_pull_request/src/index.ts` - build visible `pull_request.body_markdown` from a reviewer-packet helper while preserving full handoff in `engineering_summary_markdown`.
- generated `packages/cli/tools/outbox/build_pull_request/*` mirrors if produced by `pnpm build`.

Acceptance:
- none

## Phase 2: Skill Guidance And Validation

Status: completed
Dependencies: Phase 1

Objective: Update issue-to-pr documentation and run the declared validation.

Changes:
- `skills/issue-to-pr/SKILL.md` - replace noisy gate-comment guidance with run record plus three projections guidance.
- Validation evidence recorded in the scafld session.

Acceptance:
- [x] `ac2_2` `pnpm test:fast - - tests/outbox-build-pull-request-tool.test.ts packages/core/src/knowledge/index.test.ts` passes.
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-10
- [x] `ac2_3` `pnpm typecheck`, `pnpm build`, and `git diff - -check` pass.
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-11

## Rollback

Revert the changed core helper, outbox PR tool, tests, and skill documentation. This restores raw scafld handoff as the visible PR body and leaves downstream wrappers responsible for their own projection formatting.

## Review

Status: completed
Verdict: pass
Mode: verify
Provider: codex
Output: codex.output_file
Summary: No completion-blocking regressions found. The previously identified review-risk count issue is fixed, the issue-to-pr graph expectation now matches compact PR bodies, and the generated CLI mirror matches the source tool implementation. Review was read-only as requested.

Attack log:
- `packages/core/src/knowledge/thread-story.ts; packages/core/src/knowledge/index.ts; tools/outbox/build_pull_request/src/index.ts`: Spec compliance -> clean (Compared implemented changes against task contract: core projection helpers are added/exported, PR body now uses reviewer packet, and full handoff remains in engineering_summary_markdown.)
- `tools/outbox/build_pull_request/src/index.ts:291`: Known blocker verification: review finding counts -> clean (Verified reviewFindingCount now counts native scafld findings by blocks_completion for blocking/non-blocking counts, with regression coverage in tests/outbox-build-pull-request-tool.test.ts.)
- `tests/issue-to-pr-graph.test.ts`: Known blocker verification: issue-to-pr graph expectation -> clean (Verified ambient test now expects compact PR body with Human Merge Gate and full handoff in engineering_summary_markdown, matching the new PR packaging behavior.)
- `packages/cli/tools/outbox/build_pull_request/src/index.ts`: Generated CLI mirror -> clean (Compared root tool source with packages/cli mirror using cmp; files match, so packaged CLI source includes the reviewer-packet implementation.)
- `skills/issue-to-pr/X.yaml`: Downstream caller tracing -> clean (Traced issue-to-pr X.yaml package-pull-request context; it still passes scafld handoff/build/review/complete/status/branch payloads that outbox.build_pull_request reads.)
- `packages/core/src/knowledge/thread-story.ts`: Projection sanitization and marker handling -> clean (Reviewed helper sanitization path: new projections route visible values through sanitizeThreadStoryText, preserving existing control-comment escaping and length bounds.)
- `workspace diff`: Scope and drift separation -> clean (Reviewed git status and task-scoped diff. Task changes are within declared scope; tests/issue-to-pr-graph.test.ts is ambient drift recorded by scafld and was used only to verify the previously identified regression.)
- `acceptance evidence`: Acceptance evidence policy -> clean (Per provider instruction, did not rerun tests/build/mutation commands; treated recorded pnpm test:fast, typecheck, build, and diff-check evidence as already executed.)

Findings:
- none

## Self Eval

- Scope is bounded to core projection helpers, PR packaging, and issue-to-pr docs.
- Security boundary remains in thread adapters and provider permissions; the helper only shapes markdown and metadata.
- The PR body stays human-gated and does not imply auto-merge.

## Deviations

- none

## Metadata

- created_by: scafld
- repo: runxhq/runx
- branch: codex/clean-thread-story-projections

## Origin

Created by: scafld
Source: user requested a cleaner reviewer/Slack shape and asked to move as much as cleanly possible into runx core.

## Harden Rounds

### round-1

Status: in_progress
Started: 2026-05-13T09:29:15Z
Ended: none

Checks:
- none

Questions:
- none


## Planning Log

- 2026-05-13T09:21:25Z: Created draft spec.
- 2026-05-13T09:24:00Z: Confirmed runx already has provider-agnostic `buildThreadStoryMessageOutboxEntry`.
- 2026-05-13T09:26:00Z: Chose core projection helpers plus PR reviewer-packet packaging as the clean upstream boundary.

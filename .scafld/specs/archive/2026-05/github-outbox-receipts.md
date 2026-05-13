---
spec_version: '2.0'
task_id: github-outbox-receipts
created: '2026-05-13T01:13:40Z'
updated: '2026-05-13T01:23:45Z'
status: completed
harden_status: passed
size: small
risk_level: medium
---

# GitHub outbox receipt ownership

## Current State

Status: completed
Current phase: final
Next: done
Reason: task completed
Blockers: none
Allowed follow-up command: `none`
Latest runner update: 2026-05-13T01:23:45Z
Review gate: pass

## Summary

Add an ownership receipt to GitHub message outbox comments so a managed
envelope alone cannot cause runx to treat an arbitrary provider comment as a
mutable outbox receipt.

## Objectives

- Persist an unpredictable `outbox_receipt_id` in GitHub message outbox metadata
  when runx publishes or edits an issue comment.
- Hydrate GitHub comments into message outbox entries only when the managed
  envelope includes that receipt metadata.
- Reuse an existing GitHub comment by `entry_id` only when the requested outbox
  entry carries the same receipt id. Explicit `locator`/`comment_id` edits still
  work.
- Select a just-pushed message from a refreshed provider thread by locator or
  matching receipt, not by `entry_id` alone.
- Keep copied or preemptive marker text visible as thread content instead of
  hidden control state.

## Scope

- `tools/thread/github_adapter.mjs`
- `tools/thread/push_outbox/src/index.ts`
- `tests/github-thread.test.ts`
- `tests/thread-push-outbox-tool.test.ts`

## Dependencies

- Completed `thread-story-control-envelope` task, which introduced the managed
  trailing GitHub outbox envelope.

## Assumptions

- The receipt is a correlation and anti-preemption control, not a replacement
  for provider permissions.
- Full malicious replay prevention still depends on provider identity and issue
  comment permissions. This change prevents a first-run spoof from capturing a
  future runx update by entry id.

## Touchpoints

- GitHub adapter message push, comment hydration, envelope stripping, and
  existing-comment selection.
- `thread.push_outbox` refreshed-thread selection after GitHub publish.
- GitHub helper and push-outbox tests.

## Risks

- Existing local marker-only comments no longer hydrate as outbox entries. This
  is intentional: no legacy compatibility or marker-only trust path.
- Callers that want idempotent refresh by entry id must carry the returned
  `outbox_receipt_id` or an explicit comment locator/comment id.

## Acceptance

Profile: standard

Validation:
- `pnpm exec vitest run --config vitest.config.ts tests/github-thread.test.ts tests/thread-push-outbox-tool.test.ts`
- `pnpm typecheck`
- `git diff --check`

## Phase 1: Implementation

Status: completed
Dependencies: none

Objective: Require receipt ownership for GitHub message outbox hydration and

Changes:
- Add generated `outbox_receipt_id` metadata on message push.
- Require the receipt for GitHub hydration into message outbox state.
- Require matching receipts for entry-id reuse while preserving explicit comment locator/comment id edits.
- Require matching receipts when selecting the published message from the refreshed provider thread.
- Cover marker-only spoof comments and receipt-carrying refreshes in tests.

Acceptance:
- [x] `ac1` test - GitHub comment hydration ignores managed envelopes without receipts
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/github-thread.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-6
- [x] `ac2` test - GitHub message push persists receipts and reuses only receipt-matched comments by entry id
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/thread-push-outbox-tool.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-7
- [x] `ac3` command - TypeScript typecheck passes
  - Command: `pnpm typecheck`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-8
- [x] `ac4` command - whitespace check passes
  - Command: `git diff --check`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-9

## Rollback

- Revert the scoped files. This returns GitHub message outbox reuse to the
  managed-envelope-only behavior from the previous task.

## Review

Status: completed
Verdict: pass
Mode: verify
Provider: codex
Output: codex.output_file
Summary: Review passed. The known refresh-selection blocker is fixed in the scoped push_outbox tool and packaged CLI copy, hydration is receipt-gated, message push persists a generated receipt, and entry-id reuse now requires a matching receipt while explicit locator/comment edits remain available. Acceptance evidence was treated as recorded per instruction; no tests were rerun during read-only review.

Attack log:
- `review submission transport`: transport availability -> skipped (submit_review tool was not available in this environment; returning the ReviewDossier in the required structured response format.)
- `tools/thread/github_adapter.mjs, tools/thread/push_outbox/src/index.ts, tests/github-thread.test.ts, tests/thread-push-outbox-tool.test.ts`: scoped diff review -> clean (Read the task-scoped diff for GitHub adapter, push_outbox tool, and tests; no undeclared out-of-scope mutations were needed for review conclusions.)
- `tools/thread/push_outbox/src/index.ts:120, tools/thread/push_outbox/src/index.ts:367`: previous blocker verification -> clean (Verified the prior blocker is repaired: selectMatchingOutboxEntry now matches refreshed message entries by locator or by entry_id plus matching outbox_receipt_id, not entry_id alone.)
- `packages/cli/tools/thread/push_outbox/src/index.ts:120, packages/cli/tools/thread/push_outbox/src/index.ts:367`: packaged runtime parity -> clean (Checked the packaged CLI copy because the previous review called it out; its selectMatchingOutboxEntry has the same receipt-aware logic.)
- `tools/thread/github_adapter.mjs:367`: hydration ownership gate -> clean (Confirmed GitHub comment hydration only creates message outbox entries when the parsed envelope has both entry_id and metadata.outbox_receipt_id.)
- `tools/thread/github_adapter.mjs:640`: receipt persistence on publish/edit -> clean (Confirmed pushGitHubMessage derives outboxReceiptId from requested metadata, existing matched metadata, or randomUUID, then persists it in hidden metadata and returned outbox metadata.)
- `tools/thread/github_adapter.mjs:728`: entry-id reuse guard -> clean (Confirmed selectExistingGitHubMessageOutboxEntry preserves explicit locator reuse while requiring matching receipt ids for entry_id-based reuse.)
- `tests/github-thread.test.ts:126, tests/thread-push-outbox-tool.test.ts:1293`: marker visibility and spoof coverage -> clean (Reviewed tests covering loose markers, embedded envelopes, receipt-less preemptive markers, and a preexisting receipt-bearing spoof during first publish refresh selection.)
- `tools/thread/github_adapter.d.mts:31`: declaration surface -> clean (Checked the root declaration file exposes the new envelope marker helpers used by tests/importers.)

Findings:
- none

## Self Eval

- Target score: 8/10. The change is small but security-sensitive and must not
  weaken explicit comment-id edits.

## Deviations

- none

## Metadata

- created_by: scafld
- parent_task: thread-story-control-envelope
- security_shape: receipt-bound outbox ownership

## Origin

Created by: scafld
Source: plan

## Harden Rounds

### round-1

Status: passed
Started: 2026-05-13T01:14:12Z
Ended: 2026-05-13T01:14:48Z

Checks:
- path audit
  - Grounded in: code:tools/thread/github_adapter.mjs:625
  - Result: passed
  - Evidence: Scope is limited to GitHub message outbox push/hydration code and
- command audit
  - Grounded in: code:tests/thread-push-outbox-tool.test.ts:1340
  - Result: passed
  - Evidence: Acceptance commands run the focused GitHub helper tests,
- scope/migration audit
  - Grounded in: code:tools/thread/github_adapter.mjs:642
  - Result: passed
  - Evidence: The new receipt id is generated and persisted with new/edited
- acceptance timing audit
  - Grounded in: code:tests/github-thread.test.ts:193
  - Result: passed
  - Evidence: Tests cover the security behavior before publishing the runx PR:
- rollback/repair audit
  - Grounded in: code:tools/thread/github_adapter.mjs:673
  - Result: passed
  - Evidence: Rollback is a scoped revert of the GitHub adapter and tests. If a
- design challenge
  - Grounded in: code:tools/thread/github_adapter.mjs:640
  - Result: passed
  - Evidence: Receipt-bound reuse is the smallest stable hardening over the

Questions:
- none


## Planning Log

- 2026-05-13T01:13:40Z: Created follow-up after noticing that managed envelope
  correlation alone still allowed preemptive entry-id spoofing.

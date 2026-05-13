---
spec_version: '2.0'
task_id: thread-story-control-envelope
created: '2026-05-13T00:57:53Z'
updated: '2026-05-13T01:08:58Z'
status: completed
harden_status: passed
size: medium
risk_level: medium
---

# Thread story control envelope

## Current State

Status: completed
Current phase: final
Next: done
Reason: task completed
Blockers: none
Allowed follow-up command: `none`
Latest runner update: 2026-05-13T01:08:58Z
Review gate: pass

## Summary

Harden runx's thread-backed outbox contract and add a reusable thread-story
primitive for workflows that turn a source thread into a PR or other gated
artifact.

The motivating Nitrosend flow is larger than a repo-local issue intake wrapper:
the source thread should carry the work story at each gate. The initial issue,
triage/evaluation, PR creation, and final human merge gate must be visible in
the source thread without letting hidden provider-comment markers become a
security boundary. The implementation belongs in runx core/tools as generic
thread/outbox behavior; Nitrosend remains a consumer.

## Objectives

- Provider comments used as runx message outbox receipts use a managed trailing
  control envelope, not loose hidden markers anywhere in comment text.
- GitHub hydration only maps comments back into message outbox entries when the
  managed envelope is present; ordinary user content, quoted prior comments, or
  copied hidden markers remain plain thread entries.
- Message bodies intended for source-thread storytelling can safely include
  snapshots from user-controlled issue or review text without injecting runx
  control markers.
- Core exposes a provider-agnostic helper for building thread-story message
  outbox entries with structured `metadata.control`.
- The issue-to-PR skill documentation describes the source-thread story as part
  of the runx contract: initial issue, triage/evaluation, PR materialization,
  and human merge gate.

## Scope

- In scope:
  - `tools/thread/github_adapter.mjs`
  - `tests/github-thread.test.ts`
  - `tests/thread-push-outbox-tool.test.ts`
  - `packages/core/src/knowledge/thread-story.ts`
  - `packages/core/src/knowledge/index.ts`
  - `packages/core/src/knowledge/index.test.ts`
  - `skills/issue-to-pr/SKILL.md`
- Out of scope:
  - Nitrosend repo-local wrapper changes already covered by its PR.
  - Hosted runx cloud/service routing.
  - Slack, Sentry, or GitHub Actions live deployment changes.
  - Legacy aliases or compatibility paths for old loose outbox markers.

## Dependencies

- Existing runx `Thread` and `OutboxEntry` contracts in
  `packages/core/src/knowledge`.
- Existing GitHub adapter push/hydrate behavior in `tools/thread/github_adapter.mjs`.
- Existing `thread.push_outbox` tool tests and fake GitHub harness.

## Assumptions

- Hidden GitHub comment markers are correlation hints, not authorization. The
  safe local improvement is to make them managed, trailing, and non-ambiguous;
  provider identity and human merge rights remain external security controls.
- No legacy marker compatibility is required. Existing comments without the new
  managed envelope may hydrate as normal thread messages rather than outbox
  entries.
- The generic helper should build message outbox entries, not push provider
  comments directly. Provider mutation remains inside `thread.push_outbox`.

## Touchpoints

- `tools/thread/github_adapter.mjs`: marker parsing, marker stripping,
  comment-to-outbox mapping, and message comment publishing.
- `tests/github-thread.test.ts`: pure GitHub adapter hydration behavior.
- `tests/thread-push-outbox-tool.test.ts`: integration behavior through
  `thread.push_outbox` and fake `gh`.
- `packages/core/src/knowledge/thread-story.ts`: pure thread-story message
  builder and text sanitizer.
- `packages/core/src/knowledge/index.ts`: public core knowledge export.
- `packages/core/src/knowledge/index.test.ts`: core contract coverage.
- `skills/issue-to-pr/SKILL.md`: user/operator contract for source-thread gate
  storytelling.

## Risks

- Breaking old loose-marker hydration is intentional but may surprise local test
  fixtures that relied on marker-only comments.
- Over-hardening could prevent legitimate message outbox comments from being
  refreshed. Tests must cover publish, hydrate, and refresh behavior through the
  managed envelope.
- The story builder must avoid presenting sanitized user text as trusted control
  state; it should only render visible markdown and put machine state in
  structured metadata.
- Changing GitHub adapter marker handling can affect Sourcey-style review/status
  comments, so the structured `metadata.control` lane selector must keep
  working after hydration.

## Acceptance

Profile: standard

Validation:
- `pnpm exec vitest run --config vitest.config.ts tests/github-thread.test.ts tests/thread-push-outbox-tool.test.ts packages/core/src/knowledge/index.test.ts`
- `pnpm typecheck`
- `git diff --check`

## Phase 1: Managed GitHub Outbox Envelope

Status: completed
Dependencies: none

Objective: Replace loose hidden-marker parsing with a managed trailing runx

Changes:
- Add a `runx-outbox-envelope` marker line and parse only the trailing managed
- Require the managed envelope when hydrating GitHub issue comments into
- Strip only managed trailing envelopes from visible thread entry bodies.
- Keep `metadata.control` persisted and hydrated for Sourcey/Nitrosend-style

Acceptance:
- [x] `ac1` test - GitHub hydration ignores loose or embedded markers
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/github-thread.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-6
- [x] `ac2` test - GitHub message publish/edit still refreshes through the envelope
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/thread-push-outbox-tool.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-7

## Phase 2: Core Thread Story Builder

Status: completed
Dependencies: Phase 1

Objective: Add a provider-agnostic helper for publishing source-thread gate

Changes:
- Add pure helpers to build markdown sections for thread stories.
- Bound and sanitize user-controlled snapshots by escaping HTML comment tokens
- Add a message outbox entry builder that stores `metadata.control` with
- Export the helper from `@runxhq/core/knowledge`.

Acceptance:
- [x] `ac3` test - thread story helper renders initial issue, triage, PR creation, and human gate sections
  - Command: `pnpm exec vitest run --config vitest.config.ts packages/core/src/knowledge/index.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-12
- [x] `ac4` test - thread story snapshots cannot inject runx HTML markers
  - Command: `pnpm exec vitest run --config vitest.config.ts packages/core/src/knowledge/index.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-13

## Phase 3: Issue-to-PR Contract Documentation

Status: completed
Dependencies: Phase 2

Objective: Document the runx source-thread story shape so repo-local wrappers

Changes:
- Update `skills/issue-to-pr/SKILL.md` to describe source-thread gate comments:
- State that provider mutation stays behind `thread.push_outbox` and that human
- Avoid Nitrosend-specific routing, Slack-specific assumptions, or legacy skill

Acceptance:
- [x] `ac5` test - issue-to-PR contract still parses and packages
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/issue-to-pr-graph.test.ts tests/scafld-issue-to-pr-parser.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-18

## Phase 4: Final Validation

Status: completed
Dependencies: Phase 3

Objective: Prove the combined change is coherent and clean.

Changes:
- Run the targeted suite and typecheck.
- Check the diff for whitespace and secret-like additions.

Acceptance:
- [x] `ac6` command - targeted runx validation passes
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/github-thread.test.ts tests/thread-push-outbox-tool.test.ts packages/core/src/knowledge/index.test.ts tests/issue-to-pr-graph.test.ts tests/scafld-issue-to-pr-parser.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-23
- [x] `ac7` command - TypeScript typecheck passes
  - Command: `pnpm typecheck`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-24
- [x] `ac8` command - whitespace check passes
  - Command: `git diff --check`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-25

## Rollback

- Revert the files listed in Scope. The prior behavior is self-contained in the
  GitHub adapter marker functions and no data migration is involved.

## Review

Status: completed
Verdict: pass
Mode: discover
Provider: codex
Output: codex.output_file
Summary: No completion-blocking or non-blocking findings were identified in the scoped implementation. The managed trailing envelope behavior, metadata.control preservation, provider-agnostic thread-story helper, and issue-to-PR documentation match the task contract based on read-only inspection and the recorded passing acceptance evidence.

Attack log:
- `Task scope and acceptance contract`: Spec compliance -> clean (Compared scoped diffs against the approved task contract: managed GitHub envelope, metadata.control hydration, thread-story helper export, and issue-to-PR documentation are present in the scoped files.)
- `tools/thread/github_adapter.mjs`: Envelope parser regression hunt -> clean (Inspected tools/thread/github_adapter.mjs marker creation, parsing, stripping, hydration, and message push call sites. Hydration now requires parseGitHubOutboxEnvelope via the managed marker and strips only the parsed trailing envelope.)
- `tests/github-thread.test.ts and packages/core/src/knowledge/thread-story.ts`: User marker injection -> clean (Checked tests and implementation for loose and embedded marker handling. Existing tests cover loose entry markers and embedded envelope blocks; story text sanitizer escapes HTML comment open/close tokens before rendering markdown.)
- `metadata.control`: Metadata/control preservation -> clean (Verified persisted GitHub metadata is decoded from the managed envelope and merged into hydrated message outbox entries, while the thread-story builder writes provider-agnostic metadata.control with fixed workflow/lane/task/gate/source fields.)
- `packages/core/src/knowledge/index.ts and tools/thread/github_adapter.d.mts`: Public export and type surface -> clean (Verified @runxhq/core/knowledge exports the new thread-story constants, types, sanitizer, markdown builder, and outbox-entry builder; also inspected the generated GitHub adapter declaration drift so changed runtime exports have matching declarations.)
- `workspace diff`: Scope and ambient drift -> clean (Compared git diff names and stats with the review packet. Ambient scafld/agentdoc changes are outside task scope and were not counted as task findings; the github_adapter.d.mts change appears to mirror runtime declarations for changed exports.)
- `CONVENTIONS.md and scoped files`: Convention and safety scan -> clean (Read CONVENTIONS.md and scanned scoped changed files for secret-like additions and forbidden hidden control patterns. Token names in existing tests/adapter are environment variable references or fake test values, not newly introduced secrets.)
- `acceptance commands`: Validation evidence policy -> skipped (Did not rerun tests, typecheck, build, or mutation commands because the provider instruction makes review read-only and says to treat recorded acceptance evidence as already executed.)

Findings:
- none

## Self Eval

- Target score: 8/10. The work must improve security posture, preserve generic
  runx boundaries, and have targeted tests for the behavior that previously
  failed.

## Deviations

- none

## Metadata

- created_by: scafld
- user_request: "this is much bigger than just issue intake"
- consumer_context: Nitrosend Slack/Sentry issue-to-PR flow
- runx_contract: source thread tells the gate story; outbox entries carry
  structured control metadata

## Origin

Created by: scafld
Source: plan

## Harden Rounds

### round-1

Status: passed
Started: 2026-05-13T00:59:17Z
Ended: 2026-05-13T00:59:23Z

Questions:
- none


## Planning Log

- 2026-05-13T00:57:53Z: Created draft spec from clean runx OSS worktree
  `/Users/kam/dev/runx-oss-thread-story`.
- 2026-05-13T01:05:00Z: Found existing `Thread`, `OutboxEntry`, and
  `metadata.control` primitives in `packages/core/src/knowledge`.
- 2026-05-13T01:05:00Z: Found GitHub adapter currently parses loose hidden
  `runx-outbox-entry` markers anywhere in comment bodies. This can misclassify
  visible user/thread text as runx outbox state.
- 2026-05-13T01:05:00Z: Chose generic control-envelope hardening plus a core
  story-message builder instead of adding Nitrosend-specific behavior to runx.

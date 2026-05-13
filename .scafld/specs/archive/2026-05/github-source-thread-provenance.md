---
spec_version: '2.0'
task_id: github-source-thread-provenance
created: '2026-05-13T16:41:40Z'
updated: '2026-05-13T17:04:10Z'
status: completed
harden_status: passed
size: small
risk_level: medium
---

# GitHub source thread provenance

## Current State

Status: completed
Current phase: final
Next: done
Reason: task completed
Blockers: none
Allowed follow-up command: `none`
Latest runner update: 2026-05-13T17:04:10Z
Review gate: pass

## Summary

Make the GitHub thread adapter understand the current runx source-thread story
shape instead of depending on one legacy `Source issue:` marker. A generated PR
whose body contains the rich reviewer packet line
`Source: [Source thread](https://github.com/<repo>/issues/<n>)` must still be
discoverable from the source issue, and hydrated PR outbox entries must carry
enough metadata for downstream merge/completion lanes.

## Objectives

- Treat canonical GitHub issue URLs in PR bodies as a first-class source-thread
  provenance signal.
- Keep the stable `Source issue: <url>` control marker as an append-only fallback
  when a PR body has no source reference.
- Hydrate linked pull requests with merge timestamps where GitHub exposes them.
- Preserve the existing portable thread/outbox contract and avoid adding any
  product-specific Nitrosend or Aster policy to runx core.

## Scope

- In scope:
  - GitHub issue reference parsing/detection helpers in `tools/thread/github_adapter.mjs`.
  - Type declaration parity in `tools/thread/github_adapter.d.mts`.
  - Synchronized CLI package copy under `packages/cli/tools/thread/`.
  - Regression coverage in `tests/github-thread.test.ts`.
- Out of scope:
  - Slack, Sentry, Nitrosend routing, or Aster publication policy.
  - Changing runx thread/outbox schemas.
  - Renaming hosted workflows or skills.

## Dependencies

- Existing `@runxhq/core/knowledge` thread-story builders from the prior
  richer-context work.
- GitHub CLI search semantics for `gh pr list --search "<issue-url> in:body"`.

## Assumptions

- Searching by canonical issue URL is compatible with both the old
  `Source issue: <url>` fallback and the rich reviewer packet
  `Source: [Source thread](<url>)`.
- Outbox statuses remain in the existing enum; merge completion is represented
  as PR metadata rather than a new status value.

## Touchpoints

- `tools/thread/github_adapter.mjs`
- `tools/thread/github_adapter.d.mts`
- `packages/cli/tools/thread/github_adapter.mjs`
- `packages/cli/tools/thread/github_adapter.d.mts`
- `tests/github-thread.test.ts`

## Risks

- Over-broad URL detection could accidentally link unrelated GitHub issue URLs.
  The helper should match exact repo/issue references when deciding whether a
  body already references a specific source issue.
- GitHub search query changes could miss old PRs if the query no longer includes
  the old marker. The canonical URL search must cover both old and new bodies.
- Declaration drift could break importers that consume the CLI adapter helpers.

## Acceptance

Profile: standard

Validation:
- `pnpm test tests/github-thread.test.ts`
- `pnpm typecheck`
- `git diff --check`

## Phase 1: Implementation

Status: completed
Dependencies: none

Objective: Complete the requested change.

Changes:
- Add a focused helper that detects whether arbitrary markdown references a specific GitHub issue URL, including markdown links from the reviewer packet.
- Change PR body de-duping to use that helper before appending the fallback marker.
- Change PR search to search for the canonical issue URL in PR bodies.
- Include GitHub `mergedAt` metadata when linked PRs are listed or hydrated.
- Update tests and declaration files.

Acceptance:
- [x] `ac1` command - GitHub adapter regression tests pass
  - Command: `pnpm test tests/github-thread.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-6
- [x] `ac2` command - Type declarations still compile
  - Command: `pnpm typecheck`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-7
- [x] `ac3` command - Diff has no whitespace errors
  - Command: `git diff --check`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-8

## Rollback

- Revert the GitHub adapter/helper/test changes. The old fallback marker-only
  behavior will return, but rich reviewer packet PR discovery may regress.

## Review

Status: completed
Verdict: pass
Mode: verify
Provider: codex
Output: codex.output_file
Summary: No completion-blocking issues found. The previous mergedAt de-dupe blocker is repaired, canonical issue URL provenance is recognized without adding the fallback marker, PR search now targets the canonical issue URL, and hydrated PR outbox metadata carries merged_at when available. Tests were not rerun because the review packet requires read-only review and recorded acceptance evidence already shows pass.

Attack log:
- `tools/thread/github_adapter.mjs`: Spec compliance trace -> clean (Compared task objectives to scoped adapter changes: canonical issue URL detection, fallback marker behavior, PR body search, and mergedAt propagation.)
- `tools/thread/github_adapter.mjs:939`: Known blocker verification -> clean (Previous blocker about duplicate PR rows dropping mergedAt is fixed: dedupe now merges non-empty fields from later duplicate rows into the retained PR object before hydration.)
- `tools/thread/github_adapter.mjs:73`: Markdown URL detection edge cases -> clean (Reviewed regex handling for markdown link closing parens, punctuation, fragments, query boundaries, github:// locators, adapter refs, duplicate suppression, and repo case-insensitive comparison.)
- `tools/thread/github_adapter.mjs:508`: PR search behavior -> clean (Verified fetchGitHubIssueThread searches for the canonical issue URL in PR bodies and requests mergedAt from gh pr list.)
- `tools/thread/github_adapter.mjs:357`: Hydrated PR metadata propagation -> clean (Traced pullRequests through hydrateGitHubIssueThread, dedupeGitHubPullRequests, mapGitHubPullRequestToOutboxEntry, and confirmed mergedAt/merged_at is emitted as metadata.merged_at.)
- `packages/cli/tools/thread/github_adapter.*`: Declared package surface parity -> clean (Compared top-level adapter/declaration files to packages/cli copies; no stale package copy was found.)
- `tools/thread/github_adapter.d.mts:26`: Type declaration review -> clean (Confirmed new exported helpers are declared and existing public helper declarations remain present.)
- `tests/github-thread.test.ts:40`: Test coverage review -> clean (Read updated github-thread tests covering rich reviewer-packet source links, URL-only search query, duplicate PR enrichment, and merged_at hydration.)
- `workspace`: Scope and workspace drift check -> clean (Checked git status and scoped diffs. Changed paths match the declared task scope; the untracked active spec directory is scafld lifecycle state rather than product code drift.)
- `acceptance_evidence`: Acceptance evidence handling -> clean (Read-only review instruction prohibited rerunning tests. Treated recorded acceptance evidence as executed: pnpm test tests/github-thread.test.ts, pnpm typecheck, and git diff --check passed.)

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
Started: 2026-05-13T16:43:43Z
Ended: 2026-05-13T16:44:37Z

Checks:
- path audit
  - Grounded in: code:tools/thread/github_adapter.mjs:88
  - Result: passed
  - Evidence: Source-thread provenance is owned by the GitHub adapter helper
- command audit
  - Grounded in: code:tests/github-thread.test.ts:29
  - Result: passed
  - Evidence: Focused adapter tests already cover source issue marker behavior
- scope/migration audit
  - Grounded in: code:tools/thread/github_adapter.mjs:102
  - Result: passed
  - Evidence: The change is a query/detection behavior update, not a stored data
- acceptance timing audit
  - Grounded in: code:scripts/test-workspace.mjs:1
  - Result: passed
  - Evidence: `pnpm test tests/github-thread.test.ts` runs through the existing
- rollback/repair audit
  - Grounded in: code:tools/thread/github_adapter.mjs:516
  - Result: passed
  - Evidence: Rollback is a scoped revert to marker-only source issue handling;
- design challenge
  - Grounded in: code:packages/core/src/knowledge/thread-story.ts:215
  - Result: passed
  - Evidence: The reviewer packet renderer already owns the rich story; the

Questions:
- none


## Planning Log

- Inspected `tools/thread/github_adapter.mjs`, `tests/github-thread.test.ts`,
  and `packages/core/src/knowledge/thread-story.ts`.
- Found runx core already renders rich thread-story/reviewer packets; the gap is
  the GitHub adapter only searching for the old exact `Source issue:` marker.

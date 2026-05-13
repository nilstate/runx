---
spec_version: '2.0'
task_id: friendly-runx-work-contracts
created: '2026-05-13T01:32:36Z'
updated: '2026-05-13T01:51:34Z'
status: completed
harden_status: passed
size: medium
risk_level: high
---

# Rename runx intake and agent task contracts

## Current State

Status: completed
Current phase: final
Next: done
Reason: task completed
Blockers: none
Allowed follow-up command: `none`
Latest runner update: 2026-05-13T01:51:34Z
Review gate: pass

## Summary

Rename the public upstream intake lane and cognitive step runner vocabulary so
runx presents a clear story for issue intake, planning, and PR creation. The
generic request triage skill becomes `intake`; explicit agent-mediated graph
work becomes `agent-task`. Do not ship legacy aliases or compatibility source
types.

This is larger than the Nitrosend `issue-intake` wrapper. It updates runx core
contracts, official skills, graph manifests, receipts, tests, and generated
skill metadata so downstream repos can depend on one current vocabulary.

## Context

CWD: `.`

Files impacted:
- `packages/adapters/src/agent/index.ts`
- `packages/adapters/src/agent/work-request.ts`
- `packages/contracts/src/schemas/agent-work.ts`
- `packages/core/src/parser/index.ts`
- `packages/core/src/policy/index.ts`
- `packages/core/src/receipts/index.ts`
- `packages/runtime-local/src/runner-local/caller-adapters.ts`
- `packages/runtime-local/src/runner-local/runner-helpers.ts`
- `skills/request-triage/**`
- `skills/intake/**`
- `skills/*/X.yaml`
- `skills/*/SKILL.md`
- `fixtures/skills/agent-step/**`
- `fixtures/skills/agent-task/**`
- `tests/**/*.test.ts`
- `README.md`
- `packages/cli/src/official-skills.lock.json`
- `bindings/**/*.yaml`
- `dist/packets/*.schema.json`
- `schemas/*.schema.json`
- `package.json`

Invariants:
- No `agent-step` runtime source type remains in active runx source,
  fixtures, tests, official skills, or README.
- No `request-triage` official skill remains in active source, fixtures,
  tests, official lock metadata, or README.
- No runtime aliases, dual source-type admission, or compatibility shims.
- Preserve the distinction between whole-skill `agent` runs and scoped
  graph-step `agent-task` runs.
- Keep the thread story/outbox receipt security model from PR #28 intact.

Out of scope:
- Editing historical `.scafld/specs/archive` evidence solely to remove old
  words.
- Publishing a registry migration or hosted marketplace update.
- Adding automated PR merge behavior.

## Objectives

- Rename the upstream public triage skill from `request-triage` to `intake`.
- Rename the explicit graph/scoped cognitive source type from `agent-step` to
  `agent-task`.
- Update official skill packages and graph manifests to use `agent-task`.
- Update caller, managed-agent, parser, contract, policy, receipt, and local
  runtime code to use only `agent-task`.
- Regenerate official skill lock metadata.
- Update tests and fixture paths to assert the new contracts.

## Scope

- Active runx source, official skills, tests, fixtures, bindings, exported
  schemas, and README.
- Generated official skill lock metadata.
- Existing thread story/outbox receipt code only as needed to keep validation
  passing after the contract rename.

## Dependencies

- Existing branch changes in PR #28 for managed thread story comments and
  receipt-bound GitHub outbox hydration.
- Current package scripts: `pnpm build`, `pnpm typecheck`, `pnpm verify:fast`.

## Assumptions

- `intake` is the clearest generic public lane name. Product-specific wrappers
  such as Nitrosend can still expose `issue-intake` when they add product
  policy and transport handling.
- `agent-task` is a better low-level source type than `agent-step` because it
  describes a bounded unit of agent-mediated work without implying graph order
  or user-facing workflow terminology.
- This branch may intentionally break old local manifests that still use
  `agent-step` or `request-triage`; the user requested no aliases or
  compatibility.

## Touchpoints

- Managed agent adapter selection and work request IDs.
- Caller-mediated runtime work request IDs.
- Source parser validation for required `agent` and `task` fields.
- Admission policy default source type allow-list.
- Receipt metadata for scoped agent tasks.
- Official skills and graph manifests.
- Upstream binding manifests.
- Exported packet schema artifacts and root package export metadata.
- Test fixtures and snapshots.
- Official lock generation.

## Risks

- High: this is a breaking contract rename for any unpublished manifest still
  using `agent-step` or `request-triage`.
- Medium: mechanical replacement can leave stale generated lock entries or
  stale test fixture paths.
- Medium: `agent` whole-skill runners and `agent-task` scoped runners can be
  accidentally collapsed if the distinction is not preserved.
- Low: existing scafld archive specs may continue to contain historical words;
  those are audit evidence, not active contract surfaces.

## Acceptance

Profile: standard

Validation:
- [x] `v1` test - targeted runner/skill tests pass.
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/agent-task-boundary.test.ts tests/intake-skill.test.ts tests/recognizable-work-lanes.test.ts tests/work-plan-skill.test.ts tests/issue-to-pr-graph.test.ts tests/tool-step.test.ts tests/graph-runner.test.ts tests/local-skill-runner.test.ts packages/adapters/src/agent/index.test.ts packages/core/src/parser/index.test.ts packages/core/src/parser/graph.test.ts packages/runtime-local/src/runner-local/voice-profile.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-24
- [x] `v2` command - active source contains no old public contract names.
  - Command: `! rg -n 'agent-step|agent_step|request-triage|request_triage|request\.triage|Request Triage|runx\.request\.triage|schemas\.runx\.dev/runx/request/triage' README.md package.json packages skills tests fixtures tools bindings dist schemas --glob '!packages/cli/src/official-skills.lock.json'`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-25
- [x] `v3` command - generated official skill lock is current.
  - Command: `before=$(git diff -- packages/cli/src/official-skills.lock.json); node scripts/generate-official-lock.mjs; after=$(git diff -- packages/cli/src/official-skills.lock.json); test "$before" = "$after"`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-26
- [x] `v4` build - package build succeeds.
  - Command: `pnpm build`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-27
- [x] `v5` typecheck - TypeScript typecheck succeeds.
  - Command: `pnpm typecheck`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-28
- [x] `v6` test - fast verification suite passes.
  - Command: `pnpm verify:fast`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-29
- [x] `v7` command - whitespace diff check is clean.
  - Command: `git diff --check`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-30

## Phase 1: Implementation

Status: completed
Dependencies: none

Objective: Rename the public intake skill and scoped agent task runner

Changes:
- Rename `skills/request-triage` to `skills/intake` and update skill metadata, task ids, answer request ids, packet names, tests, README, and references.
- Rename the `agent-step` source type to `agent-task` across parser, adapters, contracts, policy, receipts, runtime-local, official skills, fixtures, README, and tests.
- Update upstream binding manifests and exported packet schema artifacts so
  package consumers see only the new `agent-task`/`intake` contract.
- Preserve whole-skill `agent` runner behavior separately from scoped `agent-task` behavior.
- Regenerate the official skill lock.

Acceptance:
- [x] `ac1_1` command - active source uses new contract names only.
  - Command: `! rg -n 'agent-step|agent_step|request-triage|request_triage|request\.triage|Request Triage|runx\.request\.triage|schemas\.runx\.dev/runx/request/triage' README.md package.json packages skills tests fixtures tools bindings dist schemas --glob '!packages/cli/src/official-skills.lock.json'`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-6
- [x] `ac1_2` command - new intake skill and agent-task runner names are present.
  - Command: `rg -n 'skill: intake|name: intake|agent-task|agent_task|runx\.intake\.v1' README.md package.json packages skills tests fixtures tools bindings dist schemas`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-7
- [x] `ac1_3` test - targeted tests pass.
  - Command: `pnpm exec vitest run --config vitest.config.ts tests/agent-task-boundary.test.ts tests/intake-skill.test.ts tests/recognizable-work-lanes.test.ts tests/work-plan-skill.test.ts tests/issue-to-pr-graph.test.ts tests/tool-step.test.ts tests/graph-runner.test.ts tests/local-skill-runner.test.ts packages/adapters/src/agent/index.test.ts packages/core/src/parser/index.test.ts packages/core/src/parser/graph.test.ts packages/runtime-local/src/runner-local/voice-profile.test.ts`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-8
- [x] `ac1_4` build - package build succeeds.
  - Command: `pnpm build`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-9
- [x] `ac1_5` test - fast verification suite passes.
  - Command: `pnpm verify:fast`
  - Expected kind: `exit_code_zero`
  - Status: pass
  - Evidence: exit code was 0
  - Source event: entry-10

## Rollback

- Revert this task's active source changes and regenerate
  `packages/cli/src/official-skills.lock.json` from the reverted skill set.
  Do not add fallback aliases as rollback.

## Review

Status: completed
Verdict: pass
Mode: verify
Provider: codex
Output: codex.output_file
Summary: Pass. The two previously recorded blockers are repaired, no stale public `agent-step` or `request-triage` vocabulary remains in active searched surfaces, and the parser, policy, adapter, official skill, binding, packet, and lock surfaces all use the new `agent-task`/`intake` contract. I could not rerun Vitest in this read-only sandbox because Vite needs to write a temp config file under `node_modules/.vite-temp`; `git diff --check` did pass.

Attack log:
- `scafld status`: Review prompt and status setup -> skipped (Read `.scafld/prompts/review.md` and attempted `./bin/scafld status friendly-runx-work-contracts --json`; the wrapper is absent in this checkout, so review used direct worktree inspection.)
- `previous findings F1/F2`: Known blocker verification -> clean (The active spec ledger showed prior blockers for `bindings/nilstate/icey-server-operator/X.yaml` and `dist/packets/request.triage.v1.schema.json`. Current lines show `type: agent-task` and `agent_task.*` answers in the binding, and `dist/packets/intake.v1.schema.json` now advertises `runx.intake.v1`.)
- `legacy contract names`: Stale vocabulary sweep -> clean (Ran the stale-token scan for `agent-step`, `agent_step`, `request-triage`, `request.triage`, and related public IDs across active source, skills, tests, fixtures, bindings, dist, and schemas excluding the lockfile. It returned no matches outside `.scafld` review/spec history.)
- `source parser and policy`: Parser and admission contract trace -> clean (Checked `packages/core/src/parser/index.ts:532-544` and `packages/core/src/policy/index.ts:99-104`; `agent-task` now requires `agent` and `task`, disallows command/args, and the default allow-list no longer admits `agent-step`.)
- `managed/caller agent adapters`: Runtime and adapter request IDs -> clean (Checked `packages/adapters/src/agent/work-request.ts:29-70`, `packages/adapters/src/index.ts:45-48`, and `packages/runtime-local/src/runner-local/index.ts:864-868`; managed and caller paths register `agent-task` and emit `agent_task.<task>.output` while preserving whole-skill `agent` IDs separately.)
- `official intake skill`: Official intake skill contract -> clean (Checked `skills/intake/SKILL.md`, `skills/intake/X.yaml:1-45`, `skills/intake/X.yaml:273-283`, and `tests/intake-skill.test.ts:9-40`; the official skill is renamed to `intake`, uses `agent-task`, answers `agent_task.intake.output`, and emits `runx.intake.v1`.)
- `generated/exported metadata`: Exported packet and lock metadata -> clean (Checked `package.json:10-14`, `dist/packets/intake.v1.schema.json:1-12`, and `packages/cli/src/official-skills.lock.json`; the public packet glob now has an intake schema in the worktree and the official lock contains `runx/intake` with no `request-triage` entry.)
- `workspace diff shape`: Workspace rename shape -> clean (Checked tracked deletions and untracked additions with `git ls-files`: old request-triage/agent-step files are deleted and replacement intake/agent-task files are present in the worktree. `git diff --check` returned exit code 0.)
- `targeted Vitest suite`: Targeted automated validation rerun -> skipped (Attempted `pnpm exec vitest run --config vitest.config.ts ...`; Vitest could not load config because Vite tried to write `node_modules/.vite-temp/...` and the sandbox is read-only. Acceptance evidence in the review packet reports the same suite passed before review.)

Findings:
- none

## Self Eval

- none

## Deviations

- none

## Metadata

- created_by: scafld
- user_request: make the runx story larger than issue intake; use friendlier
  names; no legacy aliases or compatibility.

## Origin

Created by: scafld
Source: plan

## Harden Rounds

### round-1

Status: passed
Started: 2026-05-13T01:33:33Z
Ended: 2026-05-13T01:34:33Z

Checks:
- path audit
  - Grounded in: code:packages/runtime-local/src/runner-local/caller-adapters.ts:224
  - Result: passed
  - Evidence: Scope includes the caller-mediated source type construction where
- command audit
  - Grounded in: code:skills/request-triage/X.yaml:1
  - Result: passed
  - Evidence: Validation includes targeted skill/runner tests, generated lock
- scope/migration audit
  - Grounded in: code:packages/core/src/policy/index.ts:99
  - Result: passed
  - Evidence: The default admission allow-list currently includes the old
- acceptance timing audit
  - Grounded in: code:tests/request-triage-skill.test.ts:9
  - Result: passed
  - Evidence: Existing official skill tests assert the old public skill name
- rollback/repair audit
  - Grounded in: code:packages/cli/src/official-skills.lock.json:73
  - Result: passed
  - Evidence: The generated lock carries public skill ids, so rollback requires
- design challenge
  - Grounded in: code:packages/runtime-local/src/runner-local/caller-adapters.ts:260
  - Result: passed
  - Evidence: Whole-skill `agent` and scoped cognitive work are separate

Questions:
- Which active surfaces are authoritative for the rename, and can archive specs
  - Grounded in: spec_gap:scope
  - Recommended answer: Active source, official skills, fixtures, tests,
  - If unanswered: Default to active source only.
  - Answered with: Use active source only; leave historical evidence intact.
- Should old `agent-step` or `request-triage` names remain as runtime aliases?
  - Grounded in: spec_gap:invariants
  - Recommended answer: No. The user explicitly requested no legacy aliases or
  - If unanswered: No aliases.
  - Answered with: No aliases or compatibility paths.
- What keeps whole-skill `agent` work distinct from scoped graph work after the
  - Grounded in: code:packages/runtime-local/src/runner-local/caller-adapters.ts:224
  - Recommended answer: Keep `agent` as the whole-skill runner and introduce
  - If unanswered: Preserve the current semantic split with the new name.
  - Answered with: Preserve the split.
- What proves this is larger than Nitrosend `issue-intake`?
  - Grounded in: code:skills/request-triage/X.yaml:1
  - Recommended answer: Rename the upstream public lane to `intake` and update
  - If unanswered: Limit to the upstream public lane and runtime vocabulary.
  - Answered with: Update the upstream lane and runtime contracts.


## Planning Log

- 2026-05-13T01:32:36Z - Created scafld draft.
- 2026-05-13T01:34:00Z - Expanded scope to upstream runx public contract
  renames, not Nitrosend wrapper-only fixes.

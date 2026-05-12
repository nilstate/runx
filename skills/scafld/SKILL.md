---
name: scafld
description: Run existing scafld v2 lifecycle commands under runx governance.
---

# scafld

Use this skill when runx needs to govern an existing scafld lifecycle or
projection command.

The skill does not replace scafld. It calls the scafld 2.4.0+ CLI with explicit
argv, requires native JSON output for machine-readable commands, records the
runx receipt for the hop, and lets the graph define which command is allowed at
each step.

## Quality Profile

- Purpose: expose native scafld lifecycle commands through governed runx steps
  without hiding scafld state.
- Audience: maintainers and graphs that need spec, harden, build, review,
  status, and handoff surfaces to stay native and inspectable.
- Artifact contract: native scafld JSON payload, receipt metadata, and handoff
  Markdown when requested by the native command.
- Evidence bar: forward scafld fields as-is. Do not reconstruct lifecycle state
  from prose or invent missing spec/review data.
- Voice bar: operational wrapper language only. The wrapper should not become a
  second workflow narrative.
- Strategic bar: keep the engineering system visible while runx governs
  boundaries, scopes, approvals, and receipts.
- Stop conditions: fail or return the native scafld gate reason when validation,
  build, review, or completion blocks. Do not smooth over lifecycle failures.

## Lifecycle

scafld v2 manages code-change work through a linear lifecycle:

```text
draft -> approved -> active -> review -> completed/failed/cancelled
```

Specs are Markdown files under `.scafld/specs/`:

- `drafts/` - draft specs
- `approved/` - approved specs ready to build
- `active/` - active or review-stage specs
- `archive/YYYY-MM/` - completed, failed, or cancelled specs

The supported commands are:

1. `init` - bootstrap a scafld workspace.
2. `plan <task-id>` - create `.scafld/specs/drafts/<task-id>.md`.
3. `harden <task-id>` - open a hardening round before approval.
4. `harden <task-id> --mark-passed` - close the current hardening round.
5. `validate <task-id>` - validate the Markdown spec shape.
6. `approve <task-id>` - move a draft into the approved lane.
7. `build <task-id>` - activate approved work, run acceptance, and write evidence.
8. `build_to_review <task-id>` - repeatedly run native `scafld build
   <task-id> --json` until scafld reports status `review`, stopping on the
   first native build failure or blocker.
9. `exec <task-id>` - run the execution path for the current task.
10. `review <task-id>` - run scafld's native adversarial review gate.
11. `complete <task-id>` - archive reviewed work after the native gate passes.
12. `status <task-id>` - inspect native task state.
13. `list` - list native task specs.
14. `report` - aggregate native run/spec metrics.
15. `handoff <task-id>` - render model-facing Markdown transport.
16. `fail <task-id>` and `cancel <task-id>` - archive incomplete work.

Branch creation, issue updates, PR creation, and CI publication are wrapper
responsibilities. scafld owns the local lifecycle, spec projection, session
evidence, and review gate.

## Spec Shape

The spec file (`.scafld/specs/.../<task-id>.md`) is Markdown with YAML front
matter:

- `spec_version: "2.0"`
- `task_id`, `created`, `updated`, `status`, `harden_status`
- `size`, `risk_level`
- `# Title`, plus sections such as `## Summary`, `## Objectives`,
  `## Scope`, `## Acceptance`, `## Phase N: ...`, `## Review`, and
  `## Planning Log`
- executable acceptance criteria use `Command` and `Expected kind`

## Inputs

- `command` (required): one of `init`, `plan`, `harden`, `validate`,
  `approve`, `build`, `build_to_review`, `exec`, `review`, `complete`, `fail`, `cancel`,
  `status`, `list`, `report`, or `handoff`.
- `task_id`: scafld task id. Required for all commands except `init`, `list`,
  and `report`.
- `fixture`: workspace root containing `.scafld/`; used as scafld working
  directory.
- `title`, `summary`, `size`, `risk`, `acceptance_command`: forwarded to
  `plan`.
- `mark_passed`: forwarded to `harden --mark-passed`.
- `provider`, `provider_command`, `provider_binary`, `model`: forwarded to
  `review`.
- `max_builds`: optional cap for `build_to_review`; defaults to 12 native
  build advances.
- `scafld_bin`: explicit scafld executable path. Defaults to `SCAFLD_BIN` or
  `scafld` on PATH.
- `scafld_min_version`: optional minimum accepted scafld version; defaults to
  `2.4.0`.

## Structured Output

runx does not rebuild scafld state locally. For commands with native JSON
contracts, the wrapper forwards the scafld payload directly after argv/env
sanitization. scafld 2.4.0 command providers may print provider progress before
the final JSON envelope; the runner extracts and forwards that native envelope.
`build_to_review` is a bounded lifecycle driver over native `scafld build`
outputs, not a local state reconstruction. `handoff` is the exception: it
forwards native Markdown because handoff is model transport, not lifecycle
state.

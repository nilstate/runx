---
name: bug-to-pr
description: Govern a scafld-backed bug-to-PR lane with caller-mediated review.
---

# Bug to PR

Take a bounded bugfix and drive it through the full scafld lifecycle under
runx governance, from spec to archived completion.

This is a composite skill. It chains the `scafld` integration skill through
eight governed steps. Each step has explicit scopes. The adversarial review
is caller-mediated — runx routes the review handoff through the caller
boundary so the reviewer may be a human, the controlling agent, or a peer
agent.

## What this skill does

1. **Create the spec** (`scafld new`). Produces a draft spec in
   `.ai/specs/drafts/<task-id>.yaml` with the bugfix title, size, and
   risk. The spec must be filled with phases, file changes, and
   acceptance criteria before approval.

2. **Approve the spec** (`scafld approve`). Validates the spec against
   the schema and moves it to `approved/`. This is a governance gate —
   the spec must pass validation, all TODO placeholders must be resolved.

3. **Start execution** (`scafld start`). Moves the spec to `active/`
   with status `in_progress`.

4. **Execute acceptance criteria** (`scafld exec`). Runs the shell
   commands declared in each phase's `acceptance_criteria[].command`.
   Records pass/fail results back into the spec YAML. This is the step
   where code changes are verified.

5. **Audit scope** (`scafld audit`). Compares declared file changes
   in the spec against actual `git diff`. Detects scope creep
   (undeclared changes) and missing changes (declared but not present).

6. **Open review** (`scafld review --json`). Runs automated passes
   (spec_compliance, scope_drift). If they pass, creates the review
   artifact at `.ai/reviews/<task-id>.md` and returns the `review_file`
   path and `review_prompt` for the adversarial review.

7. **Reviewer boundary** (caller-mediated). The reviewer receives the
   review file and adversarial prompt. They must fill three sections:
   regression_hunt, convention_check, and dark_patterns. They must set
   pass results, blocking/non-blocking findings, and a verdict
   (pass/fail/pass_with_issues). This step runs through the `agent`
   runner — the caller controls who reviews.

8. **Complete** (`scafld complete --json`). Validates the review
   artifact, checks that all sections are filled and the verdict is
   acceptable. On success, writes the review into the spec and
   archives it to `.ai/specs/archive/YYYY-MM/` with status `completed`.

## When to use this skill

Use `bug-to-pr` when you have a bounded bugfix that should go through
the full governed lifecycle. The fix scope should be known before you
start — this is not an exploration skill. If you need to diagnose the
bug first, use `receipt-review` or research skills upstream, then feed
the bounded fix into this chain.

## When not to use this skill

- For open-ended investigation — use research or evolve instead.
- For spec-only work without execution — run `scafld new` and
  `scafld approve` directly.
- For fixes that do not need adversarial review — run scafld commands
  individually.

## Inputs

- `task_id`: scafld task id for the bug fix (default: `bug-to-pr-fixture`).
- `title`: bug fix title passed to `scafld new`.
- `size`: spec size — `micro`, `small`, `medium`, or `large` (default: `micro`).
- `risk`: spec risk — `low`, `medium`, or `high` (default: `low`).
- `phase`: optional scafld execution phase (e.g., `phase1`).
- `fixture`: workspace root containing the `.ai/` directory.
- `scafld_bin`: explicit scafld executable path.

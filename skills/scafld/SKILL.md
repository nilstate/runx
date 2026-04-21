---
name: scafld
description: Run existing scafld lifecycle commands under runx governance.
---

# scafld

Use this skill when runx needs to govern an existing scafld lifecycle or
projection command.

The skill does not replace scafld. It calls the scafld CLI with explicit argv,
requires native `--json` output for supported commands, records the runx
receipt for the hop, and lets the chain define which command is allowed at each
step.

## Lifecycle

scafld manages code-change work through a linear lifecycle:

```
draft → approved → in_progress → completed/failed/cancelled
```

Each status maps to a directory under `.ai/specs/`:
- `drafts/` — draft and under_review specs
- `approved/` — approved specs ready to start
- `active/` — in-progress specs being executed
- `archive/YYYY-MM/` — completed, failed, or cancelled specs

The lifecycle commands, in typical order:

1. **`init`** — bootstrap a scafld workspace. Creates the `.ai/` directory
   tree with config, schemas, prompts, and spec directories. Run once per
   repo.

2. **`new <task-id>`** — create a new spec in `drafts/`. The task-id must
   be kebab-case. Flags: `-t` title, `-s` size (micro/small/medium/large),
   `-r` risk (low/medium/high). Creates `.ai/specs/drafts/<task-id>.yaml`
   with TODO placeholders that must be filled before approval.

3. **`validate <task-id>`** — validate the spec against the JSON schema.
   Checks required fields, valid enums, non-empty phases, and that TODO
   placeholders have been replaced. runx forwards the native JSON payload from
   `scafld validate --json` directly.

4. **`approve <task-id>`** — validate then move the spec from `drafts/`
   to `approved/`. Sets status to `approved`.

5. **`start <task-id>`** — move the spec from `approved/` to `active/`.
   Sets status to `in_progress`.

6. **`exec <task-id>`** — run acceptance criteria commands from the spec.
   For each criterion with a `command` field, executes the shell command,
   checks the result against `expected`, and records pass/fail back into
   the spec YAML. Flags: `--phase` to run only one phase, `--resume` to
   skip already-passed criteria. Default timeout 600s per criterion,
   overridable with `timeout_seconds` on each criterion.

7. **`audit <task-id>`** — compare declared file changes in the spec
   against actual `git diff`. Reports scope creep (undeclared changes)
   and missing changes (declared but not present). Exits 1 on any
   undeclared files. Flag: `--base` to set git base ref (default HEAD~1).

8. **`review <task-id>`** — open a review round. Runs automated passes
   first (spec_compliance re-runs acceptance criteria, scope_drift runs
   audit). If automated passes fail, exits 1 with instructions to fix.
   On success, creates `.ai/reviews/<task-id>.md` with a Review Artifact
   v3 template and returns a native JSON review handoff payload including
   `review_file`, `review_prompt`, `automated_passes`, and
   `required_sections`.

9. **`complete <task-id>`** — finalize the review and archive the spec.
   Validates that the review artifact exists, all adversarial sections
   are filled, verdict is not fail/incomplete, and pass results are
   consistent. On success, writes a `review:` block into the spec and
   moves it to `archive/YYYY-MM/` with status `completed`. On failure,
   exits 1 with the gate reason. runx forwards the native completion JSON as-is.
   Override path: `--human-reviewed --reason "..."` allows completing with an
   override (requires interactive terminal confirmation).

10. **`status <task-id>`** — show spec status, phase progress, review
    state, origin binding, and sync facts. runx forwards the native
    `scafld status --json` payload directly.

11. **`fail <task-id>`** — move an in-progress spec to archive with
    status `failed`.

12. **`cancel <task-id>`** — move a spec to archive with status
    `cancelled`.

13. **`branch <task-id>`** — bind the task to a working branch and record the
    native origin metadata.

14. **`sync <task-id>`** — compare recorded origin metadata to the live git
    workspace and emit native drift details.

15. **`summary <task-id>`**, **`checks <task-id>`**, and
    **`pr-body <task-id>`** — project the same spec/review/origin state onto
    markdown and CI/check surfaces without wrapper-side reconstruction.

## Review handoff

The `review` command opens the review round and returns the review file
path and adversarial prompt. The actual review is **reviewer-mediated**: the
chain routes it through the caller boundary so the reviewer may be a human,
the controlling agent, or a peer agent. The `agent` runner on this skill
receives `task_id`, `review_file`, and `review_prompt` and must fill the
three adversarial sections in the review artifact before `complete` runs.

After filling, the reviewer must update the review metadata: set
`round_status` to `completed`, set each adversarial pass result to
`pass`/`fail`/`pass_with_issues`, fill blocking/non-blocking findings,
and set the verdict line to `pass`, `fail`, or `pass_with_issues`.

## Spec YAML structure

The spec file (`.ai/specs/.../<task-id>.yaml`) contains:

- `spec_version`: "1.1"
- `task_id`, `status`, `created`, `updated`
- `task`: title, summary, size, risk_level, context (packages, invariants,
  files_impacted, cwd), objectives, touchpoints, acceptance (definition_of_done,
  validation)
- `phases[]`: id (phase1, phase2, ...), name, objective, changes[] (file,
  action, content_spec), acceptance_criteria[] (id, type, description,
  command, expected, cwd, timeout_seconds)
- `rollback`: strategy (per_phase/atomic/manual), commands
- `planning_log`: timestamped entries

## Inputs

- `command` (required): scafld command to run. Accepts: `init`, `new`/`spec`,
  `approve`, `start`, `exec`/`execute`, `audit`, `review`, `complete`,
  `validate`, `status`, `fail`, `cancel`, `report`, `branch`, `sync`,
  `summary`, `checks`, `pr-body`. Aliases: `spec` maps to `new`, `execute`
  maps to `exec`.
- `task_id`: scafld task id (required for all commands except `init`).
- `fixture`: workspace root containing `.ai/`; used as scafld working directory.
- `title`: title for `new` command (`-t` flag).
- `size`: size for `new` command (`-s` flag): micro, small, medium, large.
- `risk`: risk for `new` command (`-r` flag): low, medium, high.
- `phase`: phase for `exec` command (`--phase` flag).
- `base`: base ref for `audit --base` or `branch --base`.
- `name`: branch name for `branch --name`.
- `bind_current`: boolean flag for `branch --bind-current`.
- `scafld_bin`: explicit scafld executable path. Defaults to `SCAFLD_BIN`
  env var or `scafld` on PATH.

## Structured output

runx does not rebuild scafld state locally anymore. For commands with native
JSON contracts, the wrapper forwards the scafld payload directly after argv/env
sanitization. That includes lifecycle commands plus the origin/sync/projection
surfaces (`branch`, `sync`, `summary`, `checks`, `pr-body`).

## Vendored manifest policy

The workspace bundle under `.ai/scafld/` is vendored on purpose, but it is not
the live runtime contract by itself. The installed scafld binary must satisfy
the native contract recorded in `.ai/scafld/manifest.json`, including the
required scafld version and required projection/origin surfaces. That keeps the
vendored assets auditable while preserving a thin runtime boundary between runx
and scafld.

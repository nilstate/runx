# scafld - Agent Guide

Canonical reference for AI coding agents working with this codebase. Agent-agnostic.

> **Template file.** When setting up scafld in your project, customize the invariants, forbidden actions, and domain rules below to match your architecture. The generic defaults are a solid starting point.

**Key files:**

- `.scafld/config.yaml` - Validation rules, rubric weights, safety controls, profiles
- `.scafld/prompts/plan.md` - Planning mode prompt
- `.scafld/prompts/exec.md` - Execution mode prompt
- `.scafld/core/schemas/spec.json` - Spec validation schema
- `CONVENTIONS.md` - Coding standards and patterns

---

## How scafld Works

Spec-driven development: every non-trivial task becomes a machine-readable markdown specification before any code changes happen.

1. **Plan** - Analyze task, explore codebase, generate spec in `.scafld/specs/drafts/`
2. **Review** - Human reviews and approves the spec
3. **Build** - Agent executes approved spec with validation
4. **Complete** - Completed specs are marked through the scafld lifecycle

The spec is the contract. Operate autonomously within its bounds; pause for approval on deviations.

For detailed planning instructions, read `.scafld/prompts/plan.md`. For execution, read `.scafld/prompts/exec.md`.

---

## Spec Status Lifecycle

```text
draft → approved → review → completed
  ↓         ↓          ↓
(edit)   failed    cancelled
```

Valid transitions:

- `draft` → `approved` → `review` → `completed`
- active work can move to `failed` or `cancelled`
- blocked work must be recorded in the spec state and handoff

---

## Architectural Invariants

These rules must not be violated. See `config.yaml` for the canonical invariant list.

### Layer Separation

Domain logic stays in domain modules. HTTP/transport concerns stay in handlers. External integrations go through ports/adapters. No circular dependencies between layers.

### Stable Public APIs

Public API changes (HTTP endpoints, event schemas, public interfaces) require explicit approval. Breaking changes require migration plans.

### No Legacy Fallbacks

No dual-reads, dual-writes, or runtime fallbacks. When changing schemas or identifiers, adopt the new scheme immediately. Use one-off migration scripts, not runtime code.

### No Hardcoded Secrets

Configuration from environment or secrets management, never hardcoded. No secrets in code, logs, or diffs.

### Test-Logic Separation

No test fixtures, mocks, or conditional test-only logic in production code. Test utilities stay in dedicated test helper modules.

---

## Spec Management

**Always use the `scafld` CLI for spec lifecycle management.** Never manually move, copy, or rename spec files between directories. Never manually change the `status` field. The CLI enforces validation, state transitions, and the review gate — bypassing it breaks the audit trail.

---

## Operating Modes

### Planning Mode

- **When:** Starting a new task, exploring requirements
- **Actions:** Search, read, analyze (NO code changes outside `.scafld/specs/`)
- **Output:** Markdown spec in `.scafld/specs/drafts/` with status `draft`
- **Prompt:** Read `.scafld/prompts/plan.md` before entering this mode

### Execution Mode

- **When:** Spec has status `approved`
- **Actions:** Apply changes, run acceptance criteria, record scafld build evidence
- **Output:** Code changes, validation results, updated spec
- **Prompt:** Read `.scafld/prompts/exec.md` before entering this mode
- **Autonomy:** Execute all phases without pausing unless blocked, deviating from spec, or hitting a destructive action not covered by spec

For trivial changes (typos, single-line fixes), skip the spec workflow and work directly.

### Review Mode

- **When:** Build has passed and status is `review`
- **Actions:** Run `scafld review`, then `scafld complete` only after the native review gate passes
- **Output:** Review verdict recorded in the spec and available through `scafld status` / `scafld handoff`
- **Prompt:** Read `.scafld/prompts/review.md` before entering this mode
- **Mandate:** Find problems, not confirm success. A review that finds zero issues still needs grounded evidence from the changed files, validation commands, and spec scope.

---

## Validation

Validation profiles (`light`, `standard`, `strict`) and their check pipelines are defined in `config.yaml`. Agents select a profile based on `task.acceptance.validation_profile` or derive from `task.risk_level` (low→light, medium→standard, high→strict).

**Per-phase:** Run configured checks after each phase completes.

**Pre-commit:** Run full validation pipeline before marking task complete.

**Self-evaluation:** Score work on rubric (defined in `config.yaml`). Threshold is 7/10; perform second pass if below.

---

## Safety Controls

Defined in `config.yaml` under `safety`. Key rules:

**Require approval for:** Schema migrations, public API changes, data deletion, production deployments.

**Automatically prevent:** Hardcoded secrets, unbounded queries, SQL injection, XSS vulnerabilities.

---

## Coding Conventions

See `CONVENTIONS.md` for full coding standards. Key points:

- Match existing code style; keep diffs focused
- Prefer existing helpers; keep code DRY
- Explicit named imports, no confusing aliases
- Bounded database queries with pagination
- Idempotent migrations executed out of band

---

## Git Commits

Only commit when explicitly asked by the user.

**Format:** `type(scope): title` (conventional commits)

**Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`

**Rules:**

- One logical change per commit
- Title under 72 characters
- Include what changed and why in the body
- No unrelated edits bundled together
- Pre-commit: code builds, tests pass, no secrets in diff, no debug code

---

## Communication

**Progress updates:** Report phase completion, acceptance criteria pass/fail counts, next action. Keep it concise - no verbose preambles.

**When blocked:** State what's blocked, brief error, one recommendation, resolution options.

**Final summary:** Phases completed, acceptance results, self-evaluation score, deviations, files changed.

---

## Quick Reference

### Key Paths

| Path | Purpose |
| ---- | ------- |
| `.scafld/config.yaml` | Validation, rubric, safety, profiles |
| `.scafld/prompts/plan.md` | Planning mode instructions |
| `.scafld/prompts/exec.md` | Execution mode instructions |
| `.scafld/prompts/review.md` | Adversarial review mode instructions |
| `.scafld/core/schemas/spec.json` | Spec JSON schema |
| `.scafld/specs/` | Task specs by lifecycle status |
| `.scafld/reviews/` | Review outputs when provider artifacts are written |
| `.scafld/runs/` | Build/review session state |
| `CONVENTIONS.md` | Coding standards |

### Spec Lifecycle

```bash
# CLI (manages status, validation, file moves)
scafld plan <task-id>            # scaffold a markdown spec in drafts/
scafld list                      # show all specs
scafld status <task-id>          # show details + phase progress
scafld validate <task-id>        # check against schema
scafld approve <task-id>         # approve the draft spec
scafld build <task-id>           # run validation and move to review when checks pass
scafld exec <task-id>            # execute configured task actions when used
scafld review <task-id>          # run native review provider
scafld complete <task-id>        # record review verdict and complete the task
scafld handoff <task-id>         # render markdown handoff
scafld fail <task-id>            # mark failed
scafld cancel <task-id>          # mark cancelled
scafld report                    # aggregate stats across all specs
```

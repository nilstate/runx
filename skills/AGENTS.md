# scafld - Agent Guide

Canonical reference for AI coding agents working with this codebase. Agent-agnostic.

> **Template file.** When setting up scafld in your project, customize the invariants, forbidden actions, and domain rules below to match your architecture. The generic defaults are a solid starting point.

**Key files:**

- `.ai/config.yaml` - Validation rules, rubric weights, safety controls, profiles
- `.ai/prompts/plan.md` - Planning mode prompt
- `.ai/prompts/exec.md` - Execution mode prompt
- `.ai/schemas/spec.json` - Spec validation schema
- `CONVENTIONS.md` - Coding standards and patterns

---

## How scafld Works

Spec-driven development: every non-trivial task becomes a machine-readable YAML specification before any code changes happen.

1. **Plan** - Analyze task, explore codebase, generate spec in `.ai/specs/drafts/`
2. **Review** - Human reviews and approves the spec
3. **Execute** - Agent executes approved spec phase-by-phase with validation
4. **Archive** - Completed specs move to `.ai/specs/archive/YYYY-MM/`

The spec is the contract. Operate autonomously within its bounds; pause for approval on deviations.

For detailed planning instructions, read `.ai/prompts/plan.md`. For execution, read `.ai/prompts/exec.md`.

---

## Spec Status Lifecycle

```text
draft → under_review → approved → in_progress → review → completed
  ↓                                    ↓           ↓
(edit)                             (blocked)     failed
                                      ↓           ↑
                                  (resume)    fix + re-review
```

Valid transitions:

- `draft` → `under_review` → `approved` → `in_progress` → `completed`
- `in_progress` → `failed` → `cancelled`
- `in_progress` can stay `in_progress` if blocked (explain in logs)
- `under_review` → `draft` (changes requested)

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
- **Actions:** Search, read, analyze (NO code changes outside `.ai/specs/`)
- **Output:** YAML spec in `.ai/specs/drafts/` with status `draft`
- **Prompt:** Read `.ai/prompts/plan.md` before entering this mode

### Harden Mode (optional)

- **When:** The operator runs `scafld harden <task-id>` on a draft. You MAY suggest running it for high-risk or ambiguous specs, but MUST NOT block planning or approval on it. `scafld approve` does NOT consult `harden_status`.
- **Actions:** Interrogate the draft one grounded question at a time. Walk down the design tree and resolve upstream decisions before downstream ones. Record each round in the spec's `harden_rounds` array.
- **Grounding contract (load-bearing):** every question and recommended answer MUST carry a `grounded_in` value matching exactly one of three patterns: `spec_gap:<field>`, `code:<file>:<line>` (verified by `Read`/`Grep` in the current session), or `archive:<task_id>`. Do not invent citations. If you run out of grounded questions, stop.
- **Termination:** operator types `done`/`stop`, you run out of grounded questions, or you hit `max_questions_per_round` from `.ai/config.yaml`.
- **Output:** appended round in `harden_rounds`; `harden_status: in_progress` while the loop runs. Operator finalises via `scafld harden <task-id> --mark-passed`.
- **Prompt:** Read `.ai/prompts/harden.md` before entering this mode.

### Execution Mode

- **When:** Spec has status `approved`
- **Actions:** Apply changes phase-by-phase, run acceptance criteria, log to `.ai/logs/`
- **Output:** Code changes, validation results, updated spec
- **Prompt:** Read `.ai/prompts/exec.md` before entering this mode
- **Autonomy:** Execute all phases without pausing unless blocked, deviating from spec, or hitting a destructive action not covered by spec

For trivial changes (typos, single-line fixes), skip the spec workflow and work directly.

### Review Mode

- **When:** All phases complete, before `scafld complete`
- **Actions:** Run `scafld review`, then adversarial code review (ideally in a fresh session) and update the latest Review Artifact v3 round with reviewer provenance, `round_status`, and per-pass `pass_results`
- **Output:** Findings written to `.ai/reviews/{task-id}.md`, verdict recorded in spec
- **Prompt:** Read `.ai/prompts/review.md` before entering this mode
- **Mandate:** Find problems, not confirm success. A review that finds zero issues is suspicious. The configured built-in passes are `spec_compliance`, `scope_drift`, `regression_hunt`, `convention_check`, and `dark_patterns`. `scafld complete` only bypasses a blocked gate through the audited `--human-reviewed --reason` path. Local CLI checks improve workflow integrity, but stronger guarantees still need CI or merge gate enforcement, review artifacts bound to the reviewed diff or commit, and out-of-band approval or an external reviewer.

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
| `.ai/config.yaml` | Validation, rubric, safety, profiles |
| `.ai/prompts/plan.md` | Planning mode instructions |
| `.ai/prompts/exec.md` | Execution mode instructions |
| `.ai/prompts/review.md` | Adversarial review mode instructions |
| `.ai/schemas/spec.json` | Spec JSON schema |
| `.ai/specs/` | Task specs by status (drafts/approved/active/archive) |
| `.ai/reviews/` | Review findings per spec (gitignored, accumulates rounds) |
| `.ai/logs/` | Execution logs (ReAct traces) |
| `CONVENTIONS.md` | Coding standards |

### Spec Lifecycle

```bash
# CLI (manages status, validation, file moves)
scafld new <task-id>             # scaffold a spec in drafts/
scafld list                      # show all specs
scafld status <task-id>          # show details + phase progress
scafld validate <task-id>        # check against schema
scafld approve <task-id>         # drafts/ -> approved/
scafld start <task-id>           # approved/ -> active/
scafld exec <task-id>            # run acceptance criteria, record results
scafld audit <task-id>           # compare spec changes vs git diff
scafld diff <task-id>            # show git history for spec
scafld review <task-id>          # run configured automated passes + scaffold Review Artifact v3
scafld complete <task-id>        # read review, record verdict, archive (requires review)
scafld complete <task-id> --human-reviewed --reason "manual audit"  # exceptional audited override for a blocked review gate
scafld fail <task-id>            # active/ -> archive/ (failed)
scafld cancel <task-id>          # active/ -> archive/ (cancelled)
scafld report                    # aggregate stats across all specs
```

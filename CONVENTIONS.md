# Coding Conventions & Standards

> **Template file.** Customize this for your project's tech stack, architecture, and patterns. The structure and generic rules below are a solid starting point.

**Purpose:** Single source of truth for code style and development patterns.

**Scope:** Applies to all code in this repository.

**See also:**
- [AGENTS.md](AGENTS.md) — High-level invariants and AI agent policies
- [CLAUDE.md](CLAUDE.md) — Claude-specific integration guide
- [.ai/README.md](.ai/README.md) — Task planning and execution workflows

**Relationship to AGENTS files:**
- `AGENTS.md` and this document define global invariants and conventions.
- The `.ai/` system must respect the invariants and conventions defined here.

---

## Getting Started

This is a template conventions file. Customize it for your project by:

1. Updating the tech stack section with your actual versions
2. Defining your architecture principles
3. Adding project-specific code style rules
4. Configuring your test and build commands

---

## Tech Stack & Versions

### Example Configuration (Replace with Your Stack)

```yaml
# Backend
language: "Python 3.11" | "Ruby 3.2" | "Go 1.21" | "Node.js 20"
framework: "Django" | "Rails" | "FastAPI" | "Express"

# Frontend
framework: "React 18" | "Vue 3" | "Next.js 14" | "Nuxt 4"
typescript: "5.x"
ui_library: "Your choice"

# Shared
error_format: "Problem+JSON (RFC 7807)" | "Custom"
api_spec: "OpenAPI 3.1" | "GraphQL"
```

**Version conflicts:** If examples on the web conflict with these versions, **obey these versions** and ask before deviating.

---

## Architecture Principles

### Layer Separation

**Core concept:** Domain logic lives in dedicated modules; framework/infrastructure code stays at the edges.

**Example layers:**
- **Controllers/Handlers** — HTTP/transport adapters. Bind/validate params, authorize, call services, render responses.
- **Services/Use Cases** — Orchestrate domain workflows; no HTTP concerns or rendering.
- **Models/Entities** — Domain logic and persistence; encapsulate invariants.
- **Ports/Adapters** — External integrations (databases, APIs, queues).

**Key rules:**
- Controllers stay thin (bind/authorize → call service → map result)
- Services own domain workflows and talk to models and external ports
- Models keep invariants; avoid business orchestration or HTTP concerns
- Public surfaces (HTTP contracts, events, schemas) remain stable and spec-first

### Dependencies

**Allowed imports (example):**
- **`core/`** → may depend on `ports/` and internal pure packages
- **`ports/`** → defines interfaces/contracts (pure interfaces, no implementations)
- **`adapters/`** → implements `ports/`; may depend on `core/` and `ports/`
- **`app/`** → composition/wiring; may depend on all layers

**If a change crosses layers:** Introduce or refine a **port** rather than leaking concerns across boundaries.

---

## Code Style

### General Rules

- Match existing style; keep diffs focused and local.
- Avoid renames/moves unless required by the task.
- **Never** include secrets or internal paths in code, logs, or diffs.
- Prefer existing helpers and service objects; keep code **DRY**.
- Keep domain logic in dedicated modules rather than stuffing controllers/handlers.

### Imports & Aliasing

**Best practices:**
- Use explicit named imports over namespace imports
- Don't alias imports to different symbols (confuses readers)
- Import by canonical names; update call sites if renaming

### Query Hygiene (Databases)

- Avoid unbounded queries; always scope appropriately and use pagination.
- Prefer selective column loading and eager-loading associations.
- Consider indexes when adding new filter paths.
- Use transactions for multi-step writes that must commit atomically.
- Avoid raw SQL where possible; when necessary, keep it localized and tested.

---

## Error Handling

### Recommended: Problem+JSON (RFC 7807)

**Format:**
```json
{
  "type": "about:blank",
  "title": "Validation Error",
  "status": 400,
  "detail": "Missing required field: email",
  "instance": "/api/users/create"
}
```

**Rules:**
- Use consistent error envelope across all endpoints
- Structured error codes preferred (typed constants, not magic strings)
- Frontend should parse errors and display appropriately

---

## Testing Patterns

### Principles

- Validate pragmatically: prefer fast, high-signal checks over exhaustive runs during iteration
- Broaden before merging or when risk is high
- Add tests when there is an obvious adjacent pattern or when asked

### Test Types

- **Unit tests:** Test domain logic in isolation
- **Integration/API tests:** Test through HTTP or service boundaries
- **E2E tests:** Full system tests (when applicable)

### Commands (Customize for Your Stack)

```bash
# Example commands - replace with your actual test/lint commands

# Run tests
npm test              # Node.js
pytest                # Python
bundle exec rspec     # Ruby
go test ./...         # Go

# Lint
npm run lint          # Node.js
ruff check .          # Python
bundle exec rubocop   # Ruby
golangci-lint run     # Go

# Typecheck
npm run typecheck     # TypeScript
mypy .                # Python
```

### Rules

- **Tests-first when possible:** Reproduce with a targeted/failing test, then patch, then re-run
- For non-trivial changes: add/adjust the closest, smallest-scoped test
- Keep test runs targeted unless risk warrants broader coverage
- **Do NOT change snapshots/golden files** without noting why

---

## Legacy & Migrations

**Hard rules:**
- **Do NOT** add runtime fallbacks, dual-reads, or dual-writes when changing identifiers or APIs
- When a key/schema is updated, **adopt the new scheme immediately**
- Do not reference legacy keys in hot paths
- If migration is required, use a **one-off script** executed out of band
- Keep app code free of migration branches
- **Migrations must be idempotent** and safe to re-run

---

## Dependencies

**Before adding new dependencies:**
1. Check if existing helper/utility covers the need
2. Justify the addition
3. Get approval from team lead (when applicable)

**Prefer:**
- Built-in language/framework utilities
- Well-maintained, widely-used packages
- Packages with good TypeScript/type support

---

## Refactoring Policy

**Prefer:**
- Targeted refactors that strengthen boundaries
- Improve naming or extract interfaces to enable the best solution
- Reshape modules when it materially improves correctness/maintainability

**Avoid:**
- Superficial fixes that entrench poor layering
- Renames/moves unless required by the task
- Unrelated refactors bundled with feature work

**Keep changes coherent and reversible.**

---

## Git Commits

**Only commit when explicitly asked** by the user (AI agents should not commit without permission).

### Conventional Commits Format

**Required format:** `type(scope): title`

**Types:**
- `feat` — New feature
- `fix` — Bug fix
- `refactor` — Code restructuring (no behavior change)
- `docs` — Documentation only
- `test` — Adding or updating tests
- `chore` — Build/tooling changes
- `perf` — Performance improvement
- `style` — Code style/formatting (no logic change)

**Examples:**
```
feat(api): add metrics endpoint for usage tracking
fix(auth): resolve session timeout race condition
refactor(core): extract validation to separate module
docs(conventions): add git commit guidelines
```

### Commit Body

**Include:**
- **What changed** (brief summary)
- **Why** (rationale, problem being solved)
- **Migration notes** (if applicable)

### Rules

- **Do NOT bundle unrelated edits** (keep commits focused)
- One logical change per commit
- Commit message title ≤72 characters
- Body lines ≤80 characters (when wrapping)
- Reference issue/ticket numbers when applicable

### Pre-commit Checks

**Before committing, ensure:**
- [ ] Code compiles/builds
- [ ] Tests pass (at least targeted tests)
- [ ] Linters pass (if configured)
- [ ] No secrets or credentials in diff
- [ ] No debug code (console.log, print statements, etc.)

---

## What Not to Do

**Forbidden:**
- Invent behavior or requirements (ask instead)
- Add legacy/fallback code paths
- Silently change routing, auth, or persistence semantics
- Derive behavior from implicit assumptions or hidden fallbacks
- Place concerns in the wrong layer
- Leave "temporary" runtime code in production paths
- Hardcode secrets or internal paths
- Bypass established error handling patterns
- Add test-only logic to production code
- Commit without explicit user permission (AI agents)

# scafld Claude Contract

Read `AGENTS.md` first. It owns the full scafld contract.

## Default Flow

```bash
scafld plan <task-id> --title "Title"
scafld harden <task-id>
scafld approve <task-id>
scafld build <task-id>
scafld review <task-id>
scafld complete <task-id>
scafld status <task-id>
scafld handoff <task-id>
```

## Boundaries

- Use `scafld harden` to strengthen the draft before approval.
- Use `scafld build` to open one phase, then run it again after implementation to record evidence.
- Use `scafld review` as the adversarial gate.
- Use `scafld status --json` for automation.
- Use `scafld handoff` for compact model context without moving state.

For real review, use `--provider claude` or `--provider codex`.
`--provider local` is smoke-test only and cannot satisfy `complete`.

Inside the scafld repo, use `./bin/scafld` or `go run ./cmd/scafld`; do not use
a copied compiled binary.

# Claude Code Integration Notes

> **Template file.** Add your project overview, essential commands (build, test, dev server), and any Claude-specific tips here.

Claude-specific tips for working with scafld.

**MUST READ:** `AGENTS.md` - the canonical agent guide covering invariants, modes, validation, and conventions. Read it before doing any work.

## Tool Usage

- Always use `Read` before `Edit` to understand existing code and ensure correct string matching.
- Use `Grep` and `Glob` for codebase exploration instead of bash `find`/`grep`.
- Prefer `Edit` (targeted replacement) over `Write` (full file overwrite) for existing files.

## Spec Management

**Always use the `scafld` CLI for spec lifecycle management.** Never manually move, copy, or rename spec files. Never manually change the `status` field.

## Entering scafld Modes

- **Plan mode:** Read `.scafld/prompts/plan.md`, then explore and generate a spec.
- **Exec mode:** Read `.scafld/prompts/exec.md`, then load the approved spec and execute.
- **Review mode:** Run `scafld review <task-id>` with an external adversarial provider. Read findings from `scafld review`, `scafld status`, or `scafld handoff`; do not write a separate review file.

## Prompting Patterns

```
"Let's plan [feature]. Create a task spec."
"Execute the [task-id] spec."
"Review the [task-id] spec."
"Show me the current phase status."
```

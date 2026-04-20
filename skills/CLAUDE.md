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

- **Plan mode:** Read `.ai/prompts/plan.md`, then explore and generate a spec.
- **Exec mode:** Read `.ai/prompts/exec.md`, then load the approved spec and execute.
- **Review mode:** Run `scafld review <task-id>`, then read `.ai/prompts/review.md` and the review file. Fill in findings.

## Prompting Patterns

```
"Let's plan [feature]. Create a task spec."
"Execute the [task-id] spec."
"Review the [task-id] spec."
"Show me the current phase status."
```

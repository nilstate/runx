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

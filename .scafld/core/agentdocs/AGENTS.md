# scafld Agent Contract

## Contract

- `spec` is the living contract.
- `session` is the durable evidence ledger.
- `handoff` is transport, not source of truth.
- `review` is the adversarial completion gate.

You execute autonomously inside the contract. You do not close the task unchallenged.

## Commands

```bash
scafld init
scafld plan <task-id> --title "Title" --size small --risk low
scafld harden <task-id>
scafld harden <task-id> --mark-passed
scafld validate <task-id>
scafld approve <task-id>
scafld build <task-id>
scafld review <task-id>
scafld complete <task-id>
scafld status <task-id>
scafld list
scafld report
scafld handoff <task-id>
scafld update
```

For real review: `scafld review <task-id> --provider {codex|claude|command}`.
`--provider local` is smoke-test only and cannot satisfy `complete`.

## Lifecycle

```text
plan -> harden -> approve -> build -> review -> complete
```

Hardening attacks the draft. Review attacks the result.

## Do Not

- Edit outside declared scope, objectives, or invariants.
- Reconstruct lifecycle state by scraping Markdown. Use `status --json`.
- Use legacy `.ai/` scafld files. `.scafld/` is the only active protocol home.
- Mutate `.scafld/core/` by hand. Use `scafld update`.
- Run `--provider local` for real review.
- Cite files, commands, or review findings you have not verified.

## Prompts

`.scafld/prompts/*` overrides `.scafld/core/prompts/*` overrides built-ins.

# scafld Runtime

scafld builds long-running AI coding work under adversarial review.

## Core Model

- `spec`: reviewed contract
- `session`: durable run ledger
- `handoff`: generated transport for the next voice

The taught surface is deliberately small:

```text
plan -> harden -> approve -> build -> review -> complete
```

## Directory Layout

```text
.scafld/
  config.yaml
  config.local.yaml
  prompts/
    plan.md
    build.md
    recovery.md
    review.md
    harden.md
  runs/
    {task-id}/
      diagnostics/
      session.json
  specs/
    drafts/
    approved/
    active/
    archive/YYYY-MM/
  core/
    prompts/
    schemas/
    scripts/
```

Prompt ownership:

- `.scafld/prompts/*` is the active template layer
- `.scafld/core/prompts/*` is the managed reset copy

`scafld config` writes `.scafld/config.proposed.yaml` with evidence-backed
config suggestions. It does not mutate `.scafld/config.yaml`.

`scafld update` refreshes default project prompt copies when they are still
known defaults. Customized project prompts are skipped. It also refreshes root
agent docs and renders generated `.scafld/config.yaml` into the current strict
runtime shape.

## Handoffs

`scafld handoff <task-id>` renders current model-facing context to stdout from
the spec and session. It is one-way transport: scafld emits it, the next model
reads it, and scafld never reads it back for state.

## Default Integrations

When the workspace includes them, prefer:

- `.scafld/core/scripts/scafld-codex-build.sh <task-id>`
- `.scafld/core/scripts/scafld-codex-review.sh <task-id>`
- `.scafld/core/scripts/scafld-claude-build.sh <task-id>`
- `.scafld/core/scripts/scafld-claude-review.sh <task-id>`

They resolve the current scafld handoff first, then pass it to the external
agent runtime. That keeps phase handoff consumption as the default path instead
of a manual convention.

## Adversarial Review

Challenge fires at `review`.

That means:

- one accepted review dossier per review run, recorded in session
- one completion gate that matters
- findings are visible in `review`, `status`, `handoff`, and the spec
- diagnostics are transport evidence, not the primary finding surface

## Metrics

`report` surfaces:

- `first_attempt_pass_rate`
- `recovery_convergence_rate`
- `review_pass_rate`
- `review_dossier_coverage`
- `review_findings_total`
- `review_open_blockers_total`
- `review_attack_angles_total`
- `challenge_override_rate`

Use `scafld report` to inspect workspace-wide task state.

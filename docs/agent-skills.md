# Agent Skills: runx Inside Claude and Codex

runx skills are governed by the runx runtime, not by a model following prose.
`runx export` makes those governed skills available *inside* an agent such as
Claude Code or Codex: each runx skill becomes a native agent skill whose only
job is to call the runx binary. The agent brings the judgment; runx admits the
authority, performs the act, and returns a signed receipt.

## How It Works

`runx export <claude|codex>` generates orchestrator-native files that delegate
back to runx:

- **Claude** gets one `SKILL.md` shim per skill under `~/.claude/skills/<name>/`
  (or `./.claude/skills/` with `--project`). Each shim declares `allowed-tools`
  locked to the runx binary and carries the exact `runx skill ... --json`
  command with typed inputs.
- **Codex** gets the same per-skill shims under `~/.codex/skills/<name>/` plus an
  idempotent managed allow block in `~/.codex/rules/default.rules`. Project-scope
  Codex export is deliberately refused until Codex project paths are stable.

The repository-root `runx` guide is the one exception to delegation: exporting
it copies its native operator instructions instead of recursively calling
`runx skill <runx-repository>`. Provider/domain skills still delegate through
the runtime.

When the agent runs the skill it shells out to runx. Execution, authority
admission, approvals, and the signed receipt all happen inside the runtime, so
the governance is real rather than narrated.

## Export

```bash
runx export claude                          # current workspace's public skills -> ~/.claude/skills
runx export claude --project                # -> ./.claude/skills (checked into a repo)
runx export claude weather-forecast spend   # only the named skills
runx export codex                           # ~/.codex/skills plus managed rules
```

Add `--json` for machine-readable output. Only public skills export; hidden and
builder-surface skills are skipped.

A full export must run from a skill workspace containing a root `SKILL.md` or
`skills/`. It synchronizes that workspace's managed catalog and removes only
stale generated shims sourced from the same workspace; exports owned by other
repositories remain intact. An unrelated directory fails closed without
changing existing shims. Supplying one or more skill refs is additive: Runx
updates those shims without removing any other managed skills.

## What A Claude Shim Looks Like

`runx export claude` writes a shim like this for the `spend` skill:

````markdown
---
name: spend
description: Execute one governed outbound payment, with quote, reservation, approval, rail evidence, and receipt-before-success.
allowed-tools: Bash(/path/to/runx skill *)
---
# spend - governed by runx

Run the declared runner through runx; do not bypass it by independently reproducing work that runner owns.

```bash
/path/to/runx skill /path/to/skills/spend \
  --parent_payment_authority "<...>" \
  --payment_signal "<...>" \
  --rail_profile_ref "<...>" \
  --json
```

Then surface the returned receipt id, status, and artifact ids.

<!-- runx-export:claude source=/path/to/skills/spend - generated, do not edit -->
````

For Claude, the `allowed-tools` line limits the shim to the runx binary. Codex
uses the generated rules block. Runx remains the authority boundary on both
surfaces.

## Requirements

- **The runx binary.** The shim calls runx by path, so that binary must be
  present.
- **Receipt identity.** Local development uses Runx's local-development receipt
  identity. Hosted and CI execution must configure the complete
  `RUNX_RECEIPT_SIGN_*` tuple; a partial tuple fails closed. See
  [Getting Started](./getting-started.md#production-receipt-signing).
- **Declared provider credentials.** Configure them through `runx credential`
  or the workspace `.env`. Exported shims do not add credential wrappers; the
  invoked Runx skill performs the canonical readiness check. See
  [Credential Resolution](./credentials.md).

## Regenerating

Rerun `runx export` after you add, rename, or remove skills; the shims are
generated, so do not hand-edit them. If a shim's source skill moves, the stale
shim fails closed and instructs you to rerun the export, so a renamed skill
never silently runs the wrong thing.

## Portability

A shim bakes the runx binary path resolved at export time. Exported from a
source checkout it points at the local debug build; export with the published
CLI on your `PATH` (the `@runxhq/cli` global) so the shim is portable across
machines.

## The General Agent Bridge

Per-skill exports are the right call for governed skills. The exported root
`runx` guide is the looser discovery bridge: it teaches the agent to find skills
in the [catalog](https://runx.ai/x), run them, and read the receipts without
wrapping the runtime in itself.

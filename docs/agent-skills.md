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
  locked to the runx binary, states that the agent must not do the work itself,
  and carries the exact `runx skill ... --json` command with typed inputs.
- **Codex** gets a single managed block, delimited by
  `# >>> runx-export start (managed) >>>` and `# <<< runx-export end <<<`, added
  to its rules file and listing the governed skills and how to invoke them.

When the agent runs the skill it shells out to runx. Execution, authority
admission, approvals, and the signed receipt all happen inside the runtime, so
the governance is real rather than narrated.

## Export

```bash
runx export claude                          # all public skills -> ~/.claude/skills (global)
runx export claude --project                # -> ./.claude/skills (checked into a repo)
runx export claude weather-forecast spend   # only the named skills
runx export codex                           # Codex managed rules block
```

Add `--json` for machine-readable output. Only public skills export; hidden and
builder-surface skills are skipped.

## What A Claude Shim Looks Like

`runx export claude` writes a shim like this for the `spend` skill:

````markdown
---
name: spend
description: Execute one governed outbound payment, with quote, reservation, approval, rail evidence, and receipt-before-success.
allowed-tools: Bash(/path/to/runx skill *)
---
# spend - governed by runx

This skill runs under runx governance. Do not perform the work yourself.
Execution, policy enforcement, approvals, and the signed receipt happen inside runx.

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

The `allowed-tools` line is the boundary: the skill can only invoke the runx
binary, so the agent cannot quietly reimplement a governed flow in prose.

## Requirements

- **The runx binary.** The shim calls runx by path, so that binary must be
  present.
- **Receipt-signing keys.** The shell must export `RUNX_RECEIPT_SIGN_KID`,
  `RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64`, and `RUNX_RECEIPT_SIGN_ISSUER_TYPE`.
  Without them runx fails closed instead of producing an unverifiable receipt.
  See [Getting Started](./getting-started.md#production-receipt-signing).

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

Per-skill exports are the right call for governed skills. For a looser "let the
agent discover and drive runx" entry point, paste
[runx.ai/SKILL.md](https://runx.ai/SKILL.md) into the agent: it teaches the agent
to find skills in the [catalog](https://runx.ai/x), run them, and read the
receipts.

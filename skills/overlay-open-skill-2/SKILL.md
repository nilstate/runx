---
name: overlay-open-skill-2
description: Govern a second, distinct open-ecosystem SKILL.md (Anthropic skill-creator) under a runx overlay — pin its sha256 digest, declare scope bounds and an explicit allowed-tool set, and refuse to run when the upstream content no longer matches the pinned digest. Read-only; never edits the upstream skill.
runx:
  category: authoring
---

# Overlay Open Skill 2 — Governed Wrapper for skill-creator

This skill proves the runx overlay bridge on a **second, distinct** real target
from the open skill ecosystem. It wraps the widely-used Anthropic `skill-creator`
SKILL.md under a governed runx overlay: the upstream file is **never edited**;
the overlay pins its `sha256` digest, declares scope bounds and an explicit
`allowed_tools` set, and **refuses to run** when the upstream content no longer
matches the pinned digest (upstream drift detection).

## What this skill does

1. **Fetch the upstream at runtime.** Reads the real `skill-creator` SKILL.md
   from a pinned GitHub commit URL (not a bundled fixture), so the digest check
   is against live upstream content.
2. **Pin the content.** Compares the runtime-computed `sha256` digest to the
   pinned digest declared in the overlay. A mismatch raises
   `runx.overlay.digest.stale` and the overlay refuses — the operator must
   re-review before trusting the upstream change.
3. **Bound the authority.** The overlay declares the narrowest scopes and the
   explicit `allowed_tools` set the wrapped skill needs. It is read-only: it
   refuses `mutate` / `append` / `advance`.
4. **Emit the governed overlay.** Produces an `overlay_open_skill_2` packet
   carrying the wraps reference, pinned digest, scope bounds, allowed tools,
   license, and reviewer rationale.

## The overlay model

```yaml
skill: overlay-open-skill-2
wraps:
  ref: anthropics/skills/skill-creator
  digest: sha256:dcd4803e61e913e6fc27294184cd3a71f09f5e924ff20c8a9a20173e7b3c2bcf
  license: Apache-2.0
runner:
  type: graph
  scopes: [repo.read, web.read]
  allowed_tools: [fs.read, web.read]
```

Graphs must reference this overlay, never the raw upstream `SKILL.md`.

## Core principles

- **Wrap, never fork.** The overlay references the upstream skill; it does not
  copy or edit it.
- **Pin the digest.** A borrowed skill is pinned by content digest so an
  upstream edit raises `runx.overlay.digest.stale` instead of running unseen
  changes.
- **No empty grant.** An overlay with no scopes is `runx.overlay.scope.empty`,
  never an implicit allow-all.
- **Read-only by contract.** This overlay refuses mutation, append, and advance.

## Inputs

- `upstream_url` (required): raw URL to the upstream SKILL.md at a pinned commit.
- `pinned_digest` (required): `sha256:<hex>` pin for the upstream SKILL.md.
- `wraps_ref` (required): human-readable upstream ref, e.g.
  `anthropics/skills/skill-creator`.
- `license` (optional): upstream license (default `Apache-2.0`).
- `scopes` (optional): runner scope bounds (default `[repo.read, web.read]`).
- `allowed_tools` (optional): explicit tool set (default `[fs.read, web.read]`).
- `health_baseline` (optional): read-only baseline overrides
  (`threshold_days_stuck`, `cap_pressure_pct`, `refusal_spike_rate`).
- `mutate` / `append` / `advance` (optional): write framing — refused.

## Stop conditions

- **Upstream missing:** `runx.overlay.skill.missing` — cannot fetch the URL.
- **Digest mismatch:** `runx.overlay.digest.stale` — refuse to run; re-review.
- **Mutation requested:** refuse — read-only contract.

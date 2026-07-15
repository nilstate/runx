---
name: overlay
description: Wrap a borrowed Anthropic SKILL.md under a governed runx overlay, with scope bounds, an allowed-tool set, and a pinned digest, so the open skill ecosystem can run under runx authority without editing the upstream skill.
runx:
  category: authoring
---

# Overlay Generator

Make any borrowed skill safe to run by wrapping it in a governed overlay.

The open ecosystem is full of `SKILL.md` files. They carry capability and no
governance. An overlay is how runx adopts one without forking it: a same-schema
`X.yaml` that `wraps` the borrowed skill and adds the runx envelope, scope
bounds, an explicit allowed-tool set, and a pinned content digest. The upstream
skill is never edited; the overlay governs it. This skill authors that overlay
and reports the diagnostics that decide whether it is safe to run.

## What this skill does

1. **Resolve the wrapped skill.** Take a registry ref (`vendor/research@1.2.0`)
   or a local path (`./vendor/research/SKILL.md`) and confirm it resolves.
2. **Pin the content.** Record a digest of the wrapped `SKILL.md` so a later
   upstream change is detected, not silently inherited.
3. **Bound the authority.** Propose the narrowest scopes and the explicit
   allowed-tool set the skill needs; an empty scope set is a diagnostic, not a
   default-allow.
4. **Emit the overlay.** Produce a canonical
   `skills-overlays/<vendor>/<skill>/X.yaml` that wraps the skill and carries the
   runx envelope, plus the diagnostics that gate it.

## Core principles

- **Wrap, never fork.** The overlay references the upstream skill; it does not
  copy or edit it.
- **Most-restrictive-wins.** Effective scopes are the intersection of any graph
  step scopes and the overlay's runner scopes; the overlay can only narrow.
- **Pin the digest.** A borrowed skill is pinned by content digest so an
  upstream edit raises `runx.overlay.digest.stale` instead of running unseen
  changes.
- **No empty grant.** An overlay with no scopes is `runx.overlay.scope.empty`,
  never an implicit allow-all.
- **Wraps is governance, not inheritance.** The overlay does not adopt the
  upstream skill's behavior; it bounds it.

## When to use this skill

- Adopting a third-party or Anthropic-standard skill into a governed runx graph.
- Pinning a borrowed skill so upstream drift is detected.
- Tightening the scopes a borrowed skill runs under.

## When not to use this skill

- To author a first-party skill from scratch (use `design-skill`).
- To change the wrapped skill's behavior. Overlays bound; they do not patch.

## The overlay model

The proposal fills a `skills-overlays/<vendor>/<skill>/X.yaml`:

```yaml
skill: vendor/research
wraps: vendor/research@1.2.0          # or { path: ./vendor/research/SKILL.md, version: sha256:<digest> }
runners:
  default:
    type: agent
    scopes:
      - web.read
      - repo.read
    runx:
      allowed_tools:
        - web.search
        - fs.read
```

Graphs must reference the overlay, never the raw `SKILL.md`. Direct raw
`SKILL.md` invocation is allowed only for interactive human CLI runs, with a
warning.

## Diagnostics

- `runx.overlay.skill.missing` (error): the wrapped ref or path does not resolve.
- `runx.overlay.digest.stale` (warning): the local wrapped digest no longer
  matches the pinned digest.
- `runx.overlay.scope.empty` (error): the overlay declares no scopes.
- `runx.overlay.tools.unbounded` (warning): scopes are declared but no explicit
  `allowed_tools` set bounds them.

## Procedure

1. Resolve exactly one wrapped skill from `skill_ref` or `skill_path`. With both
   present, confirm they refer to the same skill or return `needs_input`.
2. Read the wrapped `SKILL.md` and compute its pinned digest. Never copy the
   upstream skill into the overlay.
3. Identify the tools, network access, filesystem access, credentials, and
   mutation surfaces the wrapped skill actually needs.
4. Translate that need into the narrowest runner scopes and `allowed_tools` set.
   If a needed capability cannot be bounded, return `reject`.
5. Emit the canonical overlay path, `wraps` reference, digest, runner type,
   scopes, allowed tools, diagnostics, and reviewer rationale.
6. Require graph users to reference the overlay path, not the raw upstream
   `SKILL.md`.

## Edge cases and stop conditions

- **Wrapped skill missing:** return `needs_input` or `reject`; never create an
  overlay for an unresolved ref.
- **Digest mismatch:** emit `runx.overlay.digest.stale`; the operator must
  re-review before trusting the upstream change.
- **No declared scopes:** emit `runx.overlay.scope.empty` and block
  `decision: ready`.
- **Unbounded tool access:** warn or reject depending on risk; mutation or secret
  access without an explicit tool set is not ready.
- **Scope intent exceeds the wrapped skill's real need:** narrow the grant or
  return `needs_input`; do not use the overlay as an authority escalation path.
- **Raw secret material in the wrapped skill instructions:** reject unless the
  overlay can keep the material out of prompts, outputs, and receipts.

## Output schema (`overlay_proposal`)

```yaml
decision: ready | needs_input | reject
wraps:
  ref: string                          # vendor/research@1.2.0, when from registry
  path: string                         # ./vendor/research/SKILL.md, when local
  digest: string                       # sha256:<digest> pin
overlay_path: string                   # skills-overlays/<vendor>/<skill>/X.yaml
runner:
  type: agent | agent-task
  scopes: [string]
  allowed_tools: [string]
diagnostics:
  - id: string
    severity: error | warning
    message: string
rationale: string
blockers: [string]
needs_input: [string]
success_checkpoint:
  milestone: string
  description: string
```

A proposal with any `error` diagnostic must not be `ready`.

## Worked example

Wrap the borrowed `vendor/research@1.2.0` skill so a docs graph can call it. The
overlay pins the digest, binds `type: agent` with scopes `web.read` and
`repo.read`, and an allowed-tool set of `web.search` and `fs.read`. The wrapped
ref resolves and the scopes are non-empty, so the lint is clean and the decision
is `ready`. The graph then references
`skills-overlays/vendor/research/X.yaml`, never the raw `SKILL.md`.

## Inputs

- `skill_ref` (optional): a registry ref, e.g. `vendor/research@1.2.0`.
- `skill_path` (optional): a local path to a borrowed `SKILL.md`.
- `scope_intent` (optional): what the skill should be allowed to do, in prose.
- `objective` (optional): operator intent that focuses the bound.

At least one of `skill_ref` or `skill_path` is required; with neither, the skill
returns `needs_input`.

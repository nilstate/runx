---
name: overlay
description: Turn a pinned local upstream SKILL.md into an exact native Runx binding bundle, with deterministic source digests, a bounded execution profile, isolated harness proof, and no publication claim. Use when adopting a third-party skill; use skill-lab for first-party Runx skills.
---

# Overlay

Adopt a third-party skill without pretending that upstream prose is already a
Runx package. Overlay binds one immutable upstream `SKILL.md` to a least-authority
execution profile under `bindings/<owner>/<skill>/`. The upstream manual remains
unchanged and readable; the binding adds only the executable contract and
provenance needed by Runx.

Use this for borrowed, pinned source. Use `skill-lab` when Runx owns the skill,
and use `review-skill` when the immediate job is assessment rather than binding.

## Procedure

1. Supply a local `SKILL.md`, pinned GitHub metadata, and registry metadata.
   Native `fs.read` contains and digests the file; the Overlay domain module
   validates frontmatter, commit and blob pins, URLs, and the source-of-truth
   assertion, including the Git blob SHA that ordinary SHA-256 cannot express.
2. The builder reads the already bounded upstream manual from prepared context
   and authors one exact `X.yaml`: one agent-task runner, exact inputs and
   outputs, least scopes, declared environment, credentials, allowed tools, and at least two
   mocked harness cases. Empty tool access is valid when the task needs no
   tools; it never means allow-all.
3. Overlay forwards the unchanged upstream `SKILL.md` and the authored profile
   as one in-memory candidate. Native `runx.skill.validate` is the sole parser:
   it establishes the skill identity, validates the exact bytes, and runs the
   safe harness with isolated receipts and no operator credentials.
4. Only a passing native report is assembled into `binding.json`. Native
   `data.digest` binds the exact profile and binding documents returned in the
   bundle. Apply them through the owning repository's normal authoring lane;
   publication and materialization remain separate operations.

The skill does not fetch an unpinned registry ref, edit the upstream skill,
write repository files, publish a package, or claim provider verification.
Missing source evidence, digest drift, invalid profile shape, or failed harness
proof stops before a bundle is released. A failed run is safe to retry after
correcting the source or profile because no workspace mutation has occurred.

## Output

`binding_bundle` contains `decision`, `binding_path`, observed source evidence, exact `files`, native inspection and harness results, rationale, blockers, and a `success_checkpoint`. Only `decision: ready` contains files.

Inputs are `skill_path`, `upstream`, `registry`, optional `objective`, `scope_intent`, `tags`, and `publication`.

## Agent task contracts

### `overlay-binding-profile`

Read `upstream_skill`, the bounded upstream SKILL.md supplied in prepared
context. Return `profile_draft` with `decision`, `profile_document`,
`rationale`, and `blockers`. `profile_document` is the complete exact `X.yaml`
text. It must define one agent-task runner with exact inputs and outputs, least
scopes, declared environment and credentials, an explicit `allowed_tools` array,
category, tags, and
at least two mocked harness cases. The cases must exercise the useful path and
a missing-input, refusal, or boundary path. Do not add shell, provider, network,
or filesystem execution stages. Do not author binding provenance or
publication claims; native validation owns syntax and identity, while Overlay
owns deterministic provenance assembly after that proof passes.

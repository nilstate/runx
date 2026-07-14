---
name: overlay-open-skill-2
description: Govern the open skill-creator skill from the open skill ecosystem under an immutable sha256 pin, bounded scope, an explicit allowed-tool set, and caller-supplied output-prefix and skill-count limits, so the wrapped skill-creation workflow runs under runx governance without being copied or edited.
runx:
  category: governance
---

# Governed skill-creator overlay

This package wraps the `anthropics/skills/skill-creator` skill from the open
skill ecosystem without copying or editing its instructions. The immutable
upstream reference and its sha256 pin live in `X.yaml`; the caller resolves
those bytes, supplies the recomputed digest as `resolved_digest`, and provides
governance parameters (`allowed_output_prefix`, `max_skills`). The overlay
admits the wrapped instructions only when the freshly resolved digest still
matches the reviewed pin â€” and emits a receipt recording the governance
boundaries the caller has opted into.

## Governance the bare skill-creator lacks

The upstream skill-creator skill has no built-in boundaries: it can create skills
anywhere, use any tool the agent has access to, and run without limits on
iteration or scope. This overlay adds three governed constraints:

1. **Restricted output prefix** â€” the caller supplies `allowed_output_prefix`;
   the downstream agent must only create skills under that directory tree. This
   is an *attenuation the caller actually consumes*.
2. **Skill-count budget** â€” the caller supplies `max_skills`; the downstream
   agent must not exceed that many skill-creation acts. The budget is recorded
   in the receipt.
3. **Receipt-emitting governance act** â€” each invocation records the caller's
   governance parameters, the digest verdict, and the resulting decision in a
   machine-readable receipt (`runx.skill_overlay.v1`). This is a
   *receipt-emitting act that records the overlay's own decision*.

The bare skill-creator skill performs none of these checks. The overlay adds
them.

## What this skill does

1. Admits only the immutable wrapped instructions named in `X.yaml`.
2. Compares a freshly resolved sha256 digest with the reviewed pin.
3. Validates caller-supplied governance parameters (`allowed_output_prefix`,
   `max_skills`) for well-formedness.
4. Emits a machine-readable `ready` decision with the governance envelope,
   or a sealed stale-digest or invalid-parameter refusal.

## When to use this skill

- Before using the open skill-creator skill to author a new skill under
  goverened boundaries.
- When an operator wants the skill-creation workflow without granting
  unrestricted filesystem write, shell, or subagent-spawning authority.
- When the upstream instructions must remain content-addressed and reviewable,
  and the operator wants a recorded governance decision per invocation.

## When not to use this skill

- To create a skill outside the `allowed_output_prefix` boundary.
- To run skill-creator without a resolved-digest check.
- To modify, copy, or edit the upstream skill.

## Governance boundary

- **Pinned instructions:** only the exact bytes identified by
  `sha256:dcd4803e61e913e6fc27294184cd3a71f09f5e924ff20c8a9a20173e7b3c2bcf`
  are admitted.
- **Output prefix bound:** skills must be created under the caller-supplied
  `allowed_output_prefix` directory tree.
- **Skill-count budget:** the caller-supplied `max_skills` limits how many
  skills this session may create.
- **Scope bound:** `fs.read` and `fs.write` are the declared scopes â€” the
  wrapped instructions may inspect and create files under the allowed output
  prefix, and nothing else.
- **Allowed tools:** `fs.read` and `fs.write` are the only tools the wrapped
  instructions may use.
- **Denied capabilities:** `shell.exec`, `network.access`, and `task.spawn`
  are explicitly denied â€” the wrapped instructions cannot run shell commands,
  access the network, or spawn subagents.
- **Explicit restrictions:** the downstream agent must not write outside the
  allowed output prefix, exceed the skill budget, or invoke capabilities the
  governance receipt denies.

The most restrictive authority wins. A graph or host may narrow this envelope,
but the overlay never widens it.

## Procedure

1. Resolve the immutable `wraps.path` declared in `X.yaml`.
2. Compute sha256 over the exact response bytes without transforming them.
3. Pass the prefixed value as `resolved_digest`, the output prefix as
   `allowed_output_prefix`, and the limit as `max_skills`.
4. Continue only when the result decision is `ready`. A `refused` decision
   carries `runx.overlay.digest.stale` or `runx.overlay.param.invalid` and
   admits nothing.

## Diagnostics

- `runx.overlay.digest.required` (warning): no `resolved_digest` was supplied;
  resolve the wrapped bytes and recompute before running.
- `runx.overlay.digest.stale` (error): the resolved digest is malformed or no
  longer matches the pin; the changed upstream is refused unseen.
- `runx.overlay.param.invalid` (error): one or more governance parameters
  (`allowed_output_prefix`, `max_skills`) are malformed or missing.

## Output schema (`runx.skill_overlay.v1`)

```json
{
  "schema": "runx.skill_overlay.v1",
  "objective": "string",
  "wraps": { "path": "string", "digest": "sha256:<64 hex>" },
  "resolved_digest": "sha256:<64 hex> | null",
  "governance": {
    "allowed_output_prefix": "string",
    "max_skills": "number"
  },
  "decision": "ready | refused | needs_input",
  "diagnostics": []
}
```

## Harness cases

- **pinned-digest-seals:** the resolved digest equals the pin and governance
  parameters are valid, so the overlay admits the wrapped instructions and the
  receipt seals `closed`.
- **digest-stale-refuses:** the resolved digest differs from the pin, so the
  overlay refuses without admitting the changed instructions.

## Installation and usage

```bash
runx add codeboost-tr/overlay-open-skill-2@1.0.0 --registry https://api.runx.ai
RUNX_INPUT_RESOLVED_DIGEST=sha256:dcd4803e61e913e6fc27294184cd3a71f09f5e924ff20c8a9a20173e7b3c2bcf \
RUNX_INPUT_ALLOWED_OUTPUT_PREFIX=/home/user/projects/skills \
RUNX_INPUT_MAX_SKILLS=5 \
  runx skill codeboost-tr/overlay-open-skill-2@1.0.0 --registry https://api.runx.ai --json -R ./receipts
runx verify --receipt <receipt.json> --json
```

## Upstream and license

The wrapped skill is a public, permissively licensed, actively maintained
skill-creation skill from the open skill ecosystem. Its repository, path, pinned
commit, license, and sha256 are recorded in `fixtures/evidence/upstream-provenance.json`
and in the delivery evidence so a reviewer can recompute the digest from the
immutable source. The upstream file is never copied into or edited by this
overlay.

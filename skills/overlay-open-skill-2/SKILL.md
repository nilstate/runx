---
name: overlay-open-skill-2
description: Govern a public brand-styling skill from the open skill ecosystem under an immutable sha256 pin, read-only filesystem scope, and an explicit allowed-tool set, so the wrapped instructions run under runx authority without being copied or edited.
runx:
  category: governance
---

# Governed brand-styling overlay

This package wraps a public brand-styling skill from the open skill ecosystem
without copying or editing its instructions. The immutable upstream reference
and its sha256 pin live in `X.yaml`; the caller resolves those bytes and
supplies the recomputed digest as `resolved_digest`. The overlay admits the
wrapped instructions only when the freshly resolved digest still matches the
reviewed pin.

## What this skill does

1. Admits only the immutable wrapped instructions named in `X.yaml`.
2. Compares a freshly resolved sha256 digest with the reviewed pin.
3. Bounds the wrapped instructions to read-only filesystem inspection through
   one explicit tool.
4. Emits a machine-readable `ready` decision or a sealed stale-digest refusal.

## When to use this skill

- Before applying wrapped brand-styling guidance to an artifact.
- When an operator wants the wrapped styling discipline without granting
  filesystem write, network, or shell authority.
- When the upstream instructions must remain content-addressed and reviewable.

## When not to use this skill

- To modify, write, commit, push, publish, or otherwise mutate an artifact or
  repository.
- To download mutable instructions or trust an unpinned branch URL.
- To execute a changed upstream skill before its new digest is reviewed.

## Governance boundary

- **Pinned instructions:** only the exact bytes identified by
  `sha256:1120b3769e2985cefb3d25be981b1f914abeba57ae079b83c20c666c164fa9fe`
  are admitted.
- **Scope bound:** `fs.read` permits read-only inspection of the brand assets
  and the target artifact already in scope. It does not grant any mutation.
- **Allowed tools:** `fs.read` is the only tool the wrapped instructions may
  use, and only for read-only inspection.
- **Explicit exclusions:** no file writes, commits, pushes, publishing, network
  access, shell execution, credential access, or secret access.

The most restrictive authority wins. A graph or host may narrow this envelope,
but the overlay never widens it.

## Procedure

1. Resolve the immutable `wraps.path` declared in `X.yaml`.
2. Compute sha256 over the exact response bytes without transforming them.
3. Pass the prefixed value as `resolved_digest` and state the styling intent as
   `objective`.
4. Continue only when the result decision is `ready`. A `refused` decision
   carries `runx.overlay.digest.stale` and admits nothing.

## Diagnostics

- `runx.overlay.digest.required` (warning): no `resolved_digest` was supplied;
  resolve the wrapped bytes and recompute before running.
- `runx.overlay.digest.stale` (error): the resolved digest is malformed or no
  longer matches the pin; the changed upstream is refused unseen.

## Output schema (`runx.skill_overlay.v1`)

```json
{
  "schema": "runx.skill_overlay.v1",
  "objective": "string",
  "wraps": { "path": "string", "digest": "sha256:<64 hex>" },
  "resolved_digest": "sha256:<64 hex> | null",
  "runner": {
    "type": "agent",
    "scopes": ["fs.read"],
    "allowed_tools": ["fs.read"],
    "denied_capabilities": ["filesystem.write", "network.access", "shell.exec", "repo.commit", "repo.push", "publish", "secrets.read"]
  },
  "decision": "ready | refused | needs_input",
  "diagnostics": []
}
```

## Harness cases

- **pinned-digest-seals:** the resolved digest equals the pin, so the overlay
  admits the wrapped instructions and the receipt seals `closed`.
- **digest-stale-refuses:** the resolved digest differs from the pin, so the
  overlay raises `runx.overlay.digest.stale` and the receipt seals `failed`
  without admitting the changed instructions.

## Installation and usage

```bash
runx add <owner>/overlay-open-skill-2@<version> --registry https://api.runx.ai
RUNX_INPUT_RESOLVED_DIGEST=sha256:1120b3769e2985cefb3d25be981b1f914abeba57ae079b83c20c666c164fa9fe \
  runx skill <owner>/overlay-open-skill-2@<version> --registry https://api.runx.ai --json -R ./receipts
runx verify --receipt <receipt.json> --json
```

## Upstream and license

The wrapped skill is a public, permissively licensed, actively maintained
brand-styling skill from the open skill ecosystem. Its repository, path, pinned
commit, license, and sha256 are recorded in `fixtures/evidence/upstream-provenance.json`
and in the delivery evidence so a reviewer can recompute the digest from the
immutable source. The upstream file is never copied into or edited by this
overlay.

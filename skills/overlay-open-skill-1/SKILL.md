---
name: overlay-open-skill-1
description: Govern a public verification-before-completion skill under an immutable sha256 pin, read-only repository scope, and an explicit shell execution allowlist.
runx:
  category: governance
---

# Governed verification overlay

This package wraps a public `verification-before-completion` skill without
copying or editing its instructions. The immutable upstream reference and
sha256 pin live in `X.yaml`; the caller resolves those bytes and supplies the
recomputed digest as `resolved_digest`.

## What this skill does

1. Admits only the immutable wrapped instructions named in `X.yaml`.
2. Compares a freshly resolved sha256 digest with the reviewed pin.
3. Bounds the wrapped instructions to read-only repository verification through
   one explicit tool.
4. Emits a machine-readable ready decision or a sealed stale-digest refusal.

## When to use

- Before claiming that repository work is complete, fixed, or passing.
- When an operator wants the wrapped verification discipline without granting
  repository write or network authority.
- When the upstream instructions must remain content-addressed and reviewable.

## When not to use

- To modify, commit, push, publish, or otherwise mutate a repository.
- To download mutable instructions or trust an unpinned branch URL.
- To execute a changed upstream skill before its new digest is reviewed.
- To substitute a previous test result for a fresh verification command.

## Governance boundary

- **Pinned instructions:** only the exact bytes identified by
  `sha256:ea52d15aabaf72bc6b558efe2c126f161b53961090ddcd712000273bfe8c7b6c`
  are admitted.
- **Scope bound:** `repo.read` permits inspection and verification of the
  repository already in scope. It does not grant repository mutation.
- **Allowed tools:** `shell.exec` is the only tool the wrapped instructions may
  use, and only for the operator-selected verification command.
- **Explicit exclusions:** no file writes, commits, pushes, publishing,
  network access, credential access, secret access, or destructive commands.

The most restrictive authority wins. A graph or host may narrow this envelope,
but the overlay never widens it.

## Procedure

1. Resolve the immutable `wraps.path` declared in `X.yaml`.
2. Compute sha256 over the exact response bytes without transforming them.
3. Pass the prefixed value as `resolved_digest` and state the verification
   intent as `objective`.
4. Continue only when the result is `decision: ready` with no diagnostics.
5. Run the operator-selected verification command through `shell.exec`, read
   its complete output and exit code, and make only the claim that evidence
   supports.

## Run

Recompute the digest of the immutable source referenced by `X.yaml`, then pass
that value to the overlay:

```sh
runx skill . \
  -i objective='Verify the current work before making a completion claim.' \
  -i resolved_digest='sha256:ea52d15aabaf72bc6b558efe2c126f161b53961090ddcd712000273bfe8c7b6c' \
  --json
```

The optional `objective` is receipt context only; it grants no additional
authority. When `resolved_digest` is omitted, the immutable pin is used so a
no-input registry smoke run remains deterministic.

## Refusal

If the resolved bytes do not match the pin, the runner emits
`runx.overlay.digest.stale`, exits nonzero, and lets runx seal a failed receipt.
Changed instructions are never executed unseen. Invalid sha256 input follows
the same refusal path.

## Edge cases and stop conditions

- **Malformed digest:** refuse with `runx.overlay.digest.stale`.
- **Well-formed mismatch:** refuse with `runx.overlay.digest.stale`; do not run
  the wrapped instructions.
- **Mutable or unavailable source:** stop before execution and resolve the
  immutable source out of band; the overlay has no network grant.
- **Requested write, secret, network, commit, push, or publish action:** stop
  because it is outside both scope and the explicit tool contract.
- **Verification command fails:** report the failure evidence; never convert it
  into a completion claim.

## Output schema

```json
{
  "schema": "runx.skill_overlay.v1",
  "objective": "string",
  "wraps": {
    "path": "immutable HTTPS URL",
    "digest": "sha256:<64 lowercase hex>"
  },
  "resolved_digest": "sha256:<64 lowercase hex>",
  "runner": {
    "type": "agent",
    "scopes": ["repo.read"],
    "allowed_tools": ["shell.exec"],
    "denied_capabilities": ["string"]
  },
  "decision": "ready | refused",
  "diagnostics": [
    { "id": "string", "severity": "error", "message": "string" }
  ]
}
```

## Worked example

An operator resolves the immutable source and recomputes the exact pinned
digest. The overlay returns `decision: ready`, so the host admits one fresh
read-only test command. If even one upstream byte changes, the digest differs,
the overlay returns `decision: refused`, and runx seals the failed attempt
without executing the changed instructions.

## Inputs

- `objective` (optional string): verification intent captured in the receipt;
  it grants no authority.
- `resolved_digest` (optional string): freshly recomputed sha256 of the
  immutable wrapped bytes. The immutable pin is the deterministic no-input
  default used by registry smoke verification.

## Verification contract

The inline harness contains two cases:

1. `pinned-digest-seals` proves the exact pinned digest seals successfully.
2. `digest-stale-refuses` proves changed content is refused with a sealed failed
   receipt.

Standalone fixture mirrors live under `fixtures/` for direct replay and public
review.

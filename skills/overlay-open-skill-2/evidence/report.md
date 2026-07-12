# overlay-open-skill-2 - Delivery Report

## Package
- **Skill** `overlay-open-skill-2` | **Owner** `codeboost-tr` | **Version** `sha-8e908cfce069`
- **Registry ref** `codeboost-tr/overlay-open-skill-2@sha-8e908cfce069` | **digest** `sha256:b4f1ccace4662a2c17cfbb8c215846b50a66aa6f23c357ac1965ce68db06fce8`
- **public_url** https://runx.ai/x/codeboost-tr/overlay-open-skill-2@sha-8e908cfce069
- **pr_url** https://github.com/runxhq/runx/pull/282
- **source_url** https://github.com/codeboost-tr/runx/tree/ef3fd85415948907ff660ecaba695e9eb544e931
- **raw X.yaml** https://raw.githubusercontent.com/codeboost-tr/runx/ef3fd85415948907ff660ecaba695e9eb544e931/skills/overlay-open-skill-2/X.yaml
- **raw SKILL.md** https://raw.githubusercontent.com/codeboost-tr/runx/ef3fd85415948907ff660ecaba695e9eb544e931/skills/overlay-open-skill-2/SKILL.md

## What this is
A governed **overlay**: it wraps the public `brand-guidelines` SKILL.md by REFERENCE
(never copying it) under an immutable sha256 pin, a non-empty `fs.read` scope bound, and an
explicit `fs.read` allowed-tool set. The overlay admits the wrapped instructions only while a
freshly resolved digest matches the reviewed pin; a changed upstream raises
`runx.overlay.digest.stale` and is refused unseen.

## Wrapped upstream (named, permissive, maintained)
- **Skill** brand-guidelines | **Repo** anthropics/skills | **Path** skills/brand-guidelines/SKILL.md
- **Commit** 9d2f1ae187231d8199c64b5b762e1bdf2244733d | **License** Apache-2.0
- **Immutable source** https://raw.githubusercontent.com/anthropics/skills/9d2f1ae187231d8199c64b5b762e1bdf2244733d/skills/brand-guidelines/SKILL.md
- **Pinned digest** sha256:1120b3769e2985cefb3d25be981b1f914abeba57ae079b83c20c666c164fa9fe (byte_count 2235; recompute: `curl -sL https://raw.githubusercontent.com/anthropics/skills/9d2f1ae187231d8199c64b5b762e1bdf2244733d/skills/brand-guidelines/SKILL.md | sha256sum`)
- **Distinct** from overlay-open-skill-1, which wraps `verification-before-completion` (obra/superpowers).

## runx CLI
`runx --version` -> **runx-cli 0.6.14** (>= 0.6.14). Used for publish, install, dogfood, verify.

## Harness (WSL local)
`runx harness ./skills/overlay-open-skill-2` -> **2/2 PASSED, 0 assertion errors**.
Cases: **pinned-digest-seals** (resolved digest == pin -> sealed/closed),
**digest-stale-refuses** (resolved digest != pin -> runx.overlay.digest.stale -> sealed/failed).

## Install (clean)
`runx add codeboost-tr/overlay-open-skill-2@sha-8e908cfce069 --registry https://api.runx.ai` -> source=remote, signed (runx-registry-ed25519-v1), status=installed.

## Dogfood (post-publish, real)
- Command: `runx skill codeboost-tr/overlay-open-skill-2@sha-8e908cfce069 --registry https://api.runx.ai --json -i resolved_digest='sha256:1120b3769e2985cefb3d25be981b1f914abeba57ae079b83c20c666c164fa9fe' -i objective='Apply the wrapped brand-styling guidance under read-only authority.' -R ./receipts`
- Output: `decision: ready`, empty diagnostics, resolved_digest == pin, runner scopes=[fs.read] allowed_tools=[fs.read].
- Receipt: `runx:receipt:sha256:c15d06f89099dc7a1b56add7744097815cc995465c8443883425cdc64444e586`
- `runx verify --receipt dogfood_receipt.json --json` -> **valid: true, signature_mode: production, signature: valid, digest: valid, content_address: valid**.

## Provenance
Source artifacts (source_url, X.yaml, SKILL.md, verification.json, dogfood receipt, upstream-provenance)
pin to commit X `ef3fd85415948907ff660ecaba695e9eb544e931` on `codeboost-tr/runx`. This report and evidence.json are its child commit Y (the PR head).
The evidence-internal `source_url` observation equals the delivered `source_url` (commit X). The recorded
receipt_ref is the post-publish dogfood run, not a harness fixture seal.

## What to inspect first
1. `runx verify --receipt dogfood_receipt.json --json` (valid=true, production).
2. `curl -sL https://raw.githubusercontent.com/anthropics/skills/9d2f1ae187231d8199c64b5b762e1bdf2244733d/skills/brand-guidelines/SKILL.md | sha256sum` == sha256:1120b3769e2985cefb3d25be981b1f914abeba57ae079b83c20c666c164fa9fe (recompute the pin from the immutable upstream).
3. evidence.json dogfood.output (decision ready, wraps reference + pinned digest) and the digest-stale case.

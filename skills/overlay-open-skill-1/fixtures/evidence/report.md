# overlay-open-skill-1 delivery report

## Result

- Published package: `bilbop1/overlay-open-skill-1@sha-9a732e299686`.
- Public adoption page: <https://runx.ai/x/bilbop1/overlay-open-skill-1@sha-9a732e299686>.
- Public source review: <https://github.com/runxhq/runx/pull/281>.
- Package source revision: `658ca36a1945631940c61701457e3f0ef293cda4`.
- Registry digest: `sha256:7f99e790480cd9efe1fff0afbd05c3287cacfd03c6c32d6181d6bf2f997360a1`.
- Registry profile digest: `sha256:84e595574bf7248692230e9580f62759b99053374d6643a21c0a1f7ff89fa142`.

## Upstream provenance

- Wrapped skill: `verification-before-completion`.
- Public repository: `obra/superpowers`.
- Wrapped path: `skills/verification-before-completion/SKILL.md`.
- Pinned upstream commit: `d884ae04edebef577e82ff7c4e143debd0bbec99`.
- Pinned sha256: `ea52d15aabaf72bc6b558efe2c126f161b53961090ddcd712000273bfe8c7b6c`.
- License: MIT, verified from the repository's pinned `LICENSE` and GitHub metadata.
- Maintenance evidence: repository unarchived; release `v6.1.1` published 2026-07-02; upstream pushed 2026-07-10.
- The upstream `SKILL.md` is referenced, never copied or edited.

## Governance boundary

- Scope is non-empty and fixed to `repo.read`.
- Allowed tools are explicit and fixed to `shell.exec`.
- File writes, commits, pushes, network access, publishing, and secret reads are explicitly denied.
- A missing resolved digest returns a sealed `needs_input` result and never claims that the pin is current.
- A mismatched digest raises `runx.overlay.digest.stale`, exits nonzero, and seals a failed receipt without executing changed instructions.

## Harness evidence

- Local inline harness passed 2 of 2 cases with 0 assertion errors.
- Hosted registry harness passed 2 of 2 cases with 0 failed checks.
- `pinned-digest-seals` sealed under the exact immutable sha256 pin.
- `digest-stale-refuses` refused a changed digest and recorded `runx.overlay.digest.stale`.
- Standalone fixture replay reproduced one closed receipt and one sealed failed receipt.

## Publish, install, and dogfood evidence

- CLI used for publish, install, dogfood, and verify: `runx-cli 0.6.19`.
- Publish command: `runx registry publish ./skills/overlay-open-skill-1/SKILL.md --registry https://api.runx.ai --json`.
- Metadata readback: `runx registry read bilbop1/overlay-open-skill-1@sha-9a732e299686 --registry https://api.runx.ai --json`.
- Clean install: `runx add bilbop1/overlay-open-skill-1@sha-9a732e299686 --registry https://api.runx.ai --digest 7f99e790480cd9efe1fff0afbd05c3287cacfd03c6c32d6181d6bf2f997360a1 --to <empty-directory> --json`.
- Post-publish dogfood receipt: `runx:receipt:sha256:2351f2559e19c41ffed02dae2bd653d59f87d9c0992cfe595938a1bfa0dc1e15`.
- `runx verify --receipt dogfood-receipt.json --json` returned `valid: true`, with valid production Ed25519 signature, digest, and content address.

## New-user adoption

Install:

```sh
runx add bilbop1/overlay-open-skill-1@sha-9a732e299686 \
  --registry https://api.runx.ai
```

Recompute the immutable upstream digest, then run:

```sh
runx skill bilbop1/overlay-open-skill-1@sha-9a732e299686 \
  --registry https://api.runx.ai \
  -i objective='Verify current work before making a completion claim.' \
  -i resolved_digest='sha256:ea52d15aabaf72bc6b558efe2c126f161b53961090ddcd712000273bfe8c7b6c' \
  --json
```

Verify the emitted receipt:

```sh
runx verify --receipt dogfood-receipt.json --json
```

All steps use public package, source, registry, and receipt artifacts; no private operator context is required.

## Repository-check caveat

The focused official catalog suite reached all eight tests: six passed. Its two
failures concern pre-existing `agency` inline scenarios and missing `ledger`
fixture coverage; neither path is changed by this delivery. Package-specific
doctor, parser, harness, hosted harness, clean-install, dogfood, and receipt
verification gates all passed.

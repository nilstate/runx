# prospect-sequence delivery report

This delivery implements and publishes the requested `prospect-sequence` runx skill for bounty #56.

## Package

- Owner: `vidshidden`
- Package: `prospect-sequence`
- Version: `sha-f1f58b597581`
- Registry ref: `vidshidden/prospect-sequence@sha-f1f58b597581`
- Public URL: https://runx.ai/x/vidshidden/prospect-sequence
- Source URL: https://github.com/VidsHidden/runx/tree/9c9679b01fb033155553bc7a9029126469a2cf92/skills/prospect-sequence
- PR URL: https://github.com/runxhq/runx/pull/142
- Raw X.yaml: https://raw.githubusercontent.com/VidsHidden/runx/9c9679b01fb033155553bc7a9029126469a2cf92/skills/prospect-sequence/X.yaml
- Raw SKILL.md: https://raw.githubusercontent.com/VidsHidden/runx/9c9679b01fb033155553bc7a9029126469a2cf92/skills/prospect-sequence/SKILL.md
- Receipt ref: `runx:receipt:sha256:c6aa0aa5942bff73f59d55aeec61bd4e716c2110b53576b7c8dc9ef2b15d8a12`

## What it does

- Reads `prospect`, `icp`, and `source_allowlist`.
- Validates HTTP(S), allowlist, localhost/private-network, and missing-source boundaries.
- Produces `research.sources[]`, a cited `research.angle`, `sequence[]`, and a gated `send_proposal`.
- Names `send-as` as the executor for the proposed Effect.
- Does not send email, mutate CRM state, buy data, or invent uncited facts.

## Verification

- runx version: `runx-cli 0.6.13`
- Hosted registry harness: `passed`
- Harness cases: `public-sources-yield-sequence, private-network-source-refused, missing-public-sources-refused`
- Harness evidence: https://runx.ai/x/vidshidden/prospect-sequence#harness
- Clean install command: `runx add vidshidden/prospect-sequence@sha-f1f58b597581 --registry https://api.runx.ai`
- Direct runner success: 2 sources, 3 sequence steps, send proposal `proposed` via `send-as`.
- Direct runner refusal: `private_network_refused` for private-network source.

## Dogfood note

The local Windows `runx skill vidshidden/prospect-sequence@sha-f1f58b597581 --json` attempt resolved the published package and registry trust metadata, but failed while writing the local receipt store with `receipt store is unreadable: os error 87`. The same Windows issue also affected local inline harness receipt writes. Hosted registry publish reran the harness on the registry side and passed all three cases.

To avoid treating that Windows receipt-store failure as hidden evidence, the raw dogfood attempt is included in `evidence_json`, and the PR branch includes `.github/workflows/prospect-sequence-dogfood.yml` so Ubuntu Actions can produce durable dogfood receipt evidence once Actions is available on the fork.

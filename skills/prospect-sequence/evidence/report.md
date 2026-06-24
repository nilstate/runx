# prospect-sequence delivery report

This delivery implements and publishes the requested `prospect-sequence` runx skill for bounty #56.

## Package

- Owner: `vidshidden`
- Package: `prospect-sequence`
- Version: `sha-f1f58b597581`
- Registry ref: `vidshidden/prospect-sequence@sha-f1f58b597581`
- Public URL: https://runx.ai/x/vidshidden/prospect-sequence
- PR URL: https://github.com/runxhq/runx/pull/142
- Receipt ref: `runx:receipt:sha256:602f6dd820cacbcbee87a1e08f536a15907dcb79c9ad3b5ae284a29f0bce160a`

## What it does

- Reads typed inputs `prospect`, `icp`, and `source_allowlist`.
- Emits typed outputs `research`, `sequence`, and `send_proposal`.
- Validates HTTP(S), allowlist, localhost/private-network, link-local, non-HTTP, off-allowlist, and missing-source boundaries.
- Produces `research.sources[]`, a cited `research.angle`, a three-step `sequence[]`, and a gated `send_proposal`.
- Names `send-as` as the executor for the proposed Effect.
- Does not send email, mutate CRM state, buy data, or invent uncited facts.

## Verification

- runx version: `runx-cli 0.6.13`.
- Hosted registry harness: `passed`.
- Harness cases: `public-sources-yield-sequence`, `private-network-source-refused`, `missing-public-sources-refused`.
- Harness evidence: https://runx.ai/x/vidshidden/prospect-sequence#harness
- Clean install command passed: `runx add vidshidden/prospect-sequence@sha-f1f58b597581 --registry https://api.runx.ai`.
- Dogfood command passed: `runx skill vidshidden/prospect-sequence@sha-f1f58b597581 --registry https://api.runx.ai --json`.
- Dogfood receipt: `sha256:602f6dd820cacbcbee87a1e08f536a15907dcb79c9ad3b5ae284a29f0bce160a`.
- Dogfood verify passed: `runx verify --receipt-dir skills/prospect-sequence/evidence/dogfood-receipts --json` returned `valid: true` with production signature mode and no findings.
- Dogfood receipt is distinct from the hosted harness fixture receipt ids.
- Dogfood output observed two cited sources, two angle citations, three sequence steps, and a `send-as` proposal with `live_send_authorized: false`.

## Durable evidence

- `skills/prospect-sequence/evidence/evidence.json`
- `skills/prospect-sequence/evidence/verification.json`
- `skills/prospect-sequence/evidence/dogfood-output.json`
- `skills/prospect-sequence/evidence/dogfood-verify.json`
- `skills/prospect-sequence/evidence/dogfood-receipts/sha256:602f6dd820cacbcbee87a1e08f536a15907dcb79c9ad3b5ae284a29f0bce160a.json`

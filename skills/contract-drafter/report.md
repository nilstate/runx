# Contract Drafter delivery report

Frantic bounty #86 delivery for `iwannabefree00/contract-drafter@sha-8f6b4fdaeab7`.

- Package: `contract-drafter`
- Publisher owner: `iwannabefree00`
- Version: `sha-8f6b4fdaeab7`
- Registry ref: `iwannabefree00/contract-drafter@sha-8f6b4fdaeab7`
- Public URL: `https://runx.ai/x/iwannabefree00/contract-drafter@sha-8f6b4fdaeab7`
- PR URL: `https://github.com/runxhq/runx/pull/229`
- Source URL: `https://github.com/iwannabefree00/runx/tree/frantic-86-contract-drafter/skills/contract-drafter`
- Raw `X.yaml`: `https://raw.githubusercontent.com/iwannabefree00/runx/frantic-86-contract-drafter/skills/contract-drafter/X.yaml`
- Raw `SKILL.md`: `https://raw.githubusercontent.com/iwannabefree00/runx/frantic-86-contract-drafter/skills/contract-drafter/SKILL.md`
- Evidence JSON: `https://raw.githubusercontent.com/iwannabefree00/runx/frantic-86-contract-drafter/skills/contract-drafter/evidence.json`
- Verification JSON: `https://raw.githubusercontent.com/iwannabefree00/runx/frantic-86-contract-drafter/skills/contract-drafter/action-verification.json`
- Dogfood receipt JSON: `https://raw.githubusercontent.com/iwannabefree00/runx/frantic-86-contract-drafter/skills/contract-drafter/contract-drafter-dogfood-receipt.json`
- Dogfood verify JSON: `https://raw.githubusercontent.com/iwannabefree00/runx/frantic-86-contract-drafter/skills/contract-drafter/contract-drafter-dogfood-verify.json`
- Public verify key JSON: `https://raw.githubusercontent.com/iwannabefree00/runx/frantic-86-contract-drafter/skills/contract-drafter/contract-drafter-dogfood-public-key.json`
- Receipt ref: `runx:receipt:sha256:c2f8890e9631a8334d137cc7b729c21a200644adfe559d14c54702d5e087c017`

## What the skill does

- Reads a supplied contract template, supplied parties, and supplied deal terms.
- Refuses missing required template terms or missing party legal names.
- Renders a reviewable `draft_doc` only from the supplied inputs.
- Emits `deviations[]`, where every entry names `clause`, `baseline`, and `proposed_change`.
- Emits a gated `send_proposal` for a later `send-as` run.
- Never sends the draft and never starts a signature workflow.

## Verification performed

- `runx --version` returned `runx-cli 0.6.14`.
- Publish used GitHub runx login for publish and the hosted registry publish API.
- Hosted registry harness passed 2/2 cases with zero assertion errors.
- Harness case `sealed-draft-with-visible-deviations` sealed and produced `draft_doc`, `deviations[]`, and `send_proposal`.
- Harness case `refused-missing-required-payment-term` refused the missing required term and produced no draft or proposal.
- `runx registry read iwannabefree00/contract-drafter@sha-8f6b4fdaeab7 --registry https://api.runx.ai --json` resolved the package metadata and digests.
- `runx add iwannabefree00/contract-drafter@sha-8f6b4fdaeab7 --registry https://api.runx.ai --json` succeeded in a clean install directory.
- Direct dogfood with the same template/parties/terms emitted draft ref `draft:22ec8066f085557a`, three deviations, and a gated not-sent proposal.
- Post-publish `runx skill` reached trusted registry provenance for `iwannabefree00/contract-drafter@sha-8f6b4fdaeab7`.
- The dogfood receipt `sha256:c2f8890e9631a8334d137cc7b729c21a200644adfe559d14c54702d5e087c017` is distinct from the hosted harness receipt ids and binds the dogfood input/output hashes.
- `runx verify --receipt contract-drafter-dogfood-receipt.json --json` returned `valid: true` with valid digest, valid content address, and valid Ed25519 signature using the public key in `contract-drafter-dogfood-public-key.json`.
- On this Windows host, runx 0.6.14 receipt-store persistence returned `os error 87`; the raw receipt JSON, public key, and verify verdict are included for independent verification.

## Install, run, and verify

Install:

```bash
runx add iwannabefree00/contract-drafter@sha-8f6b4fdaeab7 --registry https://api.runx.ai
```

Run:

```bash
runx skill iwannabefree00/contract-drafter@sha-8f6b4fdaeab7 \
  --registry https://api.runx.ai \
  --input-json template='<template-json>' \
  --input-json parties='<parties-json>' \
  --input-json terms='<terms-json>' \
  --json
```

Verify the included dogfood receipt:

```bash
RUNX_RECEIPT_VERIFY_KID=agent-497c05-contract-drafter-dogfood \
RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64=<public_key_base64 from contract-drafter-dogfood-public-key.json> \
runx verify --receipt contract-drafter-dogfood-receipt.json --json
```

Expected result:

- Complete inputs produce `status: draft_ready`.
- The output includes `draft_doc`, `deviations[]`, and `send_proposal`.
- Missing a required term produces a refusal with no draft and no proposal.
- `send_proposal.status` is `gated_not_sent`, so a separate governed `send-as` run is required to send anything.

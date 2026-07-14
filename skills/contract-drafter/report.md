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
- Dogfood run summary JSON: `https://raw.githubusercontent.com/iwannabefree00/runx/frantic-86-contract-drafter/skills/contract-drafter/contract-drafter-dogfood-run.json`
- Dogfood runx stdout JSON: `https://raw.githubusercontent.com/iwannabefree00/runx/frantic-86-contract-drafter/skills/contract-drafter/contract-drafter-dogfood-runx-stdout.json`
- Receipt ref: `runx:receipt:sha256:7dbd1986789598b8bb49fdd83c3fff2d9dfebc3bc91243aebbf3dc061013e256`

## What the skill does

- Reads a supplied contract template, supplied parties, and supplied deal terms.
- Refuses missing required template terms or missing party legal names.
- Renders a reviewable `draft_doc` only from the supplied inputs.
- Emits `deviations[]`, where every entry names `clause`, `baseline`, and `proposed_change`.
- Emits a gated `send_proposal` for a later `send-as` run.
- Never sends the draft and never starts a signature workflow.

## Verification performed

- `runx --version` returned `runx-cli 0.6.16`.
- Hosted registry harness previously passed 2/2 cases with zero assertion errors.
- Harness case `sealed-draft-with-visible-deviations` sealed and produced `draft_doc`, `deviations[]`, and `send_proposal`.
- Harness case `refused-missing-required-payment-term` refused the missing required term and produced no draft or proposal.
- `runx registry read iwannabefree00/contract-drafter@sha-8f6b4fdaeab7 --registry https://api.runx.ai --json` resolved the package metadata and digests.
- `runx add iwannabefree00/contract-drafter@sha-8f6b4fdaeab7 --registry https://api.runx.ai --json` succeeded in a clean install directory.
- Post-publish `runx skill` was executed against the remote registry ref and reached trusted registry provenance for `iwannabefree00/contract-drafter@sha-8f6b4fdaeab7`.
- The submitted dogfood receipt `sha256:7dbd1986789598b8bb49fdd83c3fff2d9dfebc3bc91243aebbf3dc061013e256` is the actual persisted runx-cli runtime receipt from that post-publish skill run; its subject is `harness` / `hrn_run_draft_5dc75c805aac_draft`.
- `runx verify --receipt contract-drafter-dogfood-receipt.json --json` returned `valid: true` with valid digest, valid content address, and valid Ed25519 signature using the public key in `contract-drafter-dogfood-public-key.json`.
- The raw runx stdout is included. It reports a Windows receipt-store directory sync/readability error after the receipt write; the persisted receipt and verify verdict are included so the runtime receipt can be independently checked.

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
  --receipt-dir .runx/receipts-registry-ref-ci-20260714 \
  --json
```

Verify the included dogfood receipt:

```bash
RUNX_RECEIPT_VERIFY_KID=agent-497c05-contract-drafter-dogfood \
RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64=<public_key_base64 from contract-drafter-dogfood-public-key.json> \
runx verify --receipt contract-drafter-dogfood-receipt.json --json
```

Expected skill result:

- Complete inputs produce `status: draft_ready`.
- The output includes `draft_doc`, `deviations[]`, and `send_proposal`.
- Missing a required term produces a refusal with no draft and no proposal.
- `send_proposal.status` is `gated_not_sent`, so a separate governed `send-as` run is required to send anything.

## Revision fix: runtime dogfood receipt

- Replaced the rejected package-subject CI observation receipt with `runx:receipt:sha256:7dbd1986789598b8bb49fdd83c3fff2d9dfebc3bc91243aebbf3dc061013e256`.
- The submitted receipt is now the runx-cli runtime receipt persisted by the post-publish `runx skill iwannabefree00/contract-drafter@sha-8f6b4fdaeab7` execution.
- The new receipt subject is `harness` / `hrn_run_draft_5dc75c805aac_draft`, which is the runtime receipt shape that was previously not submitted.
- `contract-drafter-dogfood-verify.json` records `valid=true`, `digest=valid`, `content_address=valid`, and `signature=valid` for the submitted receipt.
- The Windows receipt-store finalization error is not hidden: `contract-drafter-dogfood-runx-stdout.json` records it, while the persisted receipt file and verify verdict prove the receipt itself is valid.

# Frantic #34 Delivery Report: inbox-triage

## Package

- Registry ref: `hehee9/inbox-triage@sha-fe96ae7c876b`
- Public URL: https://runx.ai/x/hehee9/inbox-triage@sha-fe96ae7c876b
- Source URL: https://github.com/hehee9/runx-inbox-triage-skill/tree/fe96ae7c876b39d45eec21ccc32806c0af56708f
- PR: https://github.com/runxhq/runx/pull/113
- Package name: `inbox-triage`

## What the skill does

`inbox-triage` reads a bounded inbox packet, classifies messages, creates a triage queue, drafts one safe reply when policy allows it, and stops at a send-as approval proposal. It uses synthetic fixture data for evidence and does not connect to a private mailbox.

## Verification summary

- `runx --version`: `runx-cli 0.6.13`
- Local Docker/Linux harness: passed, 6 cases, 0 assertion errors
- Registry read: `runx registry read hehee9/inbox-triage --version sha-fe96ae7c876b --registry https://api.runx.ai --json` resolved the published package metadata and digests.
- Clean install: `runx add hehee9/inbox-triage@sha-fe96ae7c876b --registry https://api.runx.ai` succeeded.
- Dogfood run: `runx skill hehee9/inbox-triage@sha-fe96ae7c876b --registry https://api.runx.ai --json` produced a sealed receipt.
- Receipt verification: `runx verify --receipt dogfood-receipt.json --json` returned `valid: true` when supplied the matching public verification key for the local dogfood signer.

## Harness cases

- `inbox-triage-happy-path-drafts-gated-reply`
- `inbox-triage-stops-on-missing-sender`
- `inbox-triage-stops-on-missing-body`
- `inbox-triage-refuses-auto-send`
- `inbox-triage-ready-on-digest-only`
- `inbox-triage-stops-when-commitments-not-allowed`

## Dogfood result

The dogfood run classified `msg-001` as `needs_reply` and `time_sensitive`, classified `msg-002` as `no_reply` and `digest`, produced a draft for `msg-001`, and emitted `gated_send_proposal.requires_approval=true` with `status=proposed_not_sent`.

Receipt ref: `runx:receipt:sha256:360ca9fd983cd49b26487bf0f880b3c6daedef1f720fb116c0579ded00b26c87`

## Send-as composition

The skill produces a proposal containing the recipient, subject, body reference, approval gate, and reason. It never sends, schedules, archives, deletes, unsubscribes, or mutates messages. A send-as runner or human operator must verify the proposal and approve it before any outbound email can be sent.

## Evidence files

- `frantic-34-evidence.json`: delivery evidence packet
- `dogfood-verify.json`: receipt verification verdict
- `dogfood-run.json`: dogfood run output
- `dogfood-receipt.json`: sealed dogfood receipt
- `local-evidence.docker.json`: local harness and smoke summary
- `local-harness.docker.json`: harness output
- `local-smoke.json`: semantic runner assertions

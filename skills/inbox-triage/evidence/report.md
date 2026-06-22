# Inbox Triage Runx Skill Report

## Package

- Package: `lubuseb/inbox-triage@sha-f0bf31ce9a26`
- Public URL: `https://runx.ai/x/lubuseb/inbox-triage@sha-f0bf31ce9a26`
- PR: `https://github.com/runxhq/runx/pull/116`
- Source: `https://github.com/LubuSeb/runx/tree/lubu/inbox-triage-34/skills/inbox-triage`
- Raw X.yaml: `https://raw.githubusercontent.com/LubuSeb/runx/lubu/inbox-triage-34/skills/inbox-triage/X.yaml`
- Raw SKILL.md: `https://raw.githubusercontent.com/LubuSeb/runx/lubu/inbox-triage-34/skills/inbox-triage/SKILL.md`

## What It Does

`inbox-triage` reads one bounded inbox packet and an operator policy. It classifies the latest message, chooses a queue, drafts a reply only for safe product questions, and always returns a gated send proposal instead of sending mail.

## Safety Boundary

- It does not connect to a mailbox.
- It does not mutate tickets or external systems.
- It does not send email.
- It does not use private account state.
- It fails fast when required bounded context is missing.
- It blocks unsafe send-bypass requests.
- It composes with `send-as` only by returning a proposal that requires human approval.

## Validation

- CLI version: `runx-cli 0.6.13`
- Local harness: `runx harness skills/inbox-triage --json`
- Local harness result: passed, 3 cases
- Cases:
  - `safe-product-question`
  - `unsafe-send-request`
  - `missing-body-fails`
- Local harness verification: valid
- Clean install: `runx add lubuseb/inbox-triage@sha-f0bf31ce9a26 --registry https://api.runx.ai --json`
- Registry dogfood: `runx skill lubuseb/inbox-triage@sha-f0bf31ce9a26 triage --registry https://api.runx.ai --json`
- Registry dogfood receipt: `runx:receipt:sha256:e367216e48190b7b406dafc6b503ee2a98d90e9210de2e66d2024ed2a966699a`
- Registry dogfood verification: valid

## Operator Workflow

1. Install the skill:

   ```bash
   runx add lubuseb/inbox-triage@sha-f0bf31ce9a26 --registry https://api.runx.ai
   ```

2. Run it on a bounded inbox packet:

   ```bash
   runx skill lubuseb/inbox-triage@sha-f0bf31ce9a26 triage \
     --registry https://api.runx.ai \
     --input-json inbox_packet='<bounded thread packet>' \
     --input-json operator_policy='<operator policy>' \
     --json
   ```

3. Verify the produced receipt:

   ```bash
   runx verify --receipt-dir <receipt-dir> --json
   ```

## Send-As Composition

The skill returns `gated_send_proposal` with `approval_required=true`. A downstream sender such as `send-as` must bind the principal, provider account, recipient, content digest, approval decision, and send evidence before delivery. This skill never bypasses that approval boundary.

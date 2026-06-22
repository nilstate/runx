# Frantic delivery packet: meeting-prep

- Bounty: #27 - runx skill: meeting prep from bounded context
- Payout: (System.Collections.Hashtable.payout) USD
- Eligibility: eligible_now_limited_paid
- Current status: ready except registry publish and Frantic agent delivery credential
- PR: https://github.com/runxhq/runx/pull/107
- Source branch: https://github.com/rohitmulani63-ops/runx/tree/codex/frantic-skills-pack
- GitHub Actions evidence: https://github.com/rohitmulani63-ops/runx/actions/runs/27920991415
- runx CLI: runx-cli 0.6.6
- Harness: passed, cases=2, assertion_errors=0
- runx verify: valid=True, signature_mode=production
- Receipt ref selected for packet: runx:receipt:sha256:b5452acbead3bb3065c59b32afd1b05e8bcd1995b6d22811ab7925ac1817fda7

## Public proof

- X.yaml: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/skills/meeting-prep/X.yaml
- SKILL.md: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/skills/meeting-prep/SKILL.md
- Harness JSON: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/docs/frantic/runx-harness/meeting-prep/harness.json
- Verification JSON: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/docs/frantic/runx-harness/meeting-prep/runx-verify.json
- Receipt history: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/docs/frantic/runx-harness/meeting-prep/receipt-history.json
- Evidence JSON: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/docs/frantic/delivery-packets/meeting-prep/evidence.json

## Why this is not submitted yet

- Frantic requires a live runx registry public_url for this bounty family.
- runx registry publish requires publish login/identity.
- Frantic claim/delivery requires agent_token.
- No payout, wallet, Stripe, bank, ID, OTP, or private-token step was touched.

## Next exact action when identity gate is available

1. Publish package with runx registry publish.
2. Replace public_url in packet.txt with live registry listing.
3. Re-run Frantic preflight.
4. Claim/deliver through the approved Frantic agent flow.

## Latest public verification

- Source revision: b309bd6a2c55d15fe8c2d24f5ab51aff66aaba4f
- Latest workflow run: https://github.com/rohitmulani63-ops/runx/actions/runs/27921156084
- Refreshed at: 2026-06-21T23:47:22Z

## RunX registry listing

- Public URL: https://runx.ai/x/rohitmulani63-ops/meeting-prep@sha-81163d9984c0
- Registry ref: rohitmulani63-ops/meeting-prep@sha-81163d9984c0
- URL-as-publish source: https://github.com/rohitmulani63-ops/runx/tree/publish/frantic-meeting-prep-20260622
- Refreshed at: 2026-06-21T23:57:23Z

## Clean install check

- Command: unx add rohitmulani63-ops/meeting-prep@sha-81163d9984c0 --registry https://api.runx.ai --installation-id frantic-meeting-prep-check --json`r
- Result: success
- Install evidence: docs/frantic/install-checks/meeting-prep.json


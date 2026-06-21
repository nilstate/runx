# Frantic delivery packet: least-privilege-plan

- Bounty: #37 - runx skill: least-privilege grant plan
- Payout: (System.Collections.Hashtable.payout) USD
- Eligibility: locked_until_one_successful_paid_bounty
- Current status: ready except registry publish and Frantic agent delivery credential
- PR: https://github.com/runxhq/runx/pull/107
- Source branch: https://github.com/rohitmulani63-ops/runx/tree/codex/frantic-skills-pack
- GitHub Actions evidence: https://github.com/rohitmulani63-ops/runx/actions/runs/27920991415
- runx CLI: runx-cli 0.6.6
- Harness: passed, cases=2, assertion_errors=0
- runx verify: valid=True, signature_mode=production
- Receipt ref selected for packet: runx:receipt:sha256:3164f29586193e5e6387a0adacadd35fc815d4020404fd132b7933d400ad9771

## Public proof

- X.yaml: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/skills/least-privilege-plan/X.yaml
- SKILL.md: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/skills/least-privilege-plan/SKILL.md
- Harness JSON: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/docs/frantic/runx-harness/least-privilege-plan/harness.json
- Verification JSON: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/docs/frantic/runx-harness/least-privilege-plan/runx-verify.json
- Receipt history: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/docs/frantic/runx-harness/least-privilege-plan/receipt-history.json
- Evidence JSON: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/docs/frantic/delivery-packets/least-privilege-plan/evidence.json

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

# Frantic delivery packet: dependency-advisory-graph

- Bounty: #29 - runx skill: dependency advisory graph
- Payout: (System.Collections.Hashtable.payout) USD
- Eligibility: locked_until_one_successful_paid_bounty
- Current status: ready except registry publish and Frantic agent delivery credential
- PR: https://github.com/runxhq/runx/pull/107
- Source branch: https://github.com/rohitmulani63-ops/runx/tree/codex/frantic-skills-pack
- GitHub Actions evidence: https://github.com/rohitmulani63-ops/runx/actions/runs/27920991415
- runx CLI: runx-cli 0.6.6
- Harness: passed, cases=2, assertion_errors=0
- runx verify: valid=True, signature_mode=production
- Receipt ref selected for packet: runx:receipt:sha256:cd162229fef38b6ecfd7122097029994265a569e5101c1c52fa1898d6f67b3d7

## Public proof

- X.yaml: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/skills/dependency-advisory-graph/X.yaml
- SKILL.md: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/skills/dependency-advisory-graph/SKILL.md
- Harness JSON: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/docs/frantic/runx-harness/dependency-advisory-graph/harness.json
- Verification JSON: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/docs/frantic/runx-harness/dependency-advisory-graph/runx-verify.json
- Receipt history: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/docs/frantic/runx-harness/dependency-advisory-graph/receipt-history.json
- Evidence JSON: https://raw.githubusercontent.com/rohitmulani63-ops/runx/codex/frantic-skills-pack/docs/frantic/delivery-packets/dependency-advisory-graph/evidence.json

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

- Public URL: https://runx.ai/x/rohitmulani63-ops/dependency-advisory-graph@sha-f31eb820ba53
- Registry ref: rohitmulani63-ops/dependency-advisory-graph@sha-f31eb820ba53
- URL-as-publish source: https://github.com/rohitmulani63-ops/runx/tree/publish/frantic-five-pack-20260622
- Refreshed at: 2026-06-22T00:04:14Z

## Clean install check

- Command: `runx add rohitmulani63-ops/dependency-advisory-graph@sha-f31eb820ba53 --registry https://api.runx.ai --installation-id frantic-dependency-advisory-graph-check --json`
- Result: success
- Install evidence: docs/frantic/install-checks/dependency-advisory-graph.json


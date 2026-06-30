# spam-risk-reviewer Frantic #62 report

## Summary

spam-risk-reviewer is a read-only pre-send judgment skill. It reviews a campaign draft, list metadata, sender authentication posture, and policy thresholds, then emits runx.send_risk_verdict.v1.

It never sends mail, never mints authority, never emits an operational proposal, and never reads live domain state. A later governed send-as run can read the verdict into preflight; any non-clear verdict blocks the send and routes to human approval.

## Published package

- Package: rohitmulani63-ops/spam-risk-reviewer@sha-659b432d158c
- Public URL: https://runx.ai/x/rohitmulani63-ops/spam-risk-reviewer@sha-659b432d158c
- PR: https://github.com/runxhq/runx/pull/188

## Validation

- node skills/spam-risk-reviewer/run.mjs low-risk input: risk_level=pass, preflight_clear=true
- node skills/spam-risk-reviewer/run.mjs high-risk input: risk_level=hold, preflight_clear=false, escalation=needs_human
- runx harness ./skills/spam-risk-reviewer in Docker Linux with runx-cli 0.6.14: 3 cases passed, 0 assertion errors
- runx registry publish ./skills/spam-risk-reviewer/SKILL.md --registry https://api.runx.ai: published rohitmulani63-ops/spam-risk-reviewer@sha-659b432d158c
- Post-publish dogfood run sealed runx:receipt:sha256:61f72d0b1ca4a66a5627933e5d3fd0437648c54d82f2b3ea55b4407af3f4c56e
- runx verify on the dogfood receipt returned valid: true

## Harness cases

- low-risk-verified-sender: SPF, DKIM, DMARC, warm-up, list freshness, bounce, complaint, and content terms all pass, so send-as preflight can clear.
- high-risk-incomplete-auth: DKIM fails, bounce and complaint rates exceed policy, list is stale, sender warm-up is too low, and risky terms are present, so send-as preflight is blocked.
- missing-policy-stop: missing policy input produces a stop/error receipt instead of inventing thresholds.

## Dogfood result

The dogfood input used a clean opted-in customer update, healthy list metrics, passing SPF/DKIM/DMARC, and policy thresholds. The published registry package returned risk_level=pass, preflight_clear=true, no blockers, and a sealed receipt.

## Why this satisfies the bounty

- Exact package name is spam-risk-reviewer.
- Typed inputs are campaign draft, list metadata, sender authentication posture, and policy.
- Typed output is send_risk_verdict with risk level, preflight clear flag, blockers, and evidence summary.
- The skill refuses missing policy evidence instead of inventing risk signals.
- The public_send effect remains owned by a later governed send-as run, not this skill.

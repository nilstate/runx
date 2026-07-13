# CSAT Recovery Delivery Report

- Published `q10283245/csat-recovery@0.1.0` with `runx-cli 0.7.0` through the GitHub-authenticated hosted registry flow.
- Public adoption page: <https://runx.ai/x/q10283245/csat-recovery@0.1.0>; public review PR: <https://github.com/runxhq/runx/pull/308>.
- Source revision `fa9eb38511c8425abef95e62eaf5054d4d3cf6bf` contains `X.yaml`, `SKILL.md`, fixtures, harness evidence, and the dogfood answer packet.
- Local and clean installed-package harnesses passed both inline cases with no assertion errors.
- The linked-charge case chose `credit`, emitted a 1,200 minor-unit USD ceiling bound to the original receipt, and retained only the declared billing-error scope.
- The unlinked-credit case emitted no ceiling and blocked at `needs_agent` because the escalation sub-step deliberately has no caller answer.
- The real post-publish dogfood run used a redacted duplicate-charge detractor, a 5,000 minor-unit monthly limit, 800 prior recovery, and a linked charge with 1,800 refundable minor units.
- The dogfood decision left 3,000 minor units of monthly recovery balance and produced the policy-derived content digest `sha256:dogfood-credit-apology-v1`.
- Receipt `runx:receipt:sha256:35e8871d999fd0f5ba21fe9e5b14feb3e4783f2e9d5d53d21fa7b09de0c25f6e` passed digest, content-address, and Ed25519 signature verification.
- The graph performs no refund, send, mint, reservation, or settlement. C3 may attenuate the ceiling but cannot widen it; the apology requires a separate governed send-as run.
- Durable state composes the pinned `registry:runx/data-store@0.1.2` projection contract keyed by customer id; the audit ledger is receipt-id-only.
- Install with `runx add q10283245/csat-recovery@0.1.0 --registry https://api.runx.ai`, run with typed JSON inputs, resume explicit agent/human requests, and verify the published receipt using the public key in `verification.json`.

## Public artifacts

- Raw profile: <https://raw.githubusercontent.com/q10283245/runx/fa9eb38511c8425abef95e62eaf5054d4d3cf6bf/skills/csat-recovery/X.yaml>
- Raw instructions: <https://raw.githubusercontent.com/q10283245/runx/fa9eb38511c8425abef95e62eaf5054d4d3cf6bf/skills/csat-recovery/SKILL.md>
- Registry metadata: `runx registry read q10283245/csat-recovery@0.1.0 --registry https://api.runx.ai --json`

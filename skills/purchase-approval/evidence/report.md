# Purchase Approval Delivery Report

- Published `q10283245/purchase-approval@0.1.0` with `runx-cli 0.7.0`, above the required 0.6.14 floor, through the GitHub-authenticated hosted registry flow.
- Public adoption page: <https://runx.ai/x/q10283245/purchase-approval@0.1.0>. Public review PR: <https://github.com/runxhq/runx/pull/307>.
- Source revision `1d5bff5e5865650aec2eba950e20ed36bc1443a9` contains `X.yaml`, `SKILL.md`, fixtures, harness evidence, and the dogfood answer packet used to resume the governed run.
- Local harness passed both inline cases before publish. A clean registry install passed, and replaying the installed `0.1.0` profile passed both cases after publish.
- `purchase-approval-in-policy-within-budget` sealed with `decision.approved=true` and one bounded 480 USD ceiling for `Acme Hosting` and `purchase:hosting`.
- `purchase-approval-over-budget-needs-human` stopped at `needs_agent` because 2,800 USD exceeded both the 1,500 USD single-purchase cap and 1,200 USD remaining budget. It intentionally omits caller answers and emits no ceiling.
- The post-publish dogfood run used a real 480 USD hosting-renewal request against a 2,200 USD remaining budget. It sealed receipt `runx:receipt:sha256:3d3eced86dc12c493310ec6544d5b07100e6d68f28c0381f0355f2904910dd8a`.
- `runx verify --receipt ... --json` returned `valid: true`, with valid digest, content address, and Ed25519 signature. The public verification packet includes the non-secret verification key.
- The skill makes a bounded judgment only. It does not mint, reserve, settle, or move funds. A downstream C3 accepting runner may attenuate the emitted ceiling further but cannot widen it.
- A new user can install with `runx add q10283245/purchase-approval@0.1.0 --registry https://api.runx.ai`, run it with typed JSON inputs using `runx skill q10283245/purchase-approval@0.1.0 --json`, resume any explicit agent/human request, then verify the emitted receipt with the documented public key.

## Public artifacts

- Registry metadata: `runx registry read q10283245/purchase-approval@0.1.0 --registry https://api.runx.ai --json`
- Raw profile: <https://raw.githubusercontent.com/q10283245/runx/1d5bff5e5865650aec2eba950e20ed36bc1443a9/skills/purchase-approval/X.yaml>
- Raw instructions: <https://raw.githubusercontent.com/q10283245/runx/1d5bff5e5865650aec2eba950e20ed36bc1443a9/skills/purchase-approval/SKILL.md>
- Evidence packet: `skills/purchase-approval/evidence/evidence.json`
- Verification packet: `skills/purchase-approval/evidence/verification.json`
- Receipt: `skills/purchase-approval/evidence/receipt.json`

# Purchase Approval 0.2.0 Delivery Report

- Published `q10283245/purchase-approval@0.2.0` with `runx-cli 0.7.1` through the GitHub-authenticated hosted registry flow. Package digest: `68d7540b7bc3e141e75c6043f9025afce30dc5322b801dea4c20a2c94e25e6e0`; profile digest: `98b7724ee7b368a8e50162879a39446ace0a516401010810d3cdff33b92c611b`.
- Public adoption page: <https://runx.ai/x/q10283245/purchase-approval@0.2.0>. Review PR: <https://github.com/runxhq/runx/pull/307>.
- The authoritative source and all final delivery evidence are pinned by the immutable `purchase-approval-v0.2.0-registry-evidence` tag.

## Operational correction

The 0.1.0 graph accepted `current_budget_balance` as caller input and emitted a ceiling that no shipped rail consumed. Version 0.2.0 removes that input. It now reads `budget_events` through `data.source/read_projection`, keyed by `cost_center` and `budget_period`, and uses the returned balance and stream version as authority.

After the decision and explicit human gate, the graph appends `purchase.committed` with `expected_version` taken from that read. Only a successful compare-and-set reaches the embedded `mock-charge` runner. That runner executes price, challenge, verification, seal, and modeled forward under the exact `AttenuationRequest` supplied as `parent_payment_authority`. The rail is deterministic and moves no money.

## Published-package proof

Runx's hosted registry reran the 0.2.0 harness from the published package material at `2026-07-14T06:00:18.344Z`. `purchase-approval-budgeted-mock-charge` sealed, while `purchase-approval-over-budget-blocks-charge` stopped at `needs_agent`. The hosted result passed 2/2 checks, failed 0, and bound receipt `runx:receipt:sha256:cbe0ccceca1e767f24e7ec5e74acf28b4a970bdb09b417859a71d4f6574ba6bf` to the published package and profile digests. Public evidence: <https://runx.ai/x/q10283245/purchase-approval@0.2.0#harness>.

## Full published-package dogfood observations

GitHub Actions run <https://github.com/q10283245/runx/actions/runs/29310978965> acquired `q10283245/purchase-approval@0.2.0` directly from the remote Runx registry, installed it into a clean directory, reran both harness cases, and invoked the owner/version reference with the `purchase-approval-with-budget-fixture` runner. The full run used a 480 USD Acme Hosting request, 1000 USD single-purchase cap, exact `purchase:hosting` scope, and authoritative 2200 USD cost-center projection at version 1.

The decision approved the request for those exact bounds and emitted a 480 USD ceiling for Acme Hosting only. Human confirmation preceded all mutation. CAS then committed `budget_events:engineering-platform-registry-dogfood:2`, advanced version 1 to 2, and readback showed `committed_spend=480` and `current_budget_balance=1720`.

The embedded mock rail priced 480 USD, issued a receipt-before-forward challenge, verified the `mock` settlement family, sealed `receipt:charge:mock:acme-hosting-2026-07`, and modeled the hosting result forward. It used no wallet, provider secret, or real payment and moved no funds.

Root receipt `runx:receipt:sha256:65deaf244813e08fa5071ecae3ad5fdbc22916782c2316cd12276edf4a12bcbc` passed digest, content-address, and production Ed25519 signature verification. The verification packet includes the non-secret public verification key and records root verification only; child receipt refs remain in `receipt.json`.

The negative fixture requests 2800 USD against a stored 1200 USD balance and 1500 USD cap. With no agent resolution, it stops at `needs_agent` before human approval, budget append, or mock charge. No ceiling is consumable and no spend path fires.

## Public artifacts

- Source: <https://github.com/q10283245/runx/tree/purchase-approval-v0.2.0-registry-evidence/skills/purchase-approval>
- Raw profile: <https://raw.githubusercontent.com/q10283245/runx/purchase-approval-v0.2.0-registry-evidence/skills/purchase-approval/X.yaml>
- Raw instructions: <https://raw.githubusercontent.com/q10283245/runx/purchase-approval-v0.2.0-registry-evidence/skills/purchase-approval/SKILL.md>
- Evidence JSON: <https://raw.githubusercontent.com/q10283245/runx/purchase-approval-v0.2.0-registry-evidence/skills/purchase-approval/evidence/evidence.json>
- Hosted harness packet: <https://raw.githubusercontent.com/q10283245/runx/purchase-approval-v0.2.0-registry-evidence/skills/purchase-approval/evidence/hosted-harness.json>
- Verification packet: <https://raw.githubusercontent.com/q10283245/runx/purchase-approval-v0.2.0-registry-evidence/skills/purchase-approval/evidence/verification.json>
- Receipt: <https://raw.githubusercontent.com/q10283245/runx/purchase-approval-v0.2.0-registry-evidence/skills/purchase-approval/evidence/receipt.json>

## Reproduce

- Install: `runx add q10283245/purchase-approval@0.2.0 --registry https://api.runx.ai`.
- Inspect metadata and digests: `runx registry read q10283245/purchase-approval@0.2.0 --registry https://api.runx.ai --json`.
- Run: `runx skill q10283245/purchase-approval@0.2.0 purchase-approval-with-budget-fixture --registry https://api.runx.ai --skip-operator-context --json` with the typed inputs recorded in `evidence.json`; resume the explicit agent and human requests with the recorded answer packet.
- Verify: set the public key and key id from `verification.json`, then run `runx verify --receipt receipt.json --json`. No private context, wallet, provider key, or real payment is required.

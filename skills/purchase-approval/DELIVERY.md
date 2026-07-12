# Delivery Runbook: purchase-approval (Frantic #109)

## Status

The package is published and all claim-free gates are complete:

- GitHub star: verified for `fablerlabs`.
- Upstream PR: https://github.com/runxhq/runx/pull/285
- Registry: `fablerlabs/purchase-approval@sha-56c91c6936e4`.
- Hosted harness: passed during registry publish.
- Clean install: passed.
- Post-publish dogfood: sealed.
- Receipt verification: valid with zero findings under the explicit
  local-development signature policy.

Do not claim until the final commit-pinned artifact URLs pass the Frantic board
preflight. The claim fuse has measured near 60 minutes on adjacent rows.

## Acceptance Matrix

| Requirement | Status | Evidence |
|---|---|---|
| runx CLI 0.6.14+ | passed | `runx-cli 0.7.0` |
| verified account stars `runxhq/runx` | passed | GitHub API HTTP 204 |
| exact package name and hosted publish | passed | `fablerlabs/purchase-approval@sha-56c91c6936e4` |
| public upstream PR with package and fixtures | passed | runxhq/runx#285 |
| local and hosted harness | passed | two cases, zero assertion errors |
| clean registry install | passed | runner `review` installed |
| post-publish dogfood and receipt | passed | `runx:receipt:sha256:d8b48bdf9970ea80ea212f12b8f66247b4f18f61b0ef98fc816da64c829af902` |
| typed inputs and bounded data ceiling | passed | `X.yaml`, dogfood receipt |
| blocking denial/human lane | passed | omitted-answer stop fixture yields `needs_agent` |
| public evidence/report/verification | pending final commit pin | `artifacts/` |

## Exact Package Checks

```bash
runx registry read fablerlabs/purchase-approval@sha-56c91c6936e4 \
  --registry https://api.runx.ai --json

runx add fablerlabs/purchase-approval@sha-56c91c6936e4 \
  --registry https://api.runx.ai --to <empty-dir> --json

runx harness skills/purchase-approval --json
```

The harness cases are:

- `purchase-approval-in-policy-ceiling`: sealed approval with one bounded USD 75
  `runx.attenuation_request.v1` ceiling carried as data.
- `purchase-approval-stop-over-budget-needs-agent`: omitted caller answers block
  at `needs_agent`; the refusal fixture names the USD 1100 budget overage, cap
  breach, and unlisted vendor; zero ceilings are emitted.

## Dogfood

Start the exact registry package with the four JSON objects in
`fixtures/in-policy-input.json`, approve the printed operator-context digest, then:

```bash
runx resume run_review_f48e576897f9 \
  fixtures/in-policy-answers.json --receipt-dir <dir> --json

runx verify --receipt artifacts/dogfood-receipt.json \
  --allow-local-development-signatures --json
```

The separate receipt-notary publish endpoint returned `Unauthorized` for the
purpose-scoped registry credential. No hosted-notary success is claimed. The signed
receipt and verification verdict are published directly in this PR.

## Final Delivery Bindings

After the final evidence commit is pushed, pin every raw artifact to that commit:

```text
public_url=https://runx.ai/x/fablerlabs/purchase-approval@sha-56c91c6936e4
source_url=https://github.com/fablerlabs/runx/tree/90a73a2e739a35c6f3783f7aa60424b7959fedaa/skills/purchase-approval
pr_url=https://github.com/runxhq/runx/pull/285
x_yaml=https://raw.githubusercontent.com/fablerlabs/runx/<final-commit>/skills/purchase-approval/X.yaml
skill_md=https://raw.githubusercontent.com/fablerlabs/runx/<final-commit>/skills/purchase-approval/SKILL.md
verification_json=https://raw.githubusercontent.com/fablerlabs/runx/<final-commit>/skills/purchase-approval/artifacts/verification.json
evidence_json=https://raw.githubusercontent.com/fablerlabs/runx/<final-commit>/skills/purchase-approval/artifacts/evidence.json
receipt_ref=runx:receipt:sha256:d8b48bdf9970ea80ea212f12b8f66247b4f18f61b0ef98fc816da64c829af902
report=https://raw.githubusercontent.com/fablerlabs/runx/<final-commit>/skills/purchase-approval/artifacts/report.md
```

Submit those nine exact `name=value` values to
`POST /v1/deliveries/preflight` with `bounty: 109`. Claim only after preflight
returns `ok: true`, zero errors, and all nine required bindings.

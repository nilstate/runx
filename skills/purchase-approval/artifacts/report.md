# purchase-approval report (Frantic #109)

`purchase-approval` is a runx graph skill that decides whether one typed purchase
request fits an explicit procurement policy, remaining budget, and requested scope
before any money moves. It emits one bounded spend ceiling as data only when the
request is approved.

## Published package

- CLI: `runx-cli 0.7.0`, above the required `0.6.14` minimum.
- Registry package: `fablerlabs/purchase-approval@sha-56c91c6936e4`.
- Public listing: https://runx.ai/x/fablerlabs/purchase-approval@sha-56c91c6936e4
- Source revision: https://github.com/fablerlabs/runx/tree/90a73a2e739a35c6f3783f7aa60424b7959fedaa/skills/purchase-approval
- Upstream PR: https://github.com/runxhq/runx/pull/285
- Registry digest: `sha256:2709d9122c7fa14205dce69acd61565d1416cfb676ab3e4043afabf4db1d1173`.
- Profile digest: `sha256:0bc1e14d1a9c19607f3272039bf084c6f1f8dfab198ae869f7192d9564edc1ed`.

## Verification

- Local harness passed exactly two cases with zero assertion errors.
- `purchase-approval-in-policy-ceiling` sealed with `decision.approved: true` and
  one USD 75 `runx.attenuation_request.v1` ceiling carried as data.
- `purchase-approval-stop-over-budget-needs-agent` omitted caller answers and
  stopped at `needs_agent`, with no ceiling available to a spend runner.
- Hosted registry publication returned `status: published`; the hosted harness passed.
- A clean `runx add` installed the exact published version and exposed runner `review`.
- The verified `fablerlabs` GitHub account stars `runxhq/runx` (API returned HTTP 204).

## Post-publish dogfood

The exact registry package was run with the public in-policy fixture. The start
blocked at `needs_agent`; resuming with `fixtures/in-policy-answers.json` sealed
receipt `runx:receipt:sha256:d8b48bdf9970ea80ea212f12b8f66247b4f18f61b0ef98fc816da64c829af902`.
The receipt contains the registry provenance and the single bounded ceiling.

`runx verify --allow-local-development-signatures` returned `valid: true`, valid
digest/content address/signature, and zero findings. The separate hosted receipt
notary rejected the purpose-scoped token as `Unauthorized`; no hosted-notary success
is claimed. The signed receipt and verification verdict are public in this PR at
`artifacts/dogfood-receipt.json` and `artifacts/dogfood-verify.json`.

## Decision and authority boundary

- Approved vendor: `Acme Corp`; amount USD 75; remaining budget USD 1000.
- Policy caps: USD 500 single-purchase maximum and USD 200 approval threshold.
- Requested scope cap: USD 100; emitted ceiling: USD 75.
- The skill never mints authority, reserves, settles, moves money, or emits a
  `runx.operational_proposal.v1`.
- A downstream C3 spend/refund accepting runner alone may mint, reserve, settle,
  and seal within the ceiling.
- A denial or blocked approval emits no ceiling, so the spend cannot fire.
- The refusal fixture names the USD 1100 budget overage, USD 1000 policy-cap
  overage, and unlisted vendor instead of inventing a policy exception.

## Install, run, verify

```bash
runx add fablerlabs/purchase-approval@sha-56c91c6936e4 --registry https://api.runx.ai

runx skill fablerlabs/purchase-approval@sha-56c91c6936e4 review \
  --registry https://api.runx.ai --json \
  --input-json purchase_request='<object>' \
  --input-json procurement_policy='<object>' \
  --input-json current_budget_balance='<object>' \
  --input-json requested_scope='<object>'

runx resume <run-id> fixtures/in-policy-answers.json --json
runx verify --receipt <receipt.json> --allow-local-development-signatures --json
```

No private context is required. The four input objects and resume answer are in
`fixtures/`, and the measured machine-readable results are in `artifacts/evidence.json`
and `artifacts/verification.json`.

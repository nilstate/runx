# purchase-approval

A runx **graph** skill: a `SKILL.md` contract and an `X.yaml` execution profile with
a single `agent-task` review step. No build step, no dependencies, no tools —
the judgment reads only its typed inputs.

It decides approve-in-full, scope-down, or deny on one purchase request *before* any
spend is committed, and on approval emits exactly one bounded
`runx.attenuation_request.v1` ceiling as data for a downstream C3 spend/refund runner
to consume. See `SKILL.md` for the contract and `DELIVERY.md` for the acceptance
matrix and test evidence.

## Develop

```bash
runx --version                # runx-cli 0.7.0 (>= 0.6.14 required)
runx skill inspect .          # resolves the 'review' graph runner
runx harness . --json         # 2 cases: one sealed, one needs_agent
```

Local runs seal with local-development receipts; `runx verify` on them needs
`--allow-local-development-signatures`. Publishing and hosted verification require
real authority.

## Dogfood (start → block → resume → verify)

```bash
F=fixtures/in-policy-input.json
runx skill . review --json \
  --input-json purchase_request="$(jq -c .purchase_request $F)" \
  --input-json procurement_policy="$(jq -c .procurement_policy $F)" \
  --input-json current_budget_balance="$(jq -c .current_budget_balance $F)" \
  --input-json requested_scope="$(jq -c .requested_scope $F)"
# blocks at needs_agent (re-run once with --approve-operator-context <digest>)
runx resume <run-id> fixtures/in-policy-answers.json --json   # seals with one ceiling
runx verify --receipt .runx/receipts/<id>.json --allow-local-development-signatures --json
```

Swap in `fixtures/over-budget-*.json` for the stop lane: it blocks at `needs_agent`
and, on resume, refuses with **zero** ceilings while naming the budget overage and the
unlisted vendor.

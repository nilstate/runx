# Bookkeeper verification report

Package: `lxx197818/bookkeeper@sha-1f8664035747`

Public registry URL: <https://runx.ai/x/lxx197818/bookkeeper@sha-1f8664035747>

## What the skill does

`bookkeeper` reads `transactions[]`, `chart_of_accounts`, and `prior_period`.
It categorizes each transaction to an existing GL account, flags anomalies, and
emits a read-only reconciliation artifact.

The skill does not post journals, does not mutate a ledger, does not touch money
rails, and never invents a GL account.

## Validation performed

- `runx --version`: `runx-cli 0.6.14`
- Local harness passed for:
  - `clean_transactions_reconcile`
  - `ambiguous_transactions_need_review`
- Registry publish succeeded for `lxx197818/bookkeeper@sha-1f8664035747`
- Post-publish dogfood receipt:
  - `runx:receipt:sha256:ee402887deb318e99f3a3560d2b0d60c93fb12e9d8ee8b146dd9e1e0818b806f`
- `runx verify` returned `valid: true`

## Required delivery URLs

- Acceptance URL coverage item `pr_url`: <https://github.com/runxhq/runx/pull/256>
- Acceptance URL coverage item `source_url`: <https://github.com/lxx197818/runx/tree/codex/frantic-bookkeeper-89/skills/bookkeeper>
- Acceptance URL coverage item `raw x_yaml URL`: <https://raw.githubusercontent.com/lxx197818/runx/codex/frantic-bookkeeper-89/skills/bookkeeper/X.yaml>
- Acceptance URL coverage item `raw skill_md URL`: <https://raw.githubusercontent.com/lxx197818/runx/codex/frantic-bookkeeper-89/skills/bookkeeper/SKILL.md>
- Acceptance URL coverage item `verification_json URL`: <https://raw.githubusercontent.com/lxx197818/runx/codex/frantic-bookkeeper-89/skills/bookkeeper/references/verification.json>

Machine-readable URL keys are also present in `evidence_json.delivery_urls`:

- `delivery_urls.pr_url`
- `delivery_urls.source_url`
- `delivery_urls.raw_x_yaml_url`
- `delivery_urls.raw_skill_md_url`
- `delivery_urls.verification_json_url`

## Dogfood observation

Input batch:

- Stripe payout customer invoices: 1250 USD
- AWS cloud hosting invoice: -210.45 USD

Result:

- `categorized.length`: 2
- `anomalies.length`: 0
- `reconciliation.matched`: 1039.55
- `reconciliation.unmatched`: 0
- `reconciliation.projected_cash_after_matched`: 6039.55
- `effects.ledger_mutation`: false
- `effects.journal_posted`: false
- `effects.money_rail`: false
- `effects.invented_gl_account`: false

## How to install and run

```bash
runx add lxx197818/bookkeeper@sha-1f8664035747 --registry https://api.runx.ai
runx skill lxx197818/bookkeeper@sha-1f8664035747 --registry https://api.runx.ai --json \
  --input-json transactions='[{"id":"txn_001","date":"2026-07-01","description":"Stripe payout customer invoices","amount":1250,"currency":"USD"}]' \
  --input-json chart_of_accounts='[{"code":"4000","name":"Revenue","keywords":["stripe","invoice","customer"]}]' \
  --input-json prior_period='{"ending_cash":5000,"currency":"USD"}'
```

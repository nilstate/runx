# Bookkeeper verification report

Package: `lxx197818/bookkeeper@sha-ab94c4b94f6a`

Public registry URL: <https://runx.ai/x/lxx197818/bookkeeper>

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
- Registry publish succeeded for `lxx197818/bookkeeper@sha-ab94c4b94f6a`
- Post-publish dogfood receipt:
  - `runx:receipt:sha256:428fcdc3bf182026d165803f0d20ab32155826e5bd03eebefb2f936f0e513e93`
- `runx verify` returned `valid: true`

## Dogfood observation

Input batch:

- Stripe payout customer invoices: 1250 USD
- AWS cloud hosting invoice: -210.45 USD
- Office supplies receipt: -48.2 USD

Result:

- `categorized.length`: 3
- `anomalies.length`: 0
- `reconciliation.matched`: 991.35
- `reconciliation.unmatched`: 0
- `reconciliation.projected_cash_after_matched`: 5991.35
- `effects.ledger_mutation`: false
- `effects.journal_posted`: false
- `effects.money_rail`: false
- `effects.invented_gl_account`: false

## How to install and run

```bash
runx add lxx197818/bookkeeper@sha-ab94c4b94f6a --registry https://api.runx.ai
runx skill lxx197818/bookkeeper@sha-ab94c4b94f6a --registry https://api.runx.ai --json \
  --input-json transactions='[{"id":"txn_001","date":"2026-07-01","description":"Stripe payout customer invoices","amount":1250,"currency":"USD"}]' \
  --input-json chart_of_accounts='[{"code":"4000","name":"Revenue","keywords":["stripe","invoice","customer"]}]' \
  --input-json prior_period='{"ending_cash":5000,"currency":"USD"}'
```

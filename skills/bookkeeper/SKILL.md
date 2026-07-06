---
name: bookkeeper
description: Categorize transaction lines against an existing chart of accounts and emit a read-only reconciliation artifact without booking ledger entries.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
    require_enforcement: false
inputs:
  transactions:
    type: json
    required: true
    description: transactions[]{id,date,description,amount,currency}
  chart_of_accounts:
    type: json
    required: true
    description: Existing GL accounts with code, name, and optional keywords.
  prior_period:
    type: json
    required: true
    description: prior_period{ending_cash,currency}
runx:
  category: finance
  input_resolution:
    required:
      - transactions
      - chart_of_accounts
      - prior_period
---

# Bookkeeper

`bookkeeper` turns transaction lines into a read-only reconciliation artifact.
It categorizes each transaction against an existing chart of accounts, flags
ambiguous or invalid lines as anomalies, and calculates matched/unmatched
reconciliation totals.

The skill does not post journals, does not mutate a live ledger, does not call a
money rail, and never invents a GL account. Every categorization references an
account that exists in `chart_of_accounts` and carries confidence plus a reason.

## Contract

Inputs:

- `transactions[]{id,date,description,amount,currency}`
- `chart_of_accounts[]{code,name,keywords}`
- `prior_period{ending_cash,currency}`

Output:

- `categorized[]`
- `anomalies[]`
- `reconciliation{matched, unmatched}`

## Behavior

- Keyword matches against the supplied chart produce high-confidence categories.
- Positive transactions prefer revenue-like accounts when keyword evidence is
  present.
- Negative transactions prefer expense-like accounts when keyword evidence is
  present.
- Missing required fields, currency mismatches, and ambiguous descriptions are
  anomalies.
- The skill emits a read-only `reconciliation_artifact`; it does not book
  anything.

## Verification

Local harness:

```bash
runx harness ./skills/bookkeeper
```

Example dogfood run:

```bash
runx skill ./skills/bookkeeper --json \
  --input-json transactions='[{"id":"txn_001","date":"2026-07-01","description":"Stripe payout customer invoices","amount":1250,"currency":"USD"}]' \
  --input-json chart_of_accounts='[{"code":"4000","name":"Revenue","keywords":["stripe","invoice","customer"]}]' \
  --input-json prior_period='{"ending_cash":5000,"currency":"USD"}'
```
